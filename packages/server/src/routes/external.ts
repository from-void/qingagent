import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type {
  AnnotationGroup,
  BridgeFrame,
  ChatMessage,
  Command,
  ContentDocState,
  DocSuggestion,
  FolderSourceRecord,
  MessagePart,
  ReviewOutcome,
} from "@qingagent/contract-ts";
import { commandSchema } from "@qingagent/contract-ts/schemas";
import type {
  ExternalAnnotation,
  ExternalBridgeFrame,
  ExternalErrorCode,
  ExternalReviewCommitRequest,
  ExternalReviewDiff,
  ExternalReviewPatchDetail,
  ExternalReviewPatchSummary,
  ExternalReviewVerdictRequest,
} from "../../../contract-ts/src/ExternalApi";
import {
  deriveActiveOverlay,
  deriveAgentBusy,
  deriveContentState,
  documentRepo,
  QINGAGENT_RESOURCE_ID,
} from "@qingagent/core";
import { markdownToPm, normalizePmDoc, pmToMarkdown } from "@qingagent/pm-schema";
import crypto from "node:crypto";
import { getExternalInstancePublicInfo } from "../lib/externalInstance";
import { EXTERNAL_NEXT_STEP, externalError } from "../lib/externalError";
import { resolveRequestModelOverrides } from "../modelOverridesProvider";
import { getOrRestoreSession, sessionManager } from "../gateway/bridgeHandler";
import { loadSessionFromThread } from "../gateway/bridgeCore";
import { getOrRestoreSessionReadOnly } from "../gateway/sessionLifecycle";
import type { FrameLogReadResult, LoggedFrame } from "../gateway/frameLog";
import type { Material } from "@qingagent/core";
import { SessionActorQueueFullError } from "../gateway/sessionActor";
import { BoundedSsePump } from "../lib/boundedSsePump";
import { requestClientAddress, sseAdmission } from "../lib/sseAdmission";

export const externalRoutes = new Hono();

type ExternalClient = "claudecode" | "codex" | "agent";

const DEFAULT_MATERIAL_TEXT_MAX_BYTES = 200_000;
const DEFAULT_SESSIONS_LIMIT = 100;
const MAX_SESSIONS_LIMIT = 500;
const READ_RATE_LIMIT_PER_SECOND = 5;
const WRITE_RATE_LIMIT_PER_SECOND = 20;

const rateBuckets = new Map<string, { windowStart: number; count: number }>();

externalRoutes.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const limited = rateLimit(c);
    if (limited) return limited;
  }
  await next();
});

externalRoutes.get("/health", (c) => {
  const startedAt = Date.now();
  // 不限流:health 是 CLI 每条命令的发现心跳(discoverInstance 每次都打),
  // 限流会把连续命令误判成 NO_INSTANCE。限流只留给 doc read(PRD 意图:防高频拉取失控循环)。
  const info = getExternalInstancePublicInfo();
  externalLog("health", { ms: elapsed(startedAt), result: "ok" });
  return c.json({
    ok: true,
    version: info?.version ?? "0.0.0",
    pid: info?.pid ?? process.pid,
    startedAt: info?.startedAt ?? new Date().toISOString(),
  });
});

externalRoutes.get("/sessions", async (c) => {
  const startedAt = Date.now();
  const limit = clampedQueryInteger(c.req.query("limit"), DEFAULT_SESSIONS_LIMIT, 1, MAX_SESSIONS_LIMIT);
  const offset = clampedQueryInteger(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const { rows, total } = await documentRepo.list({
    resourceId: QINGAGENT_RESOURCE_ID,
    perPage: limit,
    offset,
  });
  const sessions: Array<{ id: string; title: string; state: ContentDocState["kind"]; updatedAt: string }> = [];
  for (const row of rows) {
    const session = await getOrRestoreSessionReadOnly(row.id);
    if (!session) continue;
    sessions.push({
      id: row.id,
      title: session.title || "未命名草稿",
      state: deriveContentState(session).kind,
      updatedAt: row.updatedAt,
    });
  }
  const memoryOnlySessions: Array<{
    id: string;
    title: string;
    state: ContentDocState["kind"];
    updatedAt: string;
  }> = [];
  const memorySessionIds = sessionManager.listSessionIds(50);
  // 当前页之外的真实落盘会话也不能作为内存会话重复出现；但仅有 documents
  // 孤儿行不算落盘列表会话，必须经同一条 thread 恢复路径确认。
  const persistedSessionIds = new Set(sessions.map((session) => session.id));
  const unresolvedMemoryIds = memorySessionIds.filter(
    (sessionId) => !persistedSessionIds.has(sessionId),
  );
  if (unresolvedMemoryIds.length > 0 && rows.length < total) {
    const { rows: allRows } = await documentRepo.list({
      resourceId: QINGAGENT_RESOURCE_ID,
      perPage: total,
      offset: 0,
    });
    const unresolvedMemoryIdSet = new Set(unresolvedMemoryIds);
    const offPageDocumentIds = new Set(
      allRows
        .map((row) => row.id)
        .filter((sessionId) =>
          unresolvedMemoryIdSet.has(sessionId) && !persistedSessionIds.has(sessionId)
        ),
    );
    for (const sessionId of offPageDocumentIds) {
      if (await loadSessionFromThread(sessionId, { mode: "snapshot" })) {
        persistedSessionIds.add(sessionId);
      }
    }
  }
  for (const sessionId of memorySessionIds) {
    if (persistedSessionIds.has(sessionId)) continue;
    const session = await getOrRestoreSessionReadOnly(sessionId);
    if (!session) continue;
    memoryOnlySessions.push({
      id: sessionId,
      title: session.title || "未命名草稿",
      state: deriveContentState(session).kind,
      updatedAt: new Date().toISOString(),
    });
  }
  const memoryOffset = Math.max(0, offset - total);
  const memoryPage = memoryOnlySessions.slice(
    memoryOffset,
    memoryOffset + Math.max(0, limit - rows.length),
  );
  sessions.push(...memoryPage);
  const mergedTotal = total + memoryOnlySessions.length;
  const hasMore = offset + rows.length + memoryPage.length < mergedTotal;
  externalLog("sessions", {
    ms: elapsed(startedAt),
    result: "ok",
    count: sessions.length,
    total: mergedTotal,
    hasMore,
  });
  return c.json({
    sessions,
    total: mergedTotal,
    hasMore,
  });
});

externalRoutes.post("/sessions", async (c) => {
  const startedAt = Date.now();
  const sessionId = crypto.randomUUID();
  const command: Command = {
    kind: "startSession",
    data: { mode: { kind: "new", data: { template: null, sessionId } } },
  };
  // 外部调用无浏览器 header,模型 key 取 app 全局设置(global-db)+env 兜底,与桌面 UI 同源。
  const modelOverrides = await resolveRequestModelOverrides({});
  let frames: LoggedFrame[];
  try {
    frames = await sessionManager.submit(sessionId, { command, origin: "external", modelOverrides });
  } catch (error) {
    if (error instanceof SessionActorQueueFullError) {
      return externalError(c, 429, "RATE_LIMITED", "会话命令队列已满");
    }
    throw error;
  }
  await saveEmptySessionDocument(sessionId).catch((error) => {
    console.warn("[external] evt=sessions result=empty_shadow_failed", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  externalLog("sessions", { sessionId, ms: elapsed(startedAt), result: "created" });
  return c.json({
    sessionId,
    seq: maxSeq(frames),
  });
});

externalRoutes.get("/sessions/:id/doc", async (c) => {
  const startedAt = Date.now();
  const limited = rateLimit(c);
  if (limited) {
    externalLog("read", { sessionId: c.req.param("id"), ms: elapsed(startedAt), result: "rejected:RATE_LIMITED" });
    return limited;
  }
  const sessionId = c.req.param("id");
  const session = await getOrRestoreSessionReadOnly(sessionId);
  if (!session) {
    externalLog("read", { sessionId, ms: elapsed(startedAt), result: "rejected:SESSION_NOT_FOUND" });
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
  const state = deriveContentState(session);
  const markdown = session.doc ? pmToMarkdown(session.doc) : "";
  externalLog("read", { sessionId, ms: elapsed(startedAt), result: "ok" });
  return c.json({
    sessionId,
    docVersion: session.docVersion,
    state: state.kind,
    agentBusy: deriveAgentBusy(session),
    markdown,
    ...(c.req.query("lines") === "1" ? { markdownWithLineNumbers: withLineNumbers(markdown) } : {}),
  });
});

externalRoutes.get("/sessions/:id/review", async (c) => {
  const startedAt = Date.now();
  const limited = rateLimit(c);
  if (limited) {
    externalLog("review_list", {
      sessionId: c.req.param("id"),
      ms: elapsed(startedAt),
      result: "rejected:RATE_LIMITED",
    });
    return limited;
  }
  const sessionId = c.req.param("id");
  const session = await getOrRestoreSessionReadOnly(sessionId);
  if (!session) {
    externalLog("review_list", {
      sessionId,
      ms: elapsed(startedAt),
      result: "rejected:SESSION_NOT_FOUND",
    });
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
  const patches = [...session.suggestions.values()].map((record) =>
    reviewPatchSummary(record.suggestion)
  );
  const annotations = session.annotationGroups.map(annotationForExternal);
  externalLog("review_list", {
    sessionId,
    ms: elapsed(startedAt),
    result: "ok",
    patches: patches.length,
    annotations: annotations.length,
  });
  return c.json({
    sessionId,
    docVersion: session.docVersion,
    state: deriveContentState(session).kind,
    agentBusy: deriveAgentBusy(session),
    patches,
    annotations,
  });
});

externalRoutes.get("/sessions/:id/review/patches/:patchId", async (c) => {
  const startedAt = Date.now();
  const limited = rateLimit(c);
  if (limited) return limited;
  const sessionId = c.req.param("id");
  const session = await getOrRestoreSessionReadOnly(sessionId);
  if (!session) {
    externalLog("review_show", {
      sessionId,
      ms: elapsed(startedAt),
      result: "rejected:SESSION_NOT_FOUND",
    });
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
  const record = session.suggestions.get(c.req.param("patchId"));
  if (!record) {
    externalLog("review_show", {
      sessionId,
      ms: elapsed(startedAt),
      result: "rejected:NOT_FOUND",
    });
    return externalError(
      c,
      404,
      "NOT_FOUND",
      "待审修改不存在",
      "用 `qa review list -s <id>` 重读待审修改列表",
    );
  }
  externalLog("review_show", {
    sessionId,
    ms: elapsed(startedAt),
    result: "ok",
  });
  return c.json({ sessionId, patch: reviewPatchDetail(record.suggestion) });
});

externalRoutes.get("/sessions/:id/review/annotations/:annotationId", async (c) => {
  const startedAt = Date.now();
  const limited = rateLimit(c);
  if (limited) return limited;
  const sessionId = c.req.param("id");
  const session = await getOrRestoreSessionReadOnly(sessionId);
  if (!session) {
    externalLog("annotation_show", {
      sessionId,
      ms: elapsed(startedAt),
      result: "rejected:SESSION_NOT_FOUND",
    });
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
  const annotation = session.annotationGroups.find(
    (group) => group.id === c.req.param("annotationId"),
  );
  if (!annotation) {
    externalLog("annotation_show", {
      sessionId,
      ms: elapsed(startedAt),
      result: "rejected:NOT_FOUND",
    });
    return externalError(
      c,
      404,
      "NOT_FOUND",
      "批注不存在",
      "用 `qa review list -s <id>` 重读批注列表",
    );
  }
  externalLog("annotation_show", {
    sessionId,
    ms: elapsed(startedAt),
    result: "ok",
  });
  return c.json({ sessionId, annotation: annotationForExternal(annotation) });
});

externalRoutes.post("/sessions/:id/review/verdicts", async (c) => {
  const startedAt = Date.now();
  const sessionId = c.req.param("id");
  const body = await c.req.json().catch(() => null) as Partial<ExternalReviewVerdictRequest> | null;
  if (
    !body ||
    !isDocumentVersion(body.expectedDocVersion) ||
    typeof body.patchId !== "string" ||
    body.patchId.length === 0 ||
    (body.verdict !== "accepted" && body.verdict !== "rejected")
  ) {
    externalLog("review_verdict", {
      sessionId,
      ms: elapsed(startedAt),
      result: "rejected:VALIDATION",
    });
    return externalError(c, 400, "VALIDATION", "expectedDocVersion、patchId、verdict 不合法");
  }
  const session = await getOrRestoreSession(sessionId);
  if (!session) return externalError(c, 404, "SESSION_NOT_FOUND");
  if (deriveAgentBusy(session)) return externalError(c, 409, "AGENT_BUSY");
  if (session.docVersion !== body.expectedDocVersion) {
    return reviewVersionConflict(c, body.expectedDocVersion, session.docVersion);
  }
  if (deriveContentState(session).kind !== "pendingReview" || session.suggestions.size === 0) {
    return externalError(
      c,
      409,
      "VALIDATION",
      "当前没有待审查修改",
      "用 `qa review list -s <id>` 对账；如已离开 pendingReview，直接继续后续工作",
    );
  }
  if (!session.suggestions.has(body.patchId)) {
    return externalError(
      c,
      404,
      "NOT_FOUND",
      "待审修改不存在",
      "用 `qa review list -s <id>` 重读待审修改列表",
    );
  }
  const command: Command = body.verdict === "accepted"
    ? { kind: "acceptPatch", data: { id: body.patchId } }
    : { kind: "rejectPatch", data: { id: body.patchId } };
  let frames: LoggedFrame[];
  try {
    frames = await sessionManager.submit(sessionId, {
      command,
      origin: "external",
      client: parseExternalClient(c.req.header("x-qa-client")),
      modelOverrides: await resolveRequestModelOverrides({}),
    });
  } catch (error) {
    if (error instanceof SessionActorQueueFullError) {
      return externalError(c, 429, "RATE_LIMITED", "会话命令队列已满");
    }
    throw error;
  }
  if (session.docVersion !== body.expectedDocVersion) {
    return reviewVersionConflict(c, body.expectedDocVersion, session.docVersion, maxSeq(frames));
  }
  const updated = session.suggestions.get(body.patchId);
  if (!updated || updated.suggestion.status !== body.verdict) {
    return externalError(
      c,
      409,
      "VALIDATION",
      "审查标记未保存，候选已保留",
      "用 `qa review show -s <id> --patch <patchId>` 对账后重试一次",
    );
  }
  const seq = maxSeq(frames);
  externalLog("review_verdict", {
    sessionId,
    ms: elapsed(startedAt),
    result: "marked",
    verdict: body.verdict,
  });
  return c.json({
    status: "marked" as const,
    docVersion: session.docVersion,
    patchIds: [body.patchId],
    verdict: body.verdict,
    reviewingCount: countReviewingPatches(session.suggestions.values()),
    seq,
  });
});

externalRoutes.post("/sessions/:id/review/commit", async (c) => {
  const startedAt = Date.now();
  const sessionId = c.req.param("id");
  const body = await c.req.json().catch(() => null) as Partial<ExternalReviewCommitRequest> | null;
  if (
    !body ||
    !isDocumentVersion(body.expectedDocVersion) ||
    (body.action !== "commit" &&
      body.action !== "accept_all" &&
      body.action !== "reject_all")
  ) {
    externalLog("review_commit", {
      sessionId,
      ms: elapsed(startedAt),
      result: "rejected:VALIDATION",
    });
    return externalError(c, 400, "VALIDATION", "expectedDocVersion 或 action 不合法");
  }
  const session = await getOrRestoreSession(sessionId);
  if (!session) return externalError(c, 404, "SESSION_NOT_FOUND");
  if (deriveAgentBusy(session)) return externalError(c, 409, "AGENT_BUSY");
  if (session.docVersion !== body.expectedDocVersion) {
    return reviewVersionConflict(c, body.expectedDocVersion, session.docVersion);
  }
  if (deriveContentState(session).kind !== "pendingReview" || session.suggestions.size === 0) {
    return externalError(
      c,
      409,
      "VALIDATION",
      "当前没有待审查修改",
      "用 `qa review list -s <id>` 对账；如已离开 pendingReview，直接继续后续工作",
    );
  }

  const suggestions = [...session.suggestions.values()].map((record) => record.suggestion);
  const decisions = reviewDecisions(suggestions, body.action);
  const outcome = reviewOutcome(suggestions, decisions.rejectedBatchIds);
  const command: Command = {
    kind: "commitReviewGroups",
    data: {
      acceptReviewBatchIds: decisions.acceptedBatchIds,
      rejectReviewBatchIds: decisions.rejectedBatchIds,
      keepPendingReviewBatchIds: [],
    },
  };
  const modelOverrides = await resolveRequestModelOverrides({});
  const client = parseExternalClient(c.req.header("x-qa-client"));
  let frames: LoggedFrame[];
  try {
    frames = await sessionManager.submit(sessionId, {
      command,
      origin: "external",
      client,
      modelOverrides,
    });
  } catch (error) {
    if (error instanceof SessionActorQueueFullError) {
      return externalError(c, 429, "RATE_LIMITED", "会话命令队列已满");
    }
    throw error;
  }
  const seq = maxSeq(frames);
  if (session.docVersion !== body.expectedDocVersion && !hasFrame(frames, "docCommitted")) {
    return reviewVersionConflict(c, body.expectedDocVersion, session.docVersion, seq);
  }
  if (session.suggestions.size > 0) {
    return externalError(
      c,
      409,
      "VALIDATION",
      "审查提交未完成，候选已保留",
      "用 `qa review list -s <id>` 查看冲突详情，重读文档后再决定",
    );
  }

  const outcomeQueued = outcome.rejectedCount > 0;
  if (outcomeQueued) {
    const outcomeCommand: Command = {
      kind: "submitReviewOutcome",
      data: { sessionId, outcome },
    };
    void sessionManager.submit(sessionId, {
      command: outcomeCommand,
      origin: "external",
      client,
      modelOverrides,
    }).catch((error) => {
      console.warn("[external] evt=review_outcome result=async_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  externalLog("review_commit", {
    sessionId,
    ms: elapsed(startedAt),
    result: "reviewed",
    accepted: outcome.acceptedCount,
    rejected: outcome.rejectedCount,
  });
  return c.json({
    status: "reviewed" as const,
    docVersion: session.docVersion,
    acceptedCount: outcome.acceptedCount,
    rejectedCount: outcome.rejectedCount,
    remainingCount: session.suggestions.size,
    outcomeQueued,
    outcome,
    seq,
  });
});

externalRoutes.post("/sessions/:id/review/annotations/ignore", async (c) => {
  const startedAt = Date.now();
  const sessionId = c.req.param("id");
  const body = await c.req.json().catch(() => null) as {
    expectedDocVersion?: unknown;
    annotationIds?: unknown;
    rememberDismissal?: unknown;
  } | null;
  if (
    !body ||
    !isDocumentVersion(body.expectedDocVersion) ||
    !Array.isArray(body.annotationIds) ||
    body.annotationIds.length === 0 ||
    body.annotationIds.some((id) => typeof id !== "string" || id.length === 0) ||
    (body.rememberDismissal !== undefined && typeof body.rememberDismissal !== "boolean")
  ) {
    externalLog("annotation_ignore", {
      sessionId,
      ms: elapsed(startedAt),
      result: "rejected:VALIDATION",
    });
    return externalError(c, 400, "VALIDATION", "expectedDocVersion 或 annotationIds 不合法");
  }
  const session = await getOrRestoreSession(sessionId);
  if (!session) return externalError(c, 404, "SESSION_NOT_FOUND");
  if (deriveAgentBusy(session)) return externalError(c, 409, "AGENT_BUSY");
  if (session.docVersion !== body.expectedDocVersion) {
    return reviewVersionConflict(c, body.expectedDocVersion, session.docVersion);
  }
  const annotationIds = [...new Set(body.annotationIds as string[])];
  const existingIds = new Set(session.annotationGroups.map((group) => group.id));
  if (annotationIds.some((id) => !existingIds.has(id))) {
    return externalError(
      c,
      404,
      "NOT_FOUND",
      "批注不存在",
      "用 `qa review list -s <id>` 重读批注列表",
    );
  }
  const parsed = commandSchema.safeParse({
    kind: "ignoreAnnotationGroups",
    data: {
      sessionId,
      reason: "item_ignored",
      groupIds: annotationIds,
      ...(body.rememberDismissal === true ? { rememberDismissal: true } : {}),
    },
  });
  if (!parsed.success || parsed.data.kind !== "ignoreAnnotationGroups") {
    return externalError(c, 400, "VALIDATION", "批注忽略请求不合法");
  }
  let frames: LoggedFrame[];
  try {
    frames = await sessionManager.submit(sessionId, {
      command: parsed.data,
      origin: "external",
      client: parseExternalClient(c.req.header("x-qa-client")),
      modelOverrides: await resolveRequestModelOverrides({}),
    });
  } catch (error) {
    if (error instanceof SessionActorQueueFullError) {
      return externalError(c, 429, "RATE_LIMITED", "会话命令队列已满");
    }
    throw error;
  }
  if (session.docVersion !== body.expectedDocVersion) {
    return reviewVersionConflict(c, body.expectedDocVersion, session.docVersion, maxSeq(frames));
  }
  const seq = maxSeq(frames);
  externalLog("annotation_ignore", {
    sessionId,
    ms: elapsed(startedAt),
    result: "ignored",
    count: annotationIds.length,
  });
  return c.json({
    status: "ignored" as const,
    annotationIds,
    remainingAnnotationCount: session.annotationGroups.filter(
      (group) => group.status === "reviewing",
    ).length,
    seq,
  });
});

externalRoutes.get("/sessions/:id/chat", async (c) => {
  const startedAt = Date.now();
  const limited = rateLimit(c);
  if (limited) {
    externalLog("chatlog", { sessionId: c.req.param("id"), ms: elapsed(startedAt), result: "rejected:RATE_LIMITED" });
    return limited;
  }
  const sessionId = c.req.param("id");
  const session = await getOrRestoreSessionReadOnly(sessionId);
  if (!session) {
    externalLog("chatlog", { sessionId, ms: elapsed(startedAt), result: "rejected:SESSION_NOT_FOUND" });
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
  const messages = applyLimit(session.chatHistory, c.req.query("limit")).map((message) => ({
    id: message.id,
    role: message.role,
    ts: message.ts,
    text: message.parts.map(partText).filter(Boolean).join("\n"),
  }));
  externalLog("chatlog", { sessionId, ms: elapsed(startedAt), result: "ok", count: messages.length });
  return c.json({ sessionId, messages });
});

externalRoutes.get("/sessions/:id/files", async (c) => {
  const startedAt = Date.now();
  const limited = rateLimit(c);
  if (limited) {
    externalLog("files", { sessionId: c.req.param("id"), ms: elapsed(startedAt), result: "rejected:RATE_LIMITED" });
    return limited;
  }
  const sessionId = c.req.param("id");
  const session = await getOrRestoreSessionReadOnly(sessionId);
  if (!session) {
    externalLog("files", { sessionId, ms: elapsed(startedAt), result: "rejected:SESSION_NOT_FOUND" });
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
  const materials = Array.from(session.materials.values()).map(materialForExternal);
  const folderSources = Array.from(session.folderSources.values()).map(folderSourceForExternal);
  externalLog("files", { sessionId, ms: elapsed(startedAt), result: "ok", count: materials.length });
  return c.json({ sessionId, materials, folderSources });
});

externalRoutes.get("/sessions/:id/files/:materialId/text", async (c) => {
  const startedAt = Date.now();
  const limited = rateLimit(c);
  if (limited) {
    externalLog("files", { sessionId: c.req.param("id"), ms: elapsed(startedAt), result: "rejected:RATE_LIMITED" });
    return limited;
  }
  const sessionId = c.req.param("id");
  const session = await getOrRestoreSessionReadOnly(sessionId);
  if (!session) {
    externalLog("files", { sessionId, ms: elapsed(startedAt), result: "rejected:SESSION_NOT_FOUND" });
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
  const materialId = c.req.param("materialId");
  const material = session.materials.get(materialId);
  if (!material) {
    externalLog("files", { sessionId, ms: elapsed(startedAt), result: "rejected:MATERIAL_NOT_FOUND" });
    return externalError(c, 404, "MATERIAL_NOT_FOUND");
  }
  const maxBytes = parseMaxBytes(c.req.query("maxBytes"), DEFAULT_MATERIAL_TEXT_MAX_BYTES);
  const limitedText = limitUtf8Bytes(material.text, maxBytes);
  externalLog("files", { sessionId, ms: elapsed(startedAt), result: "ok" });
  return c.json({
    id: material.id,
    filename: material.filename,
    mime: material.mimeType,
    text: limitedText.text,
    byteLen: limitedText.byteLen,
    truncated: limitedText.truncated,
  });
});

externalRoutes.post("/sessions/:id/proposals", async (c) => {
  const startedAt = Date.now();
  const sessionId = c.req.param("id");
  const client = parseExternalClient(c.req.header("x-qa-client"));
  const body = await c.req.json().catch(() => null);
  const parsed = commandSchema.safeParse({
    kind: "externalPropose",
    data: {
      ...(typeof body === "object" && body !== null ? body : {}),
      sessionId,
      clientMutationId:
        typeof body === "object" && body !== null && typeof (body as { clientMutationId?: unknown }).clientMutationId === "string"
          ? (body as { clientMutationId: string }).clientMutationId
          : crypto.randomUUID(),
    },
  });
  if (!parsed.success || parsed.data.kind !== "externalPropose") {
    externalLog("propose", { sessionId, ms: elapsed(startedAt), result: "rejected:VALIDATION", hunks: 0 });
    return externalError(c, 400, "VALIDATION", "提案不合法");
  }
  let frames: LoggedFrame[];
  try {
    frames = await sessionManager.submit(sessionId, {
      command: parsed.data,
      origin: "external",
      client,
      modelOverrides: await resolveRequestModelOverrides({}),
    });
  } catch (error) {
    if (error instanceof SessionActorQueueFullError) {
      return externalError(c, 429, "RATE_LIMITED", "会话命令队列已满");
    }
    throw error;
  }
  const summary = proposalSummary(frames);
  externalLog("propose", { sessionId, ms: elapsed(startedAt), result: summary.logResult, hunks: summary.hunks });
  return proposalResponse(c, summary);
});

function parseExternalClient(value: string | undefined): ExternalClient {
  return value === "claudecode" || value === "codex" ? value : "agent";
}

externalRoutes.post("/sessions/:id/chat", async (c) => {
  const startedAt = Date.now();
  const sessionId = c.req.param("id");
  const body = await c.req.json().catch(() => null) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim()) {
    externalLog("chat", { sessionId, ms: elapsed(startedAt), result: "rejected:VALIDATION" });
    return externalError(c, 400, "VALIDATION", "缺少 text");
  }
  const session = await getOrRestoreSession(sessionId);
  if (!session) {
    externalLog("chat", { sessionId, ms: elapsed(startedAt), result: "rejected:SESSION_NOT_FOUND" });
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
  // 把调用方身份编进消息 id(与 proposals 同约定),前端据 external-<client>- 前缀展示"代你发送了一条消息"。
  const client = parseExternalClient(c.req.header("x-qa-client"));
  const parsed = commandSchema.safeParse({
    kind: "sendMessage",
    data: {
      sessionId,
      text,
      mentions: [],
      skills: [],
      chips: [],
      fileIds: [],
      clientMessageId: `external-${client}-${crypto.randomUUID()}`,
    },
  });
  if (!parsed.success || parsed.data.kind !== "sendMessage") {
    externalLog("chat", { sessionId, ms: elapsed(startedAt), result: "rejected:VALIDATION" });
    return externalError(c, 400, "VALIDATION", "text 超过 64KB 上限");
  }
  const modelOverrides = await resolveRequestModelOverrides({});
  let completion: Promise<LoggedFrame[]>;
  try {
    ({ completion } = await sessionManager.submitQueued(sessionId, {
      command: parsed.data,
      origin: "external",
      modelOverrides,
    }));
  } catch (error) {
    if (error instanceof SessionActorQueueFullError) {
      externalLog("chat", { sessionId, ms: elapsed(startedAt), result: "rejected:RATE_LIMITED" });
      return externalError(c, 429, "RATE_LIMITED", "会话命令队列已满");
    }
    throw error;
  }
  void completion.catch(() => {
    console.warn(`[external] evt=chat session=${sessionId} result=async_failed`);
  });
  externalLog("chat", { sessionId, ms: elapsed(startedAt), result: "queued" });
  return c.json({ queued: true, note: "已入队,执行结果以 events 为准" });
});

externalRoutes.get("/sessions/:id/events", (c) => {
  const sessionId = c.req.param("id");
  const afterParam = c.req.header("Last-Event-ID") ?? c.req.query("after");
  const client = requestClientAddress(c);
  const admission = sseAdmission.acquire(client.ip, sessionId, { loopback: client.loopback });
  if (!admission.accepted) {
    c.header("Retry-After", "1");
    return externalError(c, 429, "RATE_LIMITED", "SSE 连接数超过公网准入上限");
  }
  return streamSSE(c, async (stream) => {
    const afterSeq = afterParam === "tip"
      ? Math.max(0, sessionManager.frameLog.readFrom(sessionId, 0).nextSeq - 1)
      : parseSeq(afterParam);
    let unsubscribe: () => void = () => undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      admission.release();
      settle();
    };
    const pump = new BoundedSsePump({
      write: (message) => stream.writeSSE(message),
      onClose: () => {
        stream.abort();
        cleanup();
      },
    });
    const meta = sessionManager.frameLog.readFrom(sessionId, afterSeq);
    const publicMeta = externalEventsMeta(meta, afterSeq);
    pump.enqueue({
      event: "meta",
      data: JSON.stringify({
        epoch: publicMeta.epoch,
        minSeq: publicMeta.minSeq,
        nextSeq: publicMeta.nextSeq,
        gap: publicMeta.gap,
      }),
    });
    const enqueue = (entry: LoggedFrame, delivery: "replay" | "live"): void => {
      const frame = frameForExternal(entry);
      if (!frame) return;
      pump.enqueue({
        id: String(entry.seq),
        event: "frame",
        data: JSON.stringify(frame),
      }, {
        delivery,
        allowOversized: entry.frame.kind === "documentSnapshotWritten",
      });
    };
    try {
      unsubscribe = sessionManager.frameLog.subscribe(sessionId, afterSeq, enqueue);
      if (cleaned) unsubscribe();
      if (!cleaned) {
        heartbeat = setInterval(() => {
          pump.enqueue({ event: "ping", data: "{}" }, { dropOnOverflow: true });
        }, 15_000);
      }
      stream.onAbort(() => {
        pump.close();
        cleanup();
      });
      await settled;
      await pump.waitForIdle();
    } finally {
      pump.close();
      cleanup();
    }
  });
});

function reviewBatchId(suggestion: DocSuggestion): string {
  return suggestion.reviewBatchId ?? suggestion.diffHunk?.reviewBatchId ?? suggestion.id;
}

function reviewPatchSummary(suggestion: DocSuggestion): ExternalReviewPatchSummary {
  const hunk = suggestion.diffHunk;
  const conflict = suggestion.conflict
    ? {
        kind: suggestion.conflict.kind,
        message: suggestion.conflict.message,
        ...("suggestionId" in suggestion.conflict
          ? { suggestionId: suggestion.conflict.suggestionId }
          : {}),
        ...("blockId" in suggestion.conflict
          ? { blockId: suggestion.conflict.blockId }
          : {}),
        ...("currentVersion" in suggestion.conflict
          ? { currentVersion: suggestion.conflict.currentVersion }
          : {}),
      }
    : null;
  return {
    id: suggestion.id,
    reviewBatchId: reviewBatchId(suggestion),
    groupMode: suggestion.groupMode ?? hunk?.groupMode ?? null,
    status: suggestion.status,
    baseVersion: suggestion.baseVersion,
    summary: suggestion.summary,
    beforeText: hunk?.beforeText ?? suggestion.preview.deleteText,
    afterText: hunk?.afterText ?? suggestion.preview.insertText,
    conflict,
  };
}

function reviewPatchDetail(suggestion: DocSuggestion): ExternalReviewPatchDetail {
  const hunk = suggestion.diffHunk;
  const diff: ExternalReviewDiff | null = hunk
    ? {
        op: hunk.op,
        blockPath: hunk.blockPath,
        summary: hunk.summary,
        beforeText: hunk.beforeText ?? suggestion.preview.deleteText,
        afterText: hunk.afterText ?? suggestion.preview.insertText,
        anchor: hunk.anchor,
      }
    : null;
  return {
    ...reviewPatchSummary(suggestion),
    anchor: {
      blockId: suggestion.anchor.blockId,
      pmFrom: suggestion.anchor.pmFrom,
      pmTo: suggestion.anchor.pmTo,
      quote: suggestion.anchor.quote,
      ...(suggestion.anchor.prefix !== undefined
        ? { prefix: suggestion.anchor.prefix }
        : {}),
      ...(suggestion.anchor.suffix !== undefined
        ? { suffix: suggestion.anchor.suffix }
        : {}),
    },
    diff,
  };
}

function annotationForExternal(group: AnnotationGroup): ExternalAnnotation {
  return {
    id: group.id,
    summary: group.summary,
    note: group.note,
    origin: group.origin,
    ...(group.suggestion !== undefined ? { suggestion: group.suggestion } : {}),
    ...(group.severity !== undefined ? { severity: group.severity } : {}),
    status: group.status,
    anchors: group.anchors.map((anchor) => ({
      blockId: anchor.blockId,
      pmFrom: anchor.pmFrom,
      pmTo: anchor.pmTo,
      quote: anchor.quote,
      ...(anchor.prefix !== undefined ? { prefix: anchor.prefix } : {}),
      ...(anchor.suffix !== undefined ? { suffix: anchor.suffix } : {}),
    })),
  };
}

function isDocumentVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function countReviewingPatches(
  records: Iterable<{ suggestion: DocSuggestion }>,
): number {
  let count = 0;
  for (const record of records) {
    if (record.suggestion.status === "reviewing") count += 1;
  }
  return count;
}

function reviewDecisions(
  suggestions: readonly DocSuggestion[],
  action: ExternalReviewCommitRequest["action"],
): { acceptedBatchIds: string[]; rejectedBatchIds: string[] } {
  const rejectedByBatch = new Map<string, boolean>();
  for (const suggestion of suggestions) {
    const batchId = reviewBatchId(suggestion);
    const rejected = action === "reject_all" ||
      (action === "commit" && suggestion.status === "rejected");
    rejectedByBatch.set(batchId, (rejectedByBatch.get(batchId) ?? false) || rejected);
  }
  return {
    acceptedBatchIds: [...rejectedByBatch.entries()]
      .filter(([, rejected]) => action !== "reject_all" && !rejected)
      .map(([batchId]) => batchId),
    rejectedBatchIds: [...rejectedByBatch.entries()]
      .filter(([, rejected]) => rejected)
      .map(([batchId]) => batchId),
  };
}

const REVIEW_OUTCOME_TEXT_CAP = 4_000;
const REVIEW_OUTCOME_SUMMARY_CAP = 60;

function clipReviewOutcomeText(value: string): string {
  return value.length > REVIEW_OUTCOME_TEXT_CAP
    ? `${value.slice(0, REVIEW_OUTCOME_TEXT_CAP)}…`
    : value;
}

function reviewOutcome(
  suggestions: readonly DocSuggestion[],
  rejectedBatchIds: readonly string[],
): ReviewOutcome {
  const rejected = new Set(rejectedBatchIds);
  const hunks = suggestions.map((suggestion) => {
    const beforeText = clipReviewOutcomeText(
      suggestion.diffHunk?.beforeText ?? suggestion.preview.deleteText,
    );
    const afterText = clipReviewOutcomeText(
      suggestion.diffHunk?.afterText ?? suggestion.preview.insertText,
    );
    const summaryBase = (
      suggestion.anchor.quote ||
      beforeText ||
      afterText ||
      suggestion.diffHunk?.summary ||
      suggestion.summary
    ).split("\n")[0]!.trim();
    const blockSummary = summaryBase.length > REVIEW_OUTCOME_SUMMARY_CAP
      ? `${summaryBase.slice(0, REVIEW_OUTCOME_SUMMARY_CAP)}…`
      : summaryBase;
    return {
      verdict: rejected.has(reviewBatchId(suggestion))
        ? "rejected" as const
        : "accepted" as const,
      blockSummary,
      beforeText,
      afterText,
    };
  });
  return {
    acceptedCount: hunks.filter((hunk) => hunk.verdict === "accepted").length,
    rejectedCount: hunks.filter((hunk) => hunk.verdict === "rejected").length,
    hunks,
  };
}

function hasFrame(entries: LoggedFrame[], kind: BridgeFrame["kind"]): boolean {
  return entries.some((entry) => entry.frame.kind === kind);
}

function reviewVersionConflict(
  c: Context,
  expected: number,
  actual: number,
  seq: number | null = null,
) {
  return c.json(withSeq({
    code: "VERSION_CONFLICT" as const,
    expected,
    actual,
    nextStep: EXTERNAL_NEXT_STEP.VERSION_CONFLICT,
  }, seq), 409);
}

interface ProposalSummary {
  status: 200 | 400 | 404 | 409;
  body: unknown;
  logResult: string;
  hunks: number;
  seq: number | null;
}

function proposalSummary(entries: LoggedFrame[]): ProposalSummary {
  const frames = entries.map((entry) => entry.frame);
  const seq = maxSeq(entries);
  const diff = frames.find((frame) => frame.kind === "docDiffReady");
  if (diff?.kind === "docDiffReady") {
    const patchIds = diff.data.suggestions.map((suggestion) => suggestion.id);
    return {
      status: 200,
      body: withSeq({ status: "review", patchIds, count: patchIds.length }, seq),
      logResult: "review",
      hunks: patchIds.length,
      seq,
    };
  }
  const write = frames.find((frame) => frame.kind === "docWriteResult");
  if (write?.kind === "docWriteResult") {
    if (write.data.ok) {
      return {
        status: 200,
        body: withSeq({ status: "committed", docVersion: write.data.docVersion }, seq),
        logResult: "committed",
        hunks: 0,
        seq,
      };
    }
    if ("conflict" in write.data) {
      return {
        status: 409,
        body: withSeq({
          code: "VERSION_CONFLICT",
          expected: write.data.conflict.expectedDocumentSnapshot,
          actual: write.data.conflict.actualDocumentSnapshot,
          nextStep: EXTERNAL_NEXT_STEP.VERSION_CONFLICT,
        }, seq),
        logResult: "rejected:VERSION_CONFLICT",
        hunks: 0,
        seq,
      };
    }
    if (write.data.reason === "agent_busy") return errorSummary(409, "AGENT_BUSY", undefined, seq);
    if (write.data.reason === "not_editable") return errorSummary(409, "REVIEW_PENDING", undefined, seq);
    if (write.data.reason === "not_found") return errorSummary(404, "SESSION_NOT_FOUND", undefined, seq);
    return errorSummary(400, "VALIDATION", "未命中,请重读文档", seq);
  }
  return errorSummary(400, "VALIDATION", "提案未产生有效变更", seq);
}

function proposalResponse(c: Context, summary: ProposalSummary) {
  return c.json(summary.body, summary.status);
}

function errorSummary(
  status: 400 | 404 | 409,
  code: ExternalErrorCode,
  message?: string,
  seq: number | null = null,
): ProposalSummary {
  return {
    status,
    body: withSeq({ error: message ?? code, code, nextStep: EXTERNAL_NEXT_STEP[code] }, seq),
    logResult: `rejected:${code}`,
    hunks: 0,
    seq,
  };
}

function maxSeq(entries: LoggedFrame[]): number | null {
  return entries.reduce<number | null>((max, entry) => max === null ? entry.seq : Math.max(max, entry.seq), null);
}

function withSeq<T extends Record<string, unknown>>(body: T, seq: number | null): T & { seq?: number } {
  return seq === null ? body : { ...body, seq };
}

const EXTERNAL_FRAME_KIND_ALLOWLIST = {
  restoreReset: true,
  sessionMeta: true,
  chatMessageAdded: true,
  chatMessageAppended: true,
  toolCallUpdated: true,
  documentSnapshotWritten: true,
  docGenerationEvent: true,
  docCommitted: true,
  docDiffReady: true,
  docWriteResult: true,
  docStateChanged: true,
  todosChanged: true,
  resourceUpserted: true,
  resourceUpdated: true,
  resourceRemoved: true,
  folderSourcesChanged: true,
  folderSourceOperationResult: true,
  annotationGroupsReady: true,
  stream: true,
} as const satisfies Record<ExternalBridgeFrame["kind"], true>;

const EXTERNAL_FRAME_KINDS: ReadonlySet<ExternalBridgeFrame["kind"]> = new Set(
  Object.keys(EXTERNAL_FRAME_KIND_ALLOWLIST) as ExternalBridgeFrame["kind"][],
);

function isExternalFrameKind(kind: BridgeFrame["kind"]): kind is ExternalBridgeFrame["kind"] {
  return EXTERNAL_FRAME_KINDS.has(kind as ExternalBridgeFrame["kind"]);
}

function frameForExternal(entry: LoggedFrame): ExternalBridgeFrame | null {
  if (!isExternalFrameKind(entry.frame.kind)) return null;
  return {
    seq: entry.seq,
    kind: entry.frame.kind,
    data: dataForExternal(entry.frame.data),
  } as ExternalBridgeFrame;
}

function dataForExternal<T>(data: T): T {
  const cloned = structuredClone(data);
  return stripSvgStrings(cloned) as T;
}

const LONG_SVG_VALUE_BYTES = 64;

function stripSvgStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return isSvgString(value) ? svgPlaceholder(value) : value;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = stripSvgStrings(value[index]);
    }
    return value;
  }
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === "string" && isSvgString(child, key)) {
      record[key] = null;
      record.svgBytes = Buffer.byteLength(child, "utf8");
    } else {
      record[key] = stripSvgStrings(child);
    }
  }
  return record;
}

function isSvgString(value: string, key?: string): boolean {
  const bytes = Buffer.byteLength(value, "utf8");
  return value.trimStart().toLowerCase().startsWith("<svg")
    || (key?.toLowerCase() === "svg" && bytes >= LONG_SVG_VALUE_BYTES);
}

function svgPlaceholder(value: string): string {
  return `[svg ${Buffer.byteLength(value, "utf8")}B stripped]`;
}

function externalEventsMeta(
  meta: FrameLogReadResult,
  afterSeq: number,
): { epoch: number; minSeq: number; nextSeq: number; gap: boolean } {
  const publicFrames = meta.frames.filter((entry) => isExternalFrameKind(entry.frame.kind));
  const lastPublicSeq = publicFrames.at(-1)?.seq;
  const nextSeq = lastPublicSeq !== undefined
    ? lastPublicSeq + 1
    : meta.gap
      ? meta.nextSeq
      : afterSeq + 1;
  return {
    epoch: meta.epoch,
    minSeq: publicFrames[0]?.seq ?? (meta.gap ? meta.minSeq : nextSeq),
    nextSeq,
    gap: meta.gap,
  };
}

function rateLimit(c: Context) {
  const client = requestClientAddress(c);
  if (client.loopback) return null;
  const key = `${c.req.method}:${client.ip}:${c.req.path}`;
  const now = Date.now();
  if (rateBuckets.size > 1_000) {
    for (const [bucketKey, bucket] of rateBuckets) {
      if (now - bucket.windowStart >= 1000) rateBuckets.delete(bucketKey);
    }
  }
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= 1000) {
    rateBuckets.set(key, { windowStart: now, count: 1 });
    return null;
  }
  bucket.count += 1;
  const limit = c.req.method === "GET" || c.req.method === "HEAD"
    ? READ_RATE_LIMIT_PER_SECOND
    : WRITE_RATE_LIMIT_PER_SECOND;
  if (bucket.count > limit) return externalError(c, 429, "RATE_LIMITED");
  return null;
}

function parseSeq(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function withLineNumbers(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .map((line, index) => `${String(index + 1).padStart(4, " ")} | ${line}`)
    .join("\n");
}

function applyLimit(messages: ChatMessage[], value: string | undefined): ChatMessage[] {
  if (!value) return messages;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return [];
  return messages.slice(-Math.floor(limit));
}

function partText(part: MessagePart): string {
  switch (part.kind) {
    case "text":
    case "code":
      return part.data.body;
    case "toolCall": {
      const data = part.data as { name?: unknown; toolName?: unknown };
      const toolName = [data.name, data.toolName]
        .find((value): value is string => typeof value === "string" && value.trim().length > 0);
      return toolName ? `[工具调用:${toolName}]` : "[工具调用]";
    }
    case "thinking":
      return "";
    case "image":
      return "[图片]";
    case "patchSummary":
      return `[修改建议 ${part.data.count} 处]`;
    case "reviewOutcome":
      return "[审阅结果]";
    case "citation":
      return "[引用]";
    case "askUserAnswerCard":
      return "[用户答复]";
    case "actionCard":
      return `[操作：${part.data.title}]`;
  }
}

function materialForExternal(material: Material) {
  return {
    id: material.id,
    filename: material.filename,
    mime: material.mimeType,
    summary: material.summary ?? "",
    wordCount: material.metadata.wordCount,
    byteLen: Buffer.byteLength(material.text, "utf8"),
    parseState: material.metadata.parseState ?? "ready",
    sourceUrl: material.metadata.sourceUrl ?? null,
    createdAt: material.createdAt,
  };
}

function folderSourceForExternal(source: FolderSourceRecord) {
  return {
    id: source.id,
    displayName: source.name,
    provider: source.provider,
    status: source.status,
  };
}

function parseMaxBytes(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function limitUtf8Bytes(text: string, maxBytes: number): { text: string; byteLen: number; truncated: boolean } {
  const byteLen = Buffer.byteLength(text, "utf8");
  if (byteLen <= maxBytes) return { text, byteLen, truncated: false };
  return {
    text: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, ""),
    byteLen,
    truncated: true,
  };
}

async function saveEmptySessionDocument(sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await documentRepo.save({
    id: sessionId,
    threadId: sessionId,
    resourceId: QINGAGENT_RESOURCE_ID,
    title: "未命名草稿",
    docState: "empty",
    docVersion: 0,
    lastSyncedVersion: 0,
    pmDoc: normalizePmDoc(markdownToPm("")),
    createdAt: now,
    updatedAt: now,
  });
}

function elapsed(startedAt: number): number {
  return Date.now() - startedAt;
}

function clampedQueryInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function externalLog(
  evt:
    | "propose"
    | "chat"
    | "chatlog"
    | "files"
    | "read"
    | "health"
    | "sessions"
    | "review_list"
    | "review_show"
    | "review_verdict"
    | "review_commit"
    | "annotation_show"
    | "annotation_ignore",
  fields: {
    sessionId?: string;
    ms: number;
    result: string;
    hunks?: number;
    count?: number;
    patches?: number;
    annotations?: number;
    verdict?: "accepted" | "rejected";
    accepted?: number;
    rejected?: number;
    total?: number;
    hasMore?: boolean;
  },
): void {
  const parts = [
    "[external]",
    `evt=${evt}`,
    `session=${fields.sessionId ?? "-"}`,
    `ms=${fields.ms}`,
    `result=${fields.result}`,
  ];
  if (fields.hunks !== undefined) parts.push(`hunks=${fields.hunks}`);
  if (fields.count !== undefined) parts.push(`count=${fields.count}`);
  if (fields.patches !== undefined) parts.push(`patches=${fields.patches}`);
  if (fields.annotations !== undefined) parts.push(`annotations=${fields.annotations}`);
  if (fields.verdict !== undefined) parts.push(`verdict=${fields.verdict}`);
  if (fields.accepted !== undefined) parts.push(`accepted=${fields.accepted}`);
  if (fields.rejected !== undefined) parts.push(`rejected=${fields.rejected}`);
  if (fields.total !== undefined) parts.push(`total=${fields.total}`);
  if (fields.hasMore !== undefined) parts.push(`hasMore=${fields.hasMore}`);
  console.info(parts.join(" "));
}

import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
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
  WriteDraftFailureDiagnostic,
} from "@qingagent/contract-ts";
import { commandSchema } from "@qingagent/contract-ts/schemas";
import {
  listSessionResources,
  registerSessionResource,
} from "@qingagent/db";
import type {
  ExternalAnnotation,
  ExternalAnnotationCreateRequest,
  ExternalAnnotationIgnoreRequest,
  ExternalBridgeFrame,
  ExternalDocReplaceRequest,
  ExternalErrorCode,
  ExternalReviewCommitRequest,
  ExternalReviewDiff,
  ExternalReviewPatchDetail,
  ExternalReviewPatchSummary,
  ExternalReviewVerdictRequest,
  ExternalTurnSignalRequest,
  ExternalValidationDiagnostic,
} from "../../../contract-ts/src/ExternalApi";
import {
  currentPmDoc,
  deriveActiveOverlay,
  deriveAgentBusy,
  deriveContentState,
  deriveTitleFromDoc,
  documentRepo,
  emitProjectedDocState,
  EXTERNAL_PLUGIN_REVIEW_ORIGIN,
  hasCanonicalDoc,
  isWholeDocumentSuggestionBatchId,
  listLexicons,
  QINGAGENT_RESOURCE_ID,
  createAnnotationGroupsInputSchema,
  writeAnnotationGroups,
  type SessionState,
} from "@qingagent/core";
import {
  aiBlocksToQingml,
  countDocVisibleChars,
  getPmContentHash,
  hasExportableDocContent,
  markdownToPm,
  normalizePmDoc,
  pmToAiIr,
  pmToMarkdown,
} from "@qingagent/pm-schema";
import crypto from "node:crypto";
import { getExternalInstancePublicInfo } from "../lib/externalInstance";
import { EXTERNAL_NEXT_STEP, externalError } from "../lib/externalError";
import { resolveRequestModelOverrides } from "../modelOverridesProvider";
import {
  getOrRestoreSession,
  getOrRestoreSessionForVersionedRead,
  handleCommand,
  sessionExists,
  sessionManager,
  signalExternalBusyLease,
} from "../gateway/bridgeHandler";
import { sessions as loadedSessionRegistry } from "../gateway/sessionRegistry";
import { getOrRestoreSessionReadOnly } from "../gateway/sessionLifecycle";
import type { FrameLogReadResult, LoggedFrame } from "../gateway/frameLog";
import type { Material } from "@qingagent/core";
import {
  SessionActorNativeBusyError,
  SessionActorQueueFullError,
  type ExternalLeaseOwner,
} from "../gateway/sessionActor";
import { isExternalBusyLeaseHolder } from "../gateway/docWriteCommands";
import { BoundedSsePump } from "../lib/boundedSsePump";
import { allowOversizedSseFrame } from "../lib/terminalDocumentFrame";
import { requestClientAddress, sseAdmission } from "../lib/sseAdmission";
import { queueExternalChat } from "../lib/externalChatQueue";
import { externalTemplateRoutes } from "./externalTemplates";
import { externalSkillRoutes } from "./externalSkills";
import {
  exportDocumentResponse,
  normalizeExportFormat,
  type ExportFailureCode,
} from "./export";
import { resolveUploadMaxBytes } from "../lib/uploadLimits";
import {
  deleteUploadedFile,
  findOrStoreUploadedFile,
  isValidUploadId,
} from "../lib/uploadStorage";
import {
  parseExternalAssetJson,
  validateExternalAssetUploadInput,
  type ExternalAssetUploadInputError,
  type ExternalAssetUploadInputResult,
} from "../lib/externalAssetUpload";
import {
  resolveUploadedFileForRead,
  streamResolvedUploadedFile,
} from "../lib/uploadServing";
import { getRequestPrincipal } from "../lib/principal";

export const externalRoutes = new Hono();

type ExternalClient = "claudecode" | "codex" | "deepseek" | "agent";

const DEFAULT_MATERIAL_TEXT_MAX_BYTES = 200_000;
const DEFAULT_SESSIONS_LIMIT = 100;
const MAX_SESSIONS_LIMIT = 500;
const READ_RATE_LIMIT_PER_SECOND = 5;
const WRITE_RATE_LIMIT_PER_SECOND = 20;
const SESSION_SNAPSHOT_CURSOR_START = "start";
const SESSION_SNAPSHOT_TTL_MS = 5 * 60_000;
const MAX_SESSION_SNAPSHOT_CURSORS = 32;
const MAX_SESSION_SNAPSHOT_ITEMS = 50_000;
const MAX_EXTERNAL_TURN_ID_LENGTH = 256;
const EXTERNAL_TURN_SIGNAL_DEADLINE_MS = 10_000;
const externalAssetMaxBytes = resolveUploadMaxBytes();
const EXTERNAL_ASSET_BODY_OVERHEAD_BYTES = 64 * 1024;
const externalAssetMaxRequestBytes = Math.max(
  externalAssetMaxBytes,
  Math.ceil(externalAssetMaxBytes / 3) * 4,
) + EXTERNAL_ASSET_BODY_OVERHEAD_BYTES;

const rateBuckets = new Map<string, { windowStart: number; count: number }>();
let storedSessionSnapshotItems = 0;
const sessionSnapshotCursors = new Map<string, {
  sessions: ExternalSessionSummary[];
  offset: number;
  expiresAt: number;
}>();

type ExternalSessionSummary = {
  id: string;
  title: string;
  state: ContentDocState["kind"];
  updatedAt: string;
};

const EXISTS_BY_IDS_BATCH_SIZE = 50;

externalRoutes.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const limited = rateLimit(c);
    if (limited) return limited;
  }
  await next();
});

externalRoutes.route("/", externalTemplateRoutes);
externalRoutes.route("/", externalSkillRoutes);

externalRoutes.get("/health", (c) => {
  const startedAt = Date.now();
  // 不限流:health 是 CLI 每条命令的发现心跳(discoverInstance 每次都打),
  // 限流会把连续命令误判成 NO_INSTANCE。限流只留给 doc read(PRD 意图:防高频拉取失控循环)。
  const info = getExternalInstancePublicInfo();
  externalLog("health", { ms: elapsed(startedAt), result: "ok" });
  if (!info) {
    return externalError(c, 503, "AUTH_FAILED", "instance identity is not ready");
  }
  return c.json({ ok: true, ...info });
});

externalRoutes.get("/lexicons", async (c) => {
  const limited = rateLimit(c);
  if (limited) return limited;
  const lexicons = (await listLexicons()).map(({ id, name, entryCount, enabled }) => ({
    id,
    name,
    entryCount,
    enabled,
  }));
  return c.json({ lexicons });
});

externalRoutes.get("/sessions", async (c) => {
  const startedAt = Date.now();
  const limit = clampedQueryInteger(c.req.query("limit"), DEFAULT_SESSIONS_LIMIT, 1, MAX_SESSIONS_LIMIT);
  const offset = clampedQueryInteger(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const cursor = c.req.query("cursor");
  if (cursor !== undefined) {
    let snapshot: { sessions: ExternalSessionSummary[]; offset: number } | null;
    if (cursor === SESSION_SNAPSHOT_CURSOR_START) {
      const sessions = await snapshotExternalSessions();
      if (!sessions) {
        return externalError(
          c,
          409,
          "CONFLICT",
          "会话数量过多，暂时无法建立稳定列表",
          "请稍后重试",
        );
      }
      snapshot = { sessions, offset: 0 };
    } else {
      snapshot = takeSessionSnapshotCursor(cursor);
    }
    if (!snapshot) {
      return externalError(
        c,
        400,
        "VALIDATION",
        "会话分页游标已失效",
        "重新运行 `qa sessions list --all`",
      );
    }
    const page = sessionSnapshotPage(snapshot.sessions, snapshot.offset, limit);
    externalLog("sessions", {
      ms: elapsed(startedAt),
      result: "ok",
      count: page.sessions.length,
      total: page.total,
      hasMore: page.hasMore,
    });
    return c.json(page);
  }
  const page = await listExternalSessions(limit, offset);
  externalLog("sessions", {
    ms: elapsed(startedAt),
    result: "ok",
    count: page.sessions.length,
    total: page.total,
    hasMore: page.hasMore,
  });
  return c.json(page);
});

async function listExternalSessions(
  limit: number,
  offset: number,
): Promise<{
  sessions: ExternalSessionSummary[];
  total: number;
  hasMore: boolean;
}> {
  // documents 与 Mastra thread 同库关联后再分页，孤儿行不会占用 total/offset。
  const { rows, total: persistedTotal } = await documentRepo.listWithExistingThreads({
    resourceId: QINGAGENT_RESOURCE_ID,
    perPage: limit,
    offset,
  });
  const sessions: ExternalSessionSummary[] = [];
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
  const loadedSessions = [...loadedSessionRegistry.values()];
  const memorySessionIds = loadedSessions.map((session) => session.sessionId);
  // 当前页之外的真实落盘会话也不能作为内存会话重复出现；但仅有 documents
  // 孤儿行不算落盘列表会话，必须经同一条 thread 恢复路径确认。
  const persistedSessionIds = new Set(sessions.map((session) => session.id));
  const unresolvedMemoryIds = memorySessionIds.filter(
    (sessionId) => !persistedSessionIds.has(sessionId),
  );
  if (unresolvedMemoryIds.length > 0) {
    for (let start = 0; start < unresolvedMemoryIds.length; start += EXISTS_BY_IDS_BATCH_SIZE) {
      const offPageDocumentIds = await documentRepo.existsByIds(
        QINGAGENT_RESOURCE_ID,
        unresolvedMemoryIds.slice(start, start + EXISTS_BY_IDS_BATCH_SIZE),
      );
      for (const sessionId of offPageDocumentIds) {
        persistedSessionIds.add(sessionId);
      }
    }
  }
  const memoryOnlySessions = loadedSessions
    .filter((session) => !persistedSessionIds.has(session.sessionId))
    .map((session): ExternalSessionSummary => ({
      id: session.sessionId,
      title: session.title || "未命名草稿",
      state: deriveContentState(session).kind,
      updatedAt: stableMemorySessionUpdatedAt(session.lastContentEditedAt),
    }))
    .sort(compareExternalSessions);
  const memoryOffset = Math.max(0, offset - persistedTotal);
  const memoryPage = memoryOnlySessions.slice(
    memoryOffset,
    memoryOffset + Math.max(0, limit - sessions.length),
  );
  sessions.push(...memoryPage);
  const mergedTotal = persistedTotal + memoryOnlySessions.length;
  const hasMore = offset + sessions.length < mergedTotal;
  return {
    sessions,
    total: mergedTotal,
    hasMore,
  };
}

async function snapshotExternalSessions(): Promise<ExternalSessionSummary[] | null> {
  const persistedRows = await documentRepo.listSessionSummariesWithExistingThreads({
    resourceId: QINGAGENT_RESOURCE_ID,
    limit: MAX_SESSION_SNAPSHOT_ITEMS + 1,
  });
  if (persistedRows.length > MAX_SESSION_SNAPSHOT_ITEMS) return null;

  const sessions: ExternalSessionSummary[] = persistedRows.map((row) => ({
    id: row.id,
    title: row.title || "未命名草稿",
    state: normalizedExternalSessionState(row.docState),
    updatedAt: row.updatedAt,
  }));
  const persistedSessionIds = new Set(sessions.map((session) => session.id));
  const memoryOnlySessions = [...loadedSessionRegistry.values()]
    .filter((session) => !persistedSessionIds.has(session.sessionId))
    .map((session): ExternalSessionSummary => ({
      id: session.sessionId,
      title: session.title || "未命名草稿",
      state: deriveContentState(session).kind,
      updatedAt: stableMemorySessionUpdatedAt(session.lastContentEditedAt),
    }))
    .sort(compareExternalSessions);
  for (const session of memoryOnlySessions) {
    sessions.push(session);
    if (sessions.length > MAX_SESSION_SNAPSHOT_ITEMS) return null;
  }
  return sessions;
}

function stableMemorySessionUpdatedAt(value: string | null): string {
  return value && Number.isFinite(Date.parse(value))
    ? value
    : "1970-01-01T00:00:00.000Z";
}

function compareExternalSessions(
  left: ExternalSessionSummary,
  right: ExternalSessionSummary,
): number {
  const updatedOrder = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updatedOrder) return updatedOrder;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function normalizedExternalSessionState(docState: string): ContentDocState["kind"] {
  switch (docState) {
    case "empty":
      return "empty";
    case "pendingReview":
      return "pendingReview";
    case "editing":
      return "editing";
    default:
      throw new Error(`Invalid stored document state: ${docState}`);
  }
}

function sessionSnapshotPage(
  sessions: ExternalSessionSummary[],
  offset: number,
  limit: number,
): {
  sessions: ExternalSessionSummary[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
} {
  const page = sessions.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < sessions.length;
  return {
    sessions: page,
    total: sessions.length,
    hasMore,
    nextCursor: hasMore
      ? storeSessionSnapshotCursor(sessions, nextOffset)
      : null,
  };
}

function storeSessionSnapshotCursor(
  sessions: ExternalSessionSummary[],
  offset: number,
): string {
  pruneSessionSnapshotCursors();
  while (
    sessionSnapshotCursors.size >= MAX_SESSION_SNAPSHOT_CURSORS ||
    storedSessionSnapshotItems + sessions.length > MAX_SESSION_SNAPSHOT_ITEMS
  ) {
    const oldest = sessionSnapshotCursors.keys().next().value as string | undefined;
    if (!oldest) break;
    deleteSessionSnapshotCursor(oldest);
  }
  const cursor = crypto.randomUUID();
  sessionSnapshotCursors.set(cursor, {
    sessions,
    offset,
    expiresAt: Date.now() + SESSION_SNAPSHOT_TTL_MS,
  });
  storedSessionSnapshotItems += sessions.length;
  return cursor;
}

function takeSessionSnapshotCursor(
  cursor: string,
): { sessions: ExternalSessionSummary[]; offset: number } | null {
  pruneSessionSnapshotCursors();
  const snapshot = sessionSnapshotCursors.get(cursor);
  if (!snapshot) return null;
  deleteSessionSnapshotCursor(cursor);
  return { sessions: snapshot.sessions, offset: snapshot.offset };
}

function pruneSessionSnapshotCursors(): void {
  const now = Date.now();
  for (const [cursor, snapshot] of sessionSnapshotCursors) {
    if (snapshot.expiresAt <= now) deleteSessionSnapshotCursor(cursor);
  }
}

function deleteSessionSnapshotCursor(cursor: string): void {
  const snapshot = sessionSnapshotCursors.get(cursor);
  if (!snapshot) return;
  sessionSnapshotCursors.delete(cursor);
  storedSessionSnapshotItems = Math.max(
    0,
    storedSessionSnapshotItems - snapshot.sessions.length,
  );
}

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

externalRoutes.post("/sessions/:id/turn-signal", async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req.json().catch(() => null) as
    Partial<Record<keyof ExternalTurnSignalRequest, unknown>> | null;
  const action = body?.action;
  const turnId = typeof body?.turnId === "string" ? body.turnId : "";
  if (
    (action !== "begin" && action !== "end" && action !== "heartbeat")
    || turnId.trim().length === 0
    || turnId.length > MAX_EXTERNAL_TURN_ID_LENGTH
  ) {
    return externalError(c, 400, "VALIDATION", "回合信号不合法");
  }
  const principalId = externalLeasePrincipalId(c);
  if (!principalId) return externalError(c, 401, "AUTH_FAILED", "unauthorized");

  try {
    const result = await signalExternalBusyLease({
      sessionId,
      principalId,
      turnId,
      action,
      ...(action === "begin"
        ? {
            deadline: Date.now() + EXTERNAL_TURN_SIGNAL_DEADLINE_MS,
            signal: c.req.raw.signal,
          }
        : {}),
    });
    if (result.cancelled) {
      return externalError(c, 409, "BUSY_NATIVE", "回合信号已过期，未授予编辑锁");
    }
    if (!result.found) return externalError(c, 404, "SESSION_NOT_FOUND");
    if (result.errorCode) {
      return externalError(c, 409, result.errorCode);
    }
    return c.json({
      ok: true,
      active: result.active,
      expiresAt: result.expiresAt,
    });
  } catch (error) {
    if (error instanceof SessionActorNativeBusyError) {
      return externalError(c, 409, "BUSY_NATIVE");
    }
    if (error instanceof SessionActorQueueFullError) {
      return externalError(c, 429, "RATE_LIMITED", "会话命令队列已满");
    }
    throw error;
  }
});

externalRoutes.get("/sessions/:id/doc", async (c) => {
  const startedAt = Date.now();
  const limited = rateLimit(c);
  if (limited) {
    externalLog("read", { sessionId: c.req.param("id"), ms: elapsed(startedAt), result: "rejected:RATE_LIMITED" });
    return limited;
  }
  const sessionId = c.req.param("id");
  const format = c.req.query("format");
  if (format !== undefined && format !== "qingml" && format !== "pm") {
    externalLog("read", { sessionId, ms: elapsed(startedAt), result: "rejected:VALIDATION" });
    return externalError(
      c,
      400,
      "VALIDATION",
      "format 仅支持 qingml 或 pm",
      "读取文档时请移除 format，或改用 format=qingml / format=pm 后重试",
    );
  }
  const session = await getOrRestoreSessionForVersionedRead(sessionId);
  if (!session) {
    externalLog("read", { sessionId, ms: elapsed(startedAt), result: "rejected:SESSION_NOT_FOUND" });
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
  const state = deriveContentState(session);
  if (format === "pm") {
    const snapshot = await externalCanonicalDocumentSnapshot(session);
    externalLog("read", { sessionId, ms: elapsed(startedAt), result: "ok" });
    return c.json({
      sessionId,
      docVersion: snapshot.docVersion,
      contentHash: snapshot.contentHash,
      state: state.kind,
      agentBusy: sessionManager.isSessionBusy(sessionId),
      charCount: countDocVisibleChars(snapshot.pmDoc),
      title: session.title.trim() || deriveTitleFromDoc(snapshot.pmDoc),
      ts: snapshot.ts,
      pmDoc: snapshot.pmDoc,
    });
  }
  const markdown = session.doc ? pmToMarkdown(session.doc) : "";
  const title = session.title.trim() || deriveTitleFromDoc(session.doc);
  externalLog("read", { sessionId, ms: elapsed(startedAt), result: "ok" });
  return c.json({
    sessionId,
    docVersion: session.docVersion,
    state: state.kind,
    agentBusy: sessionManager.isSessionBusy(sessionId),
    charCount: countDocVisibleChars(session.doc ?? currentPmDoc(session)),
    markdown,
    ...(c.req.query("lines") === "1" ? { markdownWithLineNumbers: withLineNumbers(markdown) } : {}),
    ...(format === "qingml"
      ? { qingml: session.doc ? aiBlocksToQingml(pmToAiIr(session.doc).blocks) : "" }
      : {}),
    title,
  });
});

externalRoutes.get("/sessions/:id/export", async (c) => {
  const sessionId = c.req.param("id");
  const format = normalizeExportFormat(c.req.query("format"), false);
  if (!format) {
    return externalError(
      c,
      400,
      "VALIDATION",
      "导出格式不支持，仅支持 pdf、docx、html、markdown、txt",
      "把 format 改为 pdf、docx、html、markdown 或 txt 后重试",
    );
  }
  return exportDocumentResponse(c, {
    format,
    loadSource: async () => {
      const session = await getOrRestoreSessionForVersionedRead(sessionId);
      if (!session) return externalError(c, 404, "SESSION_NOT_FOUND");
      if (!session.doc || !hasCanonicalDoc(session)) {
        return externalError(
          c,
          409,
          "CONFLICT",
          "当前会话没有可导出的文档",
          "先写入文档内容，再重新导出",
        );
      }
      // 空稿闸:正文可见字与 external read 的 charCount 同源；同时放行导出器
      // 支持的媒体/结构块，避免纯图片、图表或表格文档被误判为空稿。
      if (!hasExportableDocContent(session.doc)) {
        return externalError(
          c,
          409,
          "CONFLICT",
          "还没有可导出的内容",
          "先写入文档内容，再重新导出",
        );
      }
      return {
        document: session.doc,
        title: session.title?.trim() || "青简导出",
      };
    },
    onFailure: (code) => externalExportFailure(c, code),
  });
});

externalRoutes.put("/sessions/:id/doc", async (c) => {
  const startedAt = Date.now();
  const sessionId = c.req.param("id");
  const body = await c.req.json().catch(() => null) as Partial<ExternalDocReplaceRequest> | null;
  const parsed = commandSchema.safeParse({
    kind: "updateDoc",
    data: {
      ...(body && typeof body === "object" ? body : {}),
      sessionId,
    },
  });
  if (!parsed.success || parsed.data.kind !== "updateDoc") {
    externalLog("doc_replace", {
      sessionId,
      ms: elapsed(startedAt),
      result: "rejected:VALIDATION",
    });
    return externalError(c, 400, "VALIDATION", "文档保存请求不合法");
  }
  if (!(await sessionExists(sessionId))) {
    externalLog("doc_replace", {
      sessionId,
      ms: elapsed(startedAt),
      result: "rejected:SESSION_NOT_FOUND",
    });
    return externalError(c, 404, "SESSION_NOT_FOUND");
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

  const write = frames
    .map((entry) => entry.frame)
    .find((frame) => frame.kind === "docWriteResult");
  if (!write || write.kind !== "docWriteResult") {
    return externalError(c, 400, "VALIDATION", "文档保存未产生有效回执");
  }
  if (write.data.ok) {
    const session = await getOrRestoreSessionReadOnly(sessionId);
    if (!session) return externalError(c, 404, "SESSION_NOT_FOUND");
    const snapshot = await externalCanonicalDocumentSnapshot(session);
    externalLog("doc_replace", { sessionId, ms: elapsed(startedAt), result: "committed" });
    return c.json({
      ok: true as const,
      clientMutationId: write.data.clientMutationId,
      docVersion: write.data.docVersion,
      contentHash: snapshot.contentHash,
      ts: snapshot.ts,
      charCount: countDocVisibleChars(snapshot.pmDoc),
    });
  }
  if ("conflict" in write.data) {
    const session = await getOrRestoreSessionReadOnly(sessionId);
    if (!session) return externalError(c, 404, "SESSION_NOT_FOUND");
    const snapshot = await externalCanonicalDocumentSnapshot(session);
    externalLog("doc_replace", {
      sessionId,
      ms: elapsed(startedAt),
      result: "rejected:VERSION_CONFLICT",
    });
    return c.json({
      ok: false as const,
      clientMutationId: write.data.clientMutationId,
      code: "VERSION_CONFLICT" as const,
      conflict: {
        expected: write.data.conflict.expectedDocumentSnapshot,
        actual: write.data.conflict.actualDocumentSnapshot,
      },
      actualContentHash: snapshot.contentHash,
    }, 409);
  }
  if (write.data.reason === "agent_busy") {
    return externalError(c, 409, "AGENT_BUSY");
  }
  if (write.data.reason === "not_editable") {
    return externalError(c, 409, "REVIEW_PENDING");
  }
  if (write.data.reason === "not_found") {
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
  return externalError(c, 400, "VALIDATION", "文档内容不合法");
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
  const format = c.req.query("format");
  if (format !== undefined && format !== "render-model") {
    return externalError(
      c,
      400,
      "VALIDATION",
      "format 仅支持 render-model",
      "读取审阅摘要时请移除 format，或改用 format=render-model",
    );
  }
  const session = await getOrRestoreSessionForVersionedRead(sessionId);
  if (!session) {
    externalLog("review_list", {
      sessionId,
      ms: elapsed(startedAt),
      result: "rejected:SESSION_NOT_FOUND",
    });
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
  if (format === "render-model") {
    const suggestions = [...session.suggestions.values()].map((record) =>
      structuredClone(record.suggestion)
    );
    externalLog("review_render_model", {
      sessionId,
      ms: elapsed(startedAt),
      result: "ok",
      patches: suggestions.length,
    });
    return c.json({
      sessionId,
      docVersion: session.docVersion,
      state: deriveContentState(session).kind,
      agentBusy: sessionManager.isSessionBusy(sessionId),
      baseVersion: session.suggestionBaseVersion ?? session.docVersion,
      suggestions,
      // render-model 同步携带批注组:插件面板的下划线/hover 卡以此为数据源(与无 format 列表分支同源)。
      annotations: session.annotationGroups.map(annotationForExternal),
      ...(isWholeDocumentSuggestionBatchId(suggestions[0]?.batchId)
        ? { wholeDocument: true }
        : {}),
      ...(session.suggestionBaseDoc
        ? { previewDoc: structuredClone(session.suggestionBaseDoc) }
        : {}),
      ...(session.docDraftCandidateDoc
        ? { editedDoc: structuredClone(session.docDraftCandidateDoc) }
        : {}),
    });
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
    agentBusy: sessionManager.isSessionBusy(sessionId),
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

externalRoutes.post("/sessions/:id/review/annotations", async (c) => {
  const startedAt = Date.now();
  const sessionId = c.req.param("id");
  const body = await c.req.json().catch(() => null) as
    Partial<ExternalAnnotationCreateRequest> | null;
  const parsedGroups = createAnnotationGroupsInputSchema.safeParse({
    groups: body?.groups,
  });
  if (
    !body
    || !isDocumentVersion(body.expectedDocVersion)
    || !isOptionalExternalTurnId(body.turnId)
    || !parsedGroups.success
  ) {
    externalLog("annotation_create", {
      sessionId,
      ms: elapsed(startedAt),
      result: "rejected:VALIDATION",
    });
    return externalError(
      c,
      400,
      "VALIDATION",
      "expectedDocVersion、turnId 或 groups 不合法",
    );
  }

  const request = body as ExternalAnnotationCreateRequest;
  const leaseOwner = externalLeaseOwnerForTurn(c, request.turnId);
  type AtomicResult =
    | { kind: "session_not_found" }
    | { kind: "agent_busy" }
    | { kind: "lock_lost" }
    | { kind: "version_conflict"; actual: number }
    | { kind: "no_document" }
    | { kind: "validation"; errors: string[] }
    | {
        kind: "created";
        docVersion: number;
        groups: AnnotationGroup[];
        groupCount: number;
        anchorCount: number;
      };
  const atomic = { result: { kind: "session_not_found" } as AtomicResult };
  let frames: LoggedFrame[];
  try {
    frames = await sessionManager.runExclusive(sessionId, async function* () {
      const session = await getOrRestoreSession(sessionId);
      if (!session) return;
      const leaseConflict = externalReviewLeaseConflict(session, leaseOwner);
      if (leaseConflict) {
        atomic.result = { kind: leaseConflict };
        return;
      }
      if (session.docVersion !== request.expectedDocVersion) {
        atomic.result = { kind: "version_conflict", actual: session.docVersion };
        return;
      }
      if (!session.doc || !hasCanonicalDoc(session)) {
        atomic.result = { kind: "no_document" };
        return;
      }
      const result = await writeAnnotationGroups({
        state: session,
        groups: parsedGroups.data.groups,
        forcedOrigin: EXTERNAL_PLUGIN_REVIEW_ORIGIN,
        replacementMode: "replace",
        atomic: true,
      });
      if (!result.ok) {
        atomic.result = { kind: "validation", errors: result.errors };
        return;
      }
      if (result.frame) yield result.frame;
      yield* emitProjectedDocState(session, "external_annotations_written");
      atomic.result = {
        kind: "created",
        docVersion: session.docVersion,
        groups: result.groups,
        groupCount: result.groupCount,
        anchorCount: result.anchorCount,
      };
    });
  } catch (error) {
    if (error instanceof SessionActorQueueFullError) {
      return externalError(c, 429, "RATE_LIMITED", "会话命令队列已满");
    }
    throw error;
  }

  const seq = maxSeq(frames);
  const result = atomic.result;
  if (result.kind === "session_not_found") {
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
  if (result.kind === "agent_busy") {
    return externalError(c, 409, "AGENT_BUSY");
  }
  if (result.kind === "lock_lost") {
    return externalError(c, 409, "LOCK_LOST");
  }
  if (result.kind === "version_conflict") {
    return reviewVersionConflict(c, request.expectedDocVersion, result.actual, seq);
  }
  if (result.kind === "no_document") {
    return externalError(
      c,
      409,
      "CONFLICT",
      "当前会话没有可批注的文档",
      "先写入文档内容，再创建批注",
    );
  }
  if (result.kind === "validation") {
    return externalError(
      c,
      400,
      "VALIDATION",
      result.errors.join("；") || "批注组未通过校验",
      "按错误中的逐字锚点要求修正 groups 后重试",
    );
  }

  externalLog("annotation_create", {
    sessionId,
    ms: elapsed(startedAt),
    result: "created",
    count: result.groupCount,
  });
  return c.json({
    status: "created" as const,
    docVersion: result.docVersion,
    annotations: result.groups.map(annotationForExternal),
    groupCount: result.groupCount,
    anchorCount: result.anchorCount,
    seq,
  });
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
    !isOptionalExternalTurnId(body.turnId) ||
    (body.verdict !== "accepted" && body.verdict !== "rejected")
  ) {
    externalLog("review_verdict", {
      sessionId,
      ms: elapsed(startedAt),
      result: "rejected:VALIDATION",
    });
    return externalError(c, 400, "VALIDATION", "expectedDocVersion、patchId、verdict 不合法");
  }
  const {
    expectedDocVersion,
    patchId,
    verdict,
    turnId,
  } = body as ExternalReviewVerdictRequest;
  const command: Command = verdict === "accepted"
    ? { kind: "acceptPatch", data: { id: patchId } }
    : { kind: "rejectPatch", data: { id: patchId } };
  const client = parseExternalClient(c.req.header("x-qa-client"));
  const modelOverrides = await resolveRequestModelOverrides({});
  const leaseOwner = externalLeaseOwnerForTurn(c, turnId);
  type AtomicResult =
    | { kind: "session_not_found" }
    | { kind: "agent_busy" }
    | { kind: "lock_lost" }
    | { kind: "version_conflict"; actual: number }
    | { kind: "no_pending_review" }
    | { kind: "patch_not_found" }
    | {
        kind: "marked";
        saved: boolean;
        docVersion: number;
        reviewingCount: number;
      };
  const atomic = {
    result: { kind: "session_not_found" } as AtomicResult,
  };
  let frames: LoggedFrame[];
  try {
    frames = await sessionManager.runExclusive(sessionId, async function* () {
      const session = await getOrRestoreSession(sessionId);
      if (!session) {
        atomic.result = { kind: "session_not_found" };
        return;
      }
      const leaseConflict = externalReviewLeaseConflict(session, leaseOwner);
      if (leaseConflict) {
        atomic.result = { kind: leaseConflict };
        return;
      }
      if (session.docVersion !== expectedDocVersion) {
        atomic.result = { kind: "version_conflict", actual: session.docVersion };
        return;
      }
      if (deriveContentState(session).kind !== "pendingReview" || session.suggestions.size === 0) {
        atomic.result = { kind: "no_pending_review" };
        return;
      }
      if (!session.suggestions.has(patchId)) {
        atomic.result = { kind: "patch_not_found" };
        return;
      }

      yield* handleCommand(
        command,
        undefined,
        "external",
        modelOverrides,
        client,
        sessionId,
        undefined,
        undefined,
        leaseOwner,
      );
      const updated = session.suggestions.get(patchId);
      atomic.result = {
        kind: "marked",
        saved: updated?.suggestion.status === verdict,
        docVersion: session.docVersion,
        reviewingCount: countReviewingPatches(session.suggestions.values()),
      };
    });
  } catch (error) {
    if (error instanceof SessionActorQueueFullError) {
      return externalError(c, 429, "RATE_LIMITED", "会话命令队列已满");
    }
    throw error;
  }
  const atomicResult = atomic.result;
  if (atomicResult.kind === "session_not_found") {
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
  if (atomicResult.kind === "agent_busy") {
    return externalError(c, 409, "AGENT_BUSY");
  }
  if (atomicResult.kind === "lock_lost") {
    return externalError(c, 409, "LOCK_LOST");
  }
  if (atomicResult.kind === "version_conflict") {
    return reviewVersionConflict(c, expectedDocVersion, atomicResult.actual, maxSeq(frames));
  }
  if (atomicResult.kind === "no_pending_review") {
    return externalError(
      c,
      409,
      "VALIDATION",
      "当前没有待审查修改",
      "用 `qa review list -s <id>` 对账；如已离开 pendingReview，直接继续后续工作",
    );
  }
  if (atomicResult.kind === "patch_not_found") {
    return externalError(
      c,
      404,
      "NOT_FOUND",
      "待审修改不存在",
      "用 `qa review list -s <id>` 重读待审修改列表",
    );
  }
  if (!atomicResult.saved) {
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
    verdict,
  });
  return c.json({
    status: "marked" as const,
    docVersion: atomicResult.docVersion,
    patchIds: [patchId],
    verdict,
    reviewingCount: atomicResult.reviewingCount,
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
    !isOptionalExternalTurnId(body.turnId) ||
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
  const request = body as ExternalReviewCommitRequest;
  const modelOverrides = await resolveRequestModelOverrides({});
  const client = parseExternalClient(c.req.header("x-qa-client"));
  const leaseOwner = externalLeaseOwnerForTurn(c, request.turnId);
  type AtomicResult =
    | { kind: "session_not_found" }
    | { kind: "agent_busy" }
    | { kind: "lock_lost" }
    | { kind: "version_conflict"; actual: number }
    | { kind: "no_pending_review" }
    | { kind: "incomplete" }
    | {
        kind: "reviewed";
        docVersion: number;
        remainingCount: number;
        outcome: ReviewOutcome;
      };
  const atomic = { result: { kind: "session_not_found" } as AtomicResult };
  let frames: LoggedFrame[];
  try {
    frames = await sessionManager.runExclusive(sessionId, async function* () {
      const session = await getOrRestoreSession(sessionId);
      if (!session) return;
      const leaseConflict = externalReviewLeaseConflict(session, leaseOwner);
      if (leaseConflict) {
        atomic.result = { kind: leaseConflict };
        return;
      }
      if (session.docVersion !== request.expectedDocVersion) {
        atomic.result = { kind: "version_conflict", actual: session.docVersion };
        return;
      }
      if (
        deriveContentState(session).kind !== "pendingReview"
        || session.suggestions.size === 0
      ) {
        atomic.result = { kind: "no_pending_review" };
        return;
      }
      const suggestions = [...session.suggestions.values()]
        .map((record) => record.suggestion);
      const decisions = reviewDecisions(suggestions, request.action);
      const outcome = reviewOutcome(suggestions, decisions.rejectedBatchIds);
      const command: Command = {
        kind: "commitReviewGroups",
        data: {
          acceptReviewBatchIds: decisions.acceptedBatchIds,
          rejectReviewBatchIds: decisions.rejectedBatchIds,
          keepPendingReviewBatchIds: [],
        },
      };
      yield* handleCommand(
        command,
        undefined,
        "external",
        modelOverrides,
        client,
        sessionId,
        undefined,
        undefined,
        leaseOwner,
      );
      if (session.suggestions.size > 0) {
        atomic.result = { kind: "incomplete" };
        return;
      }
      atomic.result = {
        kind: "reviewed",
        docVersion: session.docVersion,
        remainingCount: session.suggestions.size,
        outcome,
      };
    });
  } catch (error) {
    if (error instanceof SessionActorQueueFullError) {
      return externalError(c, 429, "RATE_LIMITED", "会话命令队列已满");
    }
    throw error;
  }
  const seq = maxSeq(frames);
  const atomicResult = atomic.result;
  if (atomicResult.kind === "session_not_found") {
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
  if (atomicResult.kind === "agent_busy") {
    return externalError(c, 409, "AGENT_BUSY");
  }
  if (atomicResult.kind === "lock_lost") {
    return externalError(c, 409, "LOCK_LOST");
  }
  if (atomicResult.kind === "version_conflict") {
    return reviewVersionConflict(
      c,
      request.expectedDocVersion,
      atomicResult.actual,
      seq,
    );
  }
  if (atomicResult.kind === "no_pending_review") {
    return externalError(
      c,
      409,
      "VALIDATION",
      "当前没有待审查修改",
      "用 `qa review list -s <id>` 对账；如已离开 pendingReview，直接继续后续工作",
    );
  }
  if (atomicResult.kind === "incomplete") {
    return externalError(
      c,
      409,
      "VALIDATION",
      "审查提交未完成，候选已保留",
      "用 `qa review list -s <id>` 查看冲突详情，重读文档后再决定",
    );
  }

  // external 的作者是外部模型；这里只做确定性审阅结算，不把裁决再投成用户消息
  // 启动青简模型续轮。内部 UI 仍可通过 submitReviewOutcome 保持原有交互语义。
  const outcomeQueued = false;
  externalLog("review_commit", {
    sessionId,
    ms: elapsed(startedAt),
    result: "reviewed",
    accepted: atomicResult.outcome.acceptedCount,
    rejected: atomicResult.outcome.rejectedCount,
  });
  return c.json({
    status: "reviewed" as const,
    docVersion: atomicResult.docVersion,
    acceptedCount: atomicResult.outcome.acceptedCount,
    rejectedCount: atomicResult.outcome.rejectedCount,
    remainingCount: atomicResult.remainingCount,
    outcomeQueued,
    outcome: atomicResult.outcome,
    seq,
  });
});

externalRoutes.post("/sessions/:id/review/annotations/ignore", async (c) => {
  const startedAt = Date.now();
  const sessionId = c.req.param("id");
  const body = await c.req.json().catch(() => null) as
    Partial<ExternalAnnotationIgnoreRequest> | null;
  if (
    !body ||
    !isDocumentVersion(body.expectedDocVersion) ||
    !isOptionalExternalTurnId(body.turnId) ||
    !Array.isArray(body.annotationIds) ||
    body.annotationIds.length === 0 ||
    body.annotationIds.some((id) => typeof id !== "string" || id.length === 0)
  ) {
    externalLog("annotation_ignore", {
      sessionId,
      ms: elapsed(startedAt),
      result: "rejected:VALIDATION",
    });
    return externalError(c, 400, "VALIDATION", "expectedDocVersion 或 annotationIds 不合法");
  }
  const request = body as ExternalAnnotationIgnoreRequest;
  const annotationIds = [...new Set(body.annotationIds as string[])];
  const parsed = commandSchema.safeParse({
    kind: "ignoreAnnotationGroups",
    data: {
      sessionId,
      reason: "item_ignored",
      groupIds: annotationIds,
    },
  });
  if (!parsed.success || parsed.data.kind !== "ignoreAnnotationGroups") {
    return externalError(c, 400, "VALIDATION", "批注忽略请求不合法");
  }
  const client = parseExternalClient(c.req.header("x-qa-client"));
  const modelOverrides = await resolveRequestModelOverrides({});
  const leaseOwner = externalLeaseOwnerForTurn(c, request.turnId);
  type AtomicResult =
    | { kind: "session_not_found" }
    | { kind: "agent_busy" }
    | { kind: "lock_lost" }
    | { kind: "version_conflict"; actual: number }
    | { kind: "annotation_not_found" }
    | { kind: "ignored"; remainingAnnotationCount: number };
  const atomic = { result: { kind: "session_not_found" } as AtomicResult };
  let frames: LoggedFrame[];
  try {
    frames = await sessionManager.runExclusive(sessionId, async function* () {
      const session = await getOrRestoreSession(sessionId);
      if (!session) return;
      const leaseConflict = externalReviewLeaseConflict(session, leaseOwner);
      if (leaseConflict) {
        atomic.result = { kind: leaseConflict };
        return;
      }
      if (session.docVersion !== request.expectedDocVersion) {
        atomic.result = { kind: "version_conflict", actual: session.docVersion };
        return;
      }
      const existingIds = new Set(
        session.annotationGroups.map((group) => group.id),
      );
      if (annotationIds.some((id) => !existingIds.has(id))) {
        atomic.result = { kind: "annotation_not_found" };
        return;
      }
      yield* handleCommand(
        parsed.data,
        undefined,
        "external",
        modelOverrides,
        client,
        sessionId,
        undefined,
        undefined,
        leaseOwner,
      );
      atomic.result = {
        kind: "ignored",
        remainingAnnotationCount: session.annotationGroups.filter(
          (group) => group.status === "reviewing",
        ).length,
      };
    });
  } catch (error) {
    if (error instanceof SessionActorQueueFullError) {
      return externalError(c, 429, "RATE_LIMITED", "会话命令队列已满");
    }
    throw error;
  }
  const seq = maxSeq(frames);
  const atomicResult = atomic.result;
  if (atomicResult.kind === "session_not_found") {
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
  if (atomicResult.kind === "agent_busy") {
    return externalError(c, 409, "AGENT_BUSY");
  }
  if (atomicResult.kind === "lock_lost") {
    return externalError(c, 409, "LOCK_LOST");
  }
  if (atomicResult.kind === "version_conflict") {
    return reviewVersionConflict(
      c,
      request.expectedDocVersion,
      atomicResult.actual,
      seq,
    );
  }
  if (atomicResult.kind === "annotation_not_found") {
    return externalError(
      c,
      404,
      "NOT_FOUND",
      "批注不存在",
      "用 `qa review list -s <id>` 重读批注列表",
    );
  }
  externalLog("annotation_ignore", {
    sessionId,
    ms: elapsed(startedAt),
    result: "ignored",
    count: annotationIds.length,
  });
  return c.json({
    status: "ignored" as const,
    annotationIds,
    remainingAnnotationCount: atomicResult.remainingAnnotationCount,
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
  const limit = parsePositiveQueryInteger(c.req.query("limit"));
  if (!limit.ok) {
    externalLog("chatlog", { sessionId, ms: elapsed(startedAt), result: "rejected:VALIDATION" });
    return externalError(c, 400, "VALIDATION", "limit 必须是正整数");
  }
  const messages = applyLimit(session.chatHistory, limit.value).map((message) => ({
    id: message.id,
    role: message.role,
    ts: message.ts,
    text: message.parts.map(partText).filter(Boolean).join("\n"),
  }));
  externalLog("chatlog", { sessionId, ms: elapsed(startedAt), result: "ok", count: messages.length });
  return c.json({ sessionId, messages });
});

externalRoutes.post(
  "/sessions/:id/assets",
  bodyLimit({
    maxSize: externalAssetMaxRequestBytes,
    onError: (c) => externalError(
      c,
      413,
      "VALIDATION",
      "图片超过上传上限",
      `请选择不超过 ${externalAssetMaxBytes} 字节的图片后重试`,
    ),
  }),
  async (c) => {
    const sessionId = c.req.param("id");
    const session = await getOrRestoreSessionReadOnly(sessionId);
    if (!session) return externalError(c, 404, "SESSION_NOT_FOUND");

    const contentType = c.req.header("content-type") ?? "";
    let parsed: ExternalAssetUploadInputResult;
    if (contentType.toLowerCase().includes("multipart/form-data")) {
      const form = await c.req.parseBody().catch(() => null);
      const file = form?.file;
      if (!(file instanceof File)) {
        return externalAssetInputError(c, "invalid_body");
      }
      parsed = validateExternalAssetUploadInput(
        {
          filename: file.name,
          mimeType: file.type,
          buffer: Buffer.from(await file.arrayBuffer()),
        },
        externalAssetMaxBytes,
      );
    } else if (contentType.toLowerCase().includes("application/json")) {
      const body = await c.req.json().catch(() => null);
      parsed = parseExternalAssetJson(body, externalAssetMaxBytes);
    } else {
      return externalError(
        c,
        400,
        "VALIDATION",
        "资产上传仅支持 multipart/form-data 或 application/json",
        "multipart 请使用 file 字段；JSON 请传 filename、mimeType、base64",
      );
    }
    if (!parsed.ok) return externalAssetInputError(c, parsed.error);

    let stored: Awaited<ReturnType<typeof findOrStoreUploadedFile>>;
    try {
      stored = await findOrStoreUploadedFile(parsed.input);
    } catch (error) {
      if (error instanceof Error && error.message === "invalid filename") {
        return externalAssetInputError(c, "invalid_filename");
      }
      throw error;
    }
    try {
      await registerSessionResource({
        sessionId,
        resourceId: stored.record.fileId,
        kind: "upload",
      });
    } catch (error) {
      await deleteUploadedFile(stored.record.fileId);
      throw error;
    }

    const { fileId, filename, size } = stored.record;
    const mimeType = stored.record.mimeType ?? parsed.input.mimeType;
    return c.json({
      fileId,
      filename,
      mimeType,
      size,
      src: `/api/v1/files/${encodeURIComponent(fileId)}/${encodeURIComponent(filename)}`,
    });
  },
);

externalRoutes.get("/sessions/:id/assets/:ref", async (c) => {
  const sessionId = c.req.param("id");
  if (!(await getOrRestoreSessionReadOnly(sessionId))) {
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
  const fileId = c.req.param("ref");
  if (!isValidUploadId(fileId)) {
    return externalError(c, 400, "VALIDATION", "资产引用不合法");
  }
  const owned = (await listSessionResources(sessionId)).some(
    (resource) => resource.resourceId === fileId,
  );
  if (!owned) return externalError(c, 404, "NOT_FOUND", "ASSET_NOT_FOUND");

  const resolved = await resolveUploadedFileForRead(fileId);
  if (!resolved.ok) {
    return externalError(c, 404, "NOT_FOUND", "ASSET_NOT_FOUND");
  }
  return streamResolvedUploadedFile(c, resolved.file);
});

function externalAssetInputError(c: Context, error: ExternalAssetUploadInputError) {
  switch (error) {
    case "file_too_large":
      return externalError(
        c,
        413,
        "VALIDATION",
        "图片超过上传上限",
        `请选择不超过 ${externalAssetMaxBytes} 字节的图片后重试`,
      );
    case "invalid_filename":
      return externalError(c, 400, "VALIDATION", "图片文件名不合法");
    case "invalid_base64":
      return externalError(c, 400, "VALIDATION", "base64 图片数据不合法");
    case "empty_file":
      return externalError(c, 400, "VALIDATION", "图片内容不能为空");
    case "unsupported_media":
      return externalError(c, 400, "VALIDATION", "仅支持图片资产");
    case "invalid_body":
      return externalError(c, 400, "VALIDATION", "资产上传请求不合法");
  }
}

function externalExportFailure(c: Context, code: ExportFailureCode): Response {
  switch (code) {
    case "BROWSER_CAPABILITY_UNAVAILABLE":
      return externalError(
        c,
        503,
        code,
        "当前部署环境无法安全启动浏览器，PDF 导出能力不可用",
      );
    case "EXPORT_BUSY":
      c.header("Retry-After", "5");
      return externalError(c, 503, code, "当前导出任务较多，请稍后重试");
    case "EXPORT_DEADLINE_EXCEEDED":
      return externalError(c, 504, code, "导出渲染超时，请重试");
    case "EXPORT_RENDER_FAILED":
      return externalError(c, 500, code, "导出失败，请重试");
  }
}

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
  const principalId = externalLeasePrincipalId(c);
  let frames: LoggedFrame[];
  try {
    frames = await sessionManager.submit(sessionId, {
      command: parsed.data,
      origin: "external",
      client,
      modelOverrides: await resolveRequestModelOverrides({}),
      ...(principalId && parsed.data.data.turnId
        ? {
            externalLeaseOwner: {
              principalId,
              turnId: parsed.data.data.turnId,
            },
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof SessionActorQueueFullError) {
      return externalError(c, 429, "RATE_LIMITED", "会话命令队列已满");
    }
    throw error;
  }
  const responseSession = await getOrRestoreSessionReadOnly(sessionId);
  const summary = proposalSummary(frames, responseSession);
  externalLog("propose", { sessionId, ms: elapsed(startedAt), result: summary.logResult, hunks: summary.hunks });
  return proposalResponse(c, summary);
});

function externalLeasePrincipalId(c: Context): string | null {
  const principal = getRequestPrincipal(c);
  if (principal.kind === "externalInstance") {
    return `external:${principal.instanceId}`;
  }
  if (principal.kind === "attachSession") {
    return `attach:${principal.session.id}`;
  }
  return null;
}

function isOptionalExternalTurnId(value: unknown): value is string | undefined {
  return value === undefined || (
    typeof value === "string"
    && value.trim().length > 0
    && value.length <= MAX_EXTERNAL_TURN_ID_LENGTH
  );
}

function externalLeaseOwnerForTurn(
  c: Context,
  turnId: string | undefined,
): ExternalLeaseOwner | undefined {
  if (!turnId) return undefined;
  const principalId = externalLeasePrincipalId(c);
  return principalId ? { principalId, turnId } : undefined;
}

function externalReviewLeaseConflict(
  session: SessionState,
  owner: ExternalLeaseOwner | undefined,
): "agent_busy" | "lock_lost" | null {
  const holderOwnsLease = isExternalBusyLeaseHolder(session, owner);
  if (owner && !holderOwnsLease) return "lock_lost";
  const holderOwnsOnlyBusyLease = session.streamId === null && holderOwnsLease;
  return (
    (deriveAgentBusy(session) && !holderOwnsOnlyBusyLease)
    || deriveActiveOverlay(session) !== null
  )
    ? "agent_busy"
    : null;
}

function parseExternalClient(value: string | undefined): ExternalClient {
  if (value === "claudecode" || value === "codex" || value === "deepseek") return value;
  // Codex 已并入统一 ChatGPT:新客户端报 chatgpt,wire 归一到既有 codex 词元。
  if (value === "chatgpt") return "codex";
  return "agent";
}

externalRoutes.post("/sessions/:id/chat", async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req.json().catch(() => null) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim()) {
    return externalError(c, 400, "VALIDATION", "缺少 text");
  }
  return queueExternalChat(c, { sessionId, text });
});

externalRoutes.get("/sessions/:id/events", async (c) => {
  const sessionId = c.req.param("id");
  if (!sessionManager.frameLog.hasSession(sessionId) && !(await sessionExists(sessionId))) {
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
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
        allowOversized: allowOversizedSseFrame(entry.frame),
      });
    };
    try {
      unsubscribe = sessionManager.frameLog.subscribe(sessionId, afterSeq, enqueue);
      if (cleaned) {
        unsubscribe();
      }
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

function proposalSummary(entries: LoggedFrame[], session: SessionState | null = null): ProposalSummary {
  const frames = entries.map((entry) => entry.frame);
  const seq = maxSeq(entries);
  const notices = frames.flatMap((frame) =>
    frame.kind === "sessionMeta" && frame.data.notice?.kind === "title_truncated"
      ? [{
          code: "TITLE_TRUNCATED" as const,
          message: `标题超过 ${frame.data.notice.maxChars} 个字符，已截断`,
          maxChars: frame.data.notice.maxChars,
        }]
      : []
  );
  const diff = frames.find((frame) => frame.kind === "docDiffReady");
  if (diff?.kind === "docDiffReady") {
    const patchIds = diff.data.suggestions.map((suggestion) => suggestion.id);
    const responseDoc = diff.data.editedDoc
      ?? session?.docDraftCandidateDoc
      ?? (session ? currentPmDoc(session) : null);
    const charCount = responseDoc ? countDocVisibleChars(responseDoc) : 0;
    return {
      status: 200,
      body: withSeq({
        status: "review",
        patchIds,
        count: patchIds.length,
        charCount,
        ...(notices.length > 0 ? { notices } : {}),
      }, seq),
      logResult: "review",
      hunks: patchIds.length,
      seq,
    };
  }
  const write = frames.find((frame) => frame.kind === "docWriteResult");
  if (write?.kind === "docWriteResult") {
    if (write.data.ok) {
      const charCount = session ? countDocVisibleChars(currentPmDoc(session)) : 0;
      return {
        status: 200,
        body: withSeq({
          status: "committed",
          docVersion: write.data.docVersion,
          charCount,
          ...(notices.length > 0 ? { notices } : {}),
        }, seq),
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
    if (write.data.reason === "lock_lost") return errorSummary(409, "LOCK_LOST", undefined, seq);
    if (write.data.reason === "not_editable") return errorSummary(409, "REVIEW_PENDING", undefined, seq);
    if (write.data.reason === "not_found") return errorSummary(404, "SESSION_NOT_FOUND", undefined, seq);
    return errorSummary(
      400,
      "VALIDATION",
      write.data.diagnostic
        ? "QingML 校验失败，请根据诊断修正后重试"
        : write.data.validationMessage ?? "未命中,请重读文档",
      seq,
      write.data.diagnostic,
    );
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
  diagnostic?: WriteDraftFailureDiagnostic,
): ProposalSummary {
  return {
    status,
    body: withSeq({
      error: message ?? code,
      code,
      nextStep: EXTERNAL_NEXT_STEP[code],
      ...(diagnostic ? { diagnostic: projectExternalValidationDiagnostic(diagnostic) } : {}),
    }, seq),
    logResult: `rejected:${code}`,
    hunks: 0,
    seq,
  };
}

function projectExternalValidationDiagnostic(
  diagnostic: WriteDraftFailureDiagnostic,
): ExternalValidationDiagnostic {
  return {
    failureKind: diagnostic.failureKind,
    warningKinds: [...diagnostic.warningKinds],
    tagSkeleton: diagnostic.tagSkeleton,
    errorLocations: diagnostic.errorLocations.map((location) => ({
      kind: location.kind,
      ...(location.startOffset === undefined ? {} : { startOffset: location.startOffset }),
      ...(location.endOffset === undefined ? {} : { endOffset: location.endOffset }),
      ...(location.path === undefined ? {} : { path: [...location.path] }),
    })),
  } satisfies ExternalValidationDiagnostic;
}

function maxSeq(entries: LoggedFrame[]): number | null {
  return entries.reduce<number | null>((max, entry) => max === null ? entry.seq : Math.max(max, entry.seq), null);
}

function withSeq<T extends Record<string, unknown>>(body: T, seq: number | null): T & { seq?: number } {
  return seq === null ? body : { ...body, seq };
}

const EXTERNAL_FRAME_KIND_ALLOWLIST = {
  restoreReset: true,
  "turn-rejected": true,
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
    data: COMPLETE_EXTERNAL_DOCUMENT_FRAME_KINDS.has(entry.frame.kind)
      ? structuredClone(entry.frame.data)
      : dataForExternal(entry.frame.data),
  } as ExternalBridgeFrame;
}

const COMPLETE_EXTERNAL_DOCUMENT_FRAME_KINDS: ReadonlySet<BridgeFrame["kind"]> = new Set([
  "docGenerationEvent",
  "documentSnapshotWritten",
  "docCommitted",
  "docDiffReady",
  "docWriteResult",
  "docStateChanged",
]);

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

function applyLimit(messages: ChatMessage[], limit: number | undefined): ChatMessage[] {
  return limit === undefined ? messages : messages.slice(-limit);
}

function parsePositiveQueryInteger(
  value: string | undefined,
): { ok: true; value: number | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return { ok: false };
  return { ok: true, value: parsed };
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
    parseState: material.metadata.parseState,
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

async function externalCanonicalDocumentSnapshot(session: SessionState): Promise<{
  docVersion: number;
  contentHash: string;
  ts: string;
  pmDoc: ReturnType<typeof currentPmDoc>;
}> {
  const row = await documentRepo.load(session.docId);
  const usePersisted = row?.pmDoc && row.docVersion >= session.docVersion;
  const pmDoc = usePersisted ? row.pmDoc! : currentPmDoc(session);
  return {
    docVersion: usePersisted ? row.docVersion : session.docVersion,
    contentHash: usePersisted && row.contentHash
      ? row.contentHash
      : getPmContentHash(pmDoc),
    ts: usePersisted
      ? row.updatedAt
      : session.lastContentEditedAt ?? row?.updatedAt ?? new Date(0).toISOString(),
    pmDoc,
  };
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
    | "doc_replace"
    | "health"
    | "sessions"
    | "review_list"
    | "review_render_model"
    | "review_show"
    | "review_verdict"
    | "review_commit"
    | "annotation_create"
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

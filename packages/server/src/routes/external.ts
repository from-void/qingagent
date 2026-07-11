import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { BridgeFrame, ChatMessage, Command, ContentDocState, FolderSourceRecord, MessagePart } from "@qingagent/contract-ts";
import { commandSchema } from "@qingagent/contract-ts/schemas";
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
import { getOrRestoreSession, sessionManager } from "../bridge/bridgeHandler";
import type { LoggedFrame } from "../bridge/frameLog";
import type { Material } from "@qingagent/core";

export const externalRoutes = new Hono();

type ExternalClient = "claudecode" | "codex" | "agent";

type ExternalErrorCode =
  | "AUTH_FAILED"
  | "AGENT_BUSY"
  | "REVIEW_PENDING"
  | "VERSION_CONFLICT"
  | "VALIDATION"
  | "NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "MATERIAL_NOT_FOUND"
  | "RATE_LIMITED";

const DEFAULT_MATERIAL_TEXT_MAX_BYTES = 200_000;

const NEXT_STEP: Record<ExternalErrorCode, string> = {
  REVIEW_PENDING: "青简里有待处理的修改建议,请先采纳或拒绝;然后用 `qa doc events --follow` 等 docCommitted 再继续",
  AGENT_BUSY: "青简 agent 正在干活,稍等重试一次;仍忙则告知用户并等 events",
  VERSION_CONFLICT: "文档已被改过,请 `qa doc read` 重读,基于新版本重做提案,绝不原样重发",
  AUTH_FAILED: "实例没了/重启了,重新 `qa status` 感应;还不行请告诉用户打开青简",
  NOT_FOUND: "实例没了/重启了,重新 `qa status` 感应;还不行请告诉用户打开青简",
  SESSION_NOT_FOUND: "会话不存在,用 `qa sessions list` 重新对号,不要重试原 id",
  MATERIAL_NOT_FOUND: "材料不存在,用 `qa files list` 重新对号,不要重试原 id",
  VALIDATION: "提案不合法(空文档只能 fullDraft / 已有文档禁整篇覆写 / 未命中 / 超 50 处),按提示改",
  RATE_LIMITED: "请求太频繁,请降低读取频率并优先使用 `qa doc events --follow`",
};

const readBuckets = new Map<string, { windowStart: number; count: number }>();

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
  const { rows } = await documentRepo.list({ resourceId: QINGAGENT_RESOURCE_ID, page: 0, perPage: 50 });
  const byId = new Map<string, { id: string; title: string; state: ContentDocState["kind"]; updatedAt: string }>();
  for (const row of rows) {
    if (!await getOrRestoreSession(row.id)) continue;
    byId.set(row.id, {
      id: row.id,
      title: row.title || "未命名草稿",
      state: stateFromDocRow(row.docState),
      updatedAt: row.updatedAt,
    });
  }
  for (const sessionId of sessionManager.listSessionIds(50)) {
    const session = await getOrRestoreSession(sessionId);
    if (!session) continue;
    byId.set(session.sessionId, {
      id: session.sessionId,
      title: session.title || "未命名草稿",
      state: deriveContentState(session).kind,
      updatedAt: new Date().toISOString(),
    });
  }
  const sessions = [...byId.values()];
  externalLog("sessions", { ms: elapsed(startedAt), result: "ok", count: sessions.length });
  return c.json({
    sessions,
  });
});

externalRoutes.post("/sessions", async (c) => {
  const startedAt = Date.now();
  const sessionId = crypto.randomUUID();
  const command: Command = {
    kind: "startSession",
    data: { mode: { kind: "new", data: { template: null, sessionId } } },
  };
  const frames = await sessionManager.submit(sessionId, { command, origin: "external" });
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
  const session = await getOrRestoreSession(sessionId);
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

externalRoutes.get("/sessions/:id/chat", async (c) => {
  const startedAt = Date.now();
  const limited = rateLimit(c);
  if (limited) {
    externalLog("chatlog", { sessionId: c.req.param("id"), ms: elapsed(startedAt), result: "rejected:RATE_LIMITED" });
    return limited;
  }
  const sessionId = c.req.param("id");
  const session = await getOrRestoreSession(sessionId);
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
  const session = await getOrRestoreSession(sessionId);
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
  const session = await getOrRestoreSession(sessionId);
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
  const frames = await sessionManager.submit(sessionId, { command: parsed.data, origin: "external", client });
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
  const command: Command = {
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
  };
  void sessionManager.submit(sessionId, { command, origin: "external" }).catch(() => {
    console.warn(`[external] evt=chat session=${sessionId} result=async_failed`);
  });
  externalLog("chat", { sessionId, ms: elapsed(startedAt), result: "queued" });
  return c.json({ queued: true, note: "已入队,执行结果以 events 为准" });
});

externalRoutes.get("/sessions/:id/events", (c) => {
  const sessionId = c.req.param("id");
  const afterParam = c.req.query("after");
  return streamSSE(c, async (stream) => {
    const afterSeq = afterParam === "tip"
      ? Math.max(0, sessionManager.frameLog.readFrom(sessionId, 0).nextSeq - 1)
      : parseSeq(afterParam);
    let writeChain = Promise.resolve();
    const meta = sessionManager.frameLog.readFrom(sessionId, afterSeq);
    await stream.writeSSE({
      event: "meta",
      data: JSON.stringify({
        epoch: meta.epoch,
        minSeq: meta.minSeq,
        nextSeq: meta.nextSeq,
        gap: meta.gap,
      }),
    });
    const enqueue = (entry: LoggedFrame) => {
      writeChain = writeChain.then(() =>
        stream.writeSSE({
          id: String(entry.seq),
          event: "frame",
          data: JSON.stringify(frameForExternal(entry)),
        }),
      ).catch(() => undefined);
      return writeChain;
    };
    const unsubscribe = sessionManager.frameLog.subscribe(sessionId, afterSeq, (entry) => {
      void enqueue(entry);
    });
    await new Promise<void>((resolve) => {
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "{}" }).catch(() => undefined);
      }, 15_000);
      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
        resolve();
      });
    });
    await writeChain;
  });
});

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
          nextStep: NEXT_STEP.VERSION_CONFLICT,
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
    body: withSeq({ error: message ?? code, code, nextStep: NEXT_STEP[code] }, seq),
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

function frameForExternal(entry: LoggedFrame): { seq: number; kind: BridgeFrame["kind"]; data: unknown } {
  return { seq: entry.seq, kind: entry.frame.kind, data: entry.frame.data };
}

function externalError(
  c: Context,
  status: 400 | 401 | 404 | 409 | 429,
  code: ExternalErrorCode,
  message?: string,
) {
  return c.json({ error: message ?? code, code, nextStep: NEXT_STEP[code] }, status);
}

function rateLimit(c: Context) {
  const key = c.req.path;
  const now = Date.now();
  if (readBuckets.size > 1_000) {
    for (const [bucketKey, bucket] of readBuckets) {
      if (now - bucket.windowStart >= 1000) readBuckets.delete(bucketKey);
    }
  }
  const bucket = readBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= 1000) {
    readBuckets.set(key, { windowStart: now, count: 1 });
    return null;
  }
  bucket.count += 1;
  if (bucket.count > 5) return externalError(c, 429, "RATE_LIMITED");
  return null;
}

function parseSeq(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function stateFromDocRow(docState: string): ContentDocState["kind"] {
  if (docState === "pendingReview") return "pendingReview";
  if (docState === "empty") return "empty";
  return "editing";
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
    case "toolCall":
      return "[工具调用]";
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

function externalLog(
  evt: "propose" | "chat" | "chatlog" | "files" | "read" | "health" | "sessions",
  fields: { sessionId?: string; ms: number; result: string; hunks?: number; count?: number },
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
  console.info(parts.join(" "));
}

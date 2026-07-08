import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { BridgeFrame, Command, ContentDocState } from "@qingagent/contract-ts";
import { commandSchema } from "@qingagent/contract-ts/schemas";
import {
  deriveActiveOverlay,
  deriveAgentBusy,
  deriveContentState,
  documentRepo,
  QINGAGENT_RESOURCE_ID,
} from "@qingagent/core";
import { pmToMarkdown } from "@qingagent/pm-schema";
import crypto from "node:crypto";
import { getExternalInstancePublicInfo } from "../lib/externalInstance";
import { getOrRestoreSession, sessionManager } from "../bridge/bridgeHandler";
import type { LoggedFrame } from "../bridge/frameLog";

export const externalRoutes = new Hono();

type ExternalErrorCode =
  | "AUTH_FAILED"
  | "AGENT_BUSY"
  | "REVIEW_PENDING"
  | "VERSION_CONFLICT"
  | "VALIDATION"
  | "NOT_FOUND"
  | "RATE_LIMITED";

const NEXT_STEP: Record<ExternalErrorCode, string> = {
  REVIEW_PENDING: "清简里有待处理的修改建议,请先采纳或拒绝;然后用 `qa doc events --follow` 等 docCommitted 再继续",
  AGENT_BUSY: "清简 agent 正在干活,稍等重试一次;仍忙则告知用户并等 events",
  VERSION_CONFLICT: "文档已被改过,请 `qa doc read` 重读,基于新版本重做提案,绝不原样重发",
  AUTH_FAILED: "实例没了/重启了,重新 `qa status` 感应;还不行请告诉用户打开清简",
  NOT_FOUND: "实例没了/重启了,重新 `qa status` 感应;还不行请告诉用户打开清简",
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
  externalLog("sessions", { ms: elapsed(startedAt), result: "ok", count: rows.length });
  return c.json({
    sessions: rows.map((row) => ({
      id: row.id,
      title: row.title || "未命名草稿",
      state: stateFromDocRow(row.docState),
      updatedAt: row.updatedAt,
    })),
  });
});

externalRoutes.post("/sessions", async (c) => {
  const startedAt = Date.now();
  const body = await c.req.json().catch(() => ({})) as { title?: unknown };
  const sessionId = crypto.randomUUID();
  const command: Command = {
    kind: "startSession",
    data: { mode: { kind: "new", data: { template: null, sessionId } } },
  };
  const frames = await sessionManager.submit(sessionId, { command, origin: "external" });
  const meta = frames.map((entry) => entry.frame).find((frame) => frame.kind === "sessionMeta");
  externalLog("sessions", { sessionId, ms: elapsed(startedAt), result: "created" });
  return c.json({
    sessionId,
    title: meta?.kind === "sessionMeta" ? meta.data.title : typeof body.title === "string" ? body.title : "未命名草稿",
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
    externalLog("read", { sessionId, ms: elapsed(startedAt), result: "rejected:NOT_FOUND" });
    return externalError(c, 404, "NOT_FOUND");
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

externalRoutes.post("/sessions/:id/proposals", async (c) => {
  const startedAt = Date.now();
  const sessionId = c.req.param("id");
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
  const frames = await sessionManager.submit(sessionId, { command: parsed.data, origin: "external" });
  const summary = proposalSummary(frames);
  externalLog("propose", { sessionId, ms: elapsed(startedAt), result: summary.logResult, hunks: summary.hunks });
  return proposalResponse(c, summary);
});

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
    externalLog("chat", { sessionId, ms: elapsed(startedAt), result: "rejected:NOT_FOUND" });
    return externalError(c, 404, "NOT_FOUND");
  }
  const command: Command = {
    kind: "sendMessage",
    data: {
      sessionId,
      text,
      mentions: [],
      skills: [],
      chips: [],
      fileIds: [],
      clientMessageId: `external-${crypto.randomUUID()}`,
    },
  };
  void sessionManager.submit(sessionId, { command, origin: "external" }).catch(() => {
    console.warn(`[external] evt=chat session=${sessionId} result=async_failed`);
  });
  externalLog("chat", { sessionId, ms: elapsed(startedAt), result: "accepted" });
  return c.json({ accepted: true });
});

externalRoutes.get("/sessions/:id/events", (c) => {
  const sessionId = c.req.param("id");
  const afterSeq = parseSeq(c.req.query("after"));
  return streamSSE(c, async (stream) => {
    let writeChain = Promise.resolve();
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
    for (const entry of sessionManager.frameLog.readFrom(sessionId, afterSeq).frames) {
      await enqueue(entry);
    }
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
}

function proposalSummary(entries: LoggedFrame[]): ProposalSummary {
  const frames = entries.map((entry) => entry.frame);
  const diff = frames.find((frame) => frame.kind === "docDiffReady");
  if (diff?.kind === "docDiffReady") {
    const patchIds = diff.data.suggestions.map((suggestion) => suggestion.id);
    return {
      status: 200,
      body: { status: "review", patchIds, count: patchIds.length },
      logResult: "review",
      hunks: patchIds.length,
    };
  }
  const write = frames.find((frame) => frame.kind === "docWriteResult");
  if (write?.kind === "docWriteResult") {
    if (write.data.ok) {
      return {
        status: 200,
        body: { status: "committed", docVersion: write.data.docVersion },
        logResult: "committed",
        hunks: 0,
      };
    }
    if ("conflict" in write.data) {
      return {
        status: 409,
        body: {
          code: "VERSION_CONFLICT",
          expected: write.data.conflict.expectedDocumentSnapshot,
          actual: write.data.conflict.actualDocumentSnapshot,
          nextStep: NEXT_STEP.VERSION_CONFLICT,
        },
        logResult: "rejected:VERSION_CONFLICT",
        hunks: 0,
      };
    }
    if (write.data.reason === "agent_busy") return errorSummary(409, "AGENT_BUSY");
    if (write.data.reason === "not_editable") return errorSummary(409, "REVIEW_PENDING");
    if (write.data.reason === "not_found") return errorSummary(404, "NOT_FOUND");
    return errorSummary(400, "VALIDATION", "未命中,请重读文档");
  }
  return errorSummary(400, "VALIDATION", "提案未产生有效变更");
}

function proposalResponse(c: Context, summary: ProposalSummary) {
  return c.json(summary.body, summary.status);
}

function errorSummary(
  status: 400 | 404 | 409,
  code: ExternalErrorCode,
  message?: string,
): ProposalSummary {
  return {
    status,
    body: { error: message ?? code, code, nextStep: NEXT_STEP[code] },
    logResult: `rejected:${code}`,
    hunks: 0,
  };
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

function elapsed(startedAt: number): number {
  return Date.now() - startedAt;
}

function externalLog(
  evt: "propose" | "chat" | "read" | "health" | "sessions",
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

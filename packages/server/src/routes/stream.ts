import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type {
  BridgeFrame,
  Command,
  CommandFailedResponse,
} from "@qingagent/contract-ts";
import { safeParsePmDoc } from "@qingagent/pm-schema";
import {
  parseOrigin,
  resolveCommandSessionId,
  sessionManager,
  collectRestoreFrames,
  sessionExists,
} from "../gateway/bridgeHandler";
import type { LoggedFrame } from "../gateway/frameLog";
import { SessionActorCommandError, SessionActorQueueFullError } from "../gateway/sessionActor";
import {
  SessionDeletedError,
  SessionDeletionInProgressError,
} from "../gateway/sessionErrors";
import {
  commandSchema,
  MAX_COMMAND_ARRAY_LENGTH,
  MAX_COMMAND_STRING_LENGTH,
} from "@qingagent/contract-ts/schemas";
import { resolveRequestModelOverrides } from "../modelOverridesProvider";
import { requireTrustedOrigin } from "../lib/trustedOrigin";
import {
  firstValidationIssueMessage,
  formatCommandError,
  parseBody,
} from "../lib/validation";
import { BoundedSsePump } from "../lib/boundedSsePump";
import {
  allowOversizedSseFrame,
  terminalDocumentFrameFields,
} from "../lib/terminalDocumentFrame";
import { requestClientAddress, sseAdmission } from "../lib/sseAdmission";
import {
  clientMessageIdempotency,
  normalizeIdempotencyClientMessageId,
  type ClientMessageClaimResult,
} from "../gateway/clientMessageIdempotency";

const PUBLIC_STREAM_ERROR_REASON = "模型服务暂时不可用，请稍后重试";
const JSON_SECRET_HEADER_RE = /(["'](?:authorization|x-api-key)["']\s*:\s*["'])(?:Bearer\s+)?[^"']+(["'])/gi;
const TEXT_SECRET_HEADER_RE = /\b(authorization|x-api-key)\b(\s*[:=]\s*)(?:Bearer\s+)?[^\s"',;}\]]+/gi;
const SK_TOKEN_RE = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/g;

interface RestoreInflightState {
  epoch: number;
  resetSeq: number;
  promise: Promise<void>;
}

const restoreInflight = new Map<string, RestoreInflightState>();

export function redactStreamErrorForLog(error: unknown): string {
  const wrapper = error instanceof Error ? error.stack ?? error.message : String(error);
  const original = error instanceof SessionActorCommandError
    && error.originalError !== error
    ? error.originalError instanceof Error
      ? error.originalError.stack ?? error.originalError.message
      : String(error.originalError)
    : null;
  const raw = original ? `${wrapper}\noriginalError:\n${original}` : wrapper;
  return raw
    .replace(JSON_SECRET_HEADER_RE, "$1[REDACTED]$2")
    .replace(TEXT_SECRET_HEADER_RE, "$1$2[REDACTED]")
    .replace(SK_TOKEN_RE, "sk-[REDACTED]");
}

export function publicStreamErrorReason(): string {
  return PUBLIC_STREAM_ERROR_REASON;
}

function sessionDeletionErrorResponse(c: Context, error: unknown): Response | null {
  if (error instanceof SessionDeletedError) {
    return c.json({
      error: { code: "SESSION_DELETED", message: "会话已删除，无法继续操作" },
    }, 410);
  }
  if (error instanceof SessionDeletionInProgressError) {
    return c.json({
      error: { code: "SESSION_DELETION_IN_PROGRESS", message: "会话正在删除，请稍后再试" },
    }, 409);
  }
  return null;
}

function validatePmDoc(value: unknown, field: string): string | null {
  const parsed = safeParsePmDoc(value);
  if (!parsed.success) return `${field} must be a valid PM doc: ${parsed.error.message}`;
  return null;
}

/**
 * 入站命令校验。基建改造(D6):委托 contract-ts 的 `commandSchema`(zod
 * discriminatedUnion)做结构 + 语义校验;PM 文档的深层结构仍由
 * 本文件的 `validatePmDoc` 承担(见 updateDocDeepError),
 * 避免 contract-ts 反向依赖 pm-schema。返回 null 表示通过,否则返回错误文案(含字段路径)。
 *
 * 仍以 `validateCommandKind` 之名导出,供既有单测直接调用(薄 wrapper,内部走 zod)。
 */
export function validateCommandKind(body: unknown): string | null {
  const result = commandSchema.safeParse(body);
  if (!result.success) {
    return firstValidationIssueMessage(formatCommandError(result.error, body));
  }
  return updateDocDeepError(result.data);
}

/**
 * updateDoc 的深层文档校验(zod 层对 doc 只做直通)。其它 kind 一律通过。
 */
export function updateDocDeepError(command: Command): string | null {
  if (command.kind !== "updateDoc") return null;
  return validatePmDoc(command.data.doc, "updateDoc.data.doc");
}

export const streamRoutes = new Hono();

interface CommandRequestContext {
  clientTraceId: string | undefined;
  origin: ReturnType<typeof parseOrigin>;
  modelOverrides: Awaited<ReturnType<typeof resolveRequestModelOverrides>>;
}

function isBackgroundCommand(command: Command): boolean {
  return (
    command.kind === "startSession" ||
    command.kind === "sendMessage" ||
    command.kind === "resumeAskUser" ||
    command.kind === "cancelStream"
  );
}

function commandFrames(entries: LoggedFrame[]): BridgeFrame[] {
  return entries.map((entry) => entry.frame);
}

function firstCommandRequestId(commands: readonly Command[]): string | undefined {
  for (const command of commands) {
    const requestId = (command.data as { requestId?: unknown }).requestId;
    if (typeof requestId === "string" && requestId.length > 0) return requestId;
  }
  return undefined;
}

function commandFailureReason(error: SessionActorCommandError): string {
  // Actor 的 draftingFailed 已按命令类别脱敏；HTTP 与 SSE 复用同一诚实文案，
  // 不能把 originalError 的内部路径、密钥或上游原文暴露给前端。
  for (let index = error.frames.length - 1; index >= 0; index -= 1) {
    const frame = error.frames[index]?.frame;
    if (
      frame?.kind === "stream" &&
      frame.data.kind === "draftingFailed" &&
      frame.data.data.reason
    ) {
      return frame.data.data.reason;
    }
  }
  return publicStreamErrorReason();
}

function commandFailedResponse(
  command: Command,
  error: SessionActorCommandError,
): CommandFailedResponse {
  const requestId = firstCommandRequestId([command]);
  return {
    error: {
      code: "COMMAND_FAILED",
      message: commandFailureReason(error),
    },
    ...(requestId ? { requestId } : {}),
  };
}

function loggedCommandFrames(entries: LoggedFrame[]): Array<{ seq: number; frame: BridgeFrame }> {
  return entries.map(({ seq, frame }) => ({ seq, frame }));
}

function prepareCommandForActor(command: Command): { command: Command; sessionId?: string } {
  if (command.kind === "startSession") {
    const mode = command.data.mode;
    if (mode.kind === "existing") {
      return { command, sessionId: mode.data.id };
    }
    const sessionId = mode.data.sessionId ?? crypto.randomUUID();
    return {
      sessionId,
      command: {
        kind: "startSession",
        data: {
          mode: {
            kind: "new",
            data: { ...mode.data, sessionId },
          },
        },
      },
    };
  }
  return { command, sessionId: resolveCommandSessionId(command) };
}

async function readCommandRequestContext(c: Context): Promise<CommandRequestContext> {
  const clientTraceId = c.req.header("x-client-trace-id");
  const origin = parseOrigin(c.req.header("x-origin"));
  const modelOverrides = await resolveRequestModelOverrides({
    provider: c.req.header("x-model-provider"),
    visitorKey: c.req.header("x-model-key") ?? c.req.header("x-deepseek-key"),
    baseUrl: c.req.header("x-model-base-url"),
    modelFlash: c.req.header("x-model-flash"),
    modelPro: c.req.header("x-model-pro"),
    modelTier: c.req.header("x-model-tier"),
    protocol: c.req.header("x-model-protocol"),
    visionKey: c.req.header("x-vision-key"),
    visionBaseUrl: c.req.header("x-vision-base-url"),
    visionModel: c.req.header("x-vision-model"),
    visionProtocol: c.req.header("x-vision-protocol"),
  });
  return { clientTraceId, origin, modelOverrides };
}

async function handleCommandPost(c: Context) {
  const originError = requireTrustedOrigin(c);
  if (originError) return originError;

  const parsed = await parseBody(c, commandSchema, { formatError: formatCommandError });
  if (!parsed.ok) return parsed.response;
  const command = parsed.data;

  // updateDoc 的 doc 深层结构校验(zod 层只做直通)。
  const deepError = updateDocDeepError(command);
  if (deepError) {
    const path = "updateDoc.data.doc";
    const message = deepError.startsWith(path)
      ? deepError.slice(path.length).trim()
      : deepError;
    return c.json({ issues: [{ path, message, code: "custom" }] }, 400);
  }

  // 覆写防护(0702 review):startSession(new) 带客户端指定 sessionId 且该会话已存在
  // (内存或持久层)时拒绝——否则 createSession 会用全新空会话顶掉内存态,重进只见空会话,
  // 后续 persist 还可能把空态写回持久层造成永久丢失。正常客户端从不传该字段(服务端注入用)。
  if (command.kind === "startSession" && command.data.mode.kind === "new") {
    const requestedSessionId = command.data.mode.data.sessionId;
    if (typeof requestedSessionId === "string" && requestedSessionId.length > 0) {
      if (await sessionExists(requestedSessionId)) {
        return c.json({ error: `Session already exists: ${requestedSessionId}` }, 409);
      }
    }
  }

  const context = await readCommandRequestContext(c);
  const prepared = prepareCommandForActor(command);

  if (!prepared.sessionId) {
    if (prepared.command.kind === "cancelStream") {
      return c.json({ accepted: true });
    }
    return c.json({ error: "Unable to route command to a session" }, 404);
  }

  let clientMessageClaim:
    | (Extract<ClientMessageClaimResult, { kind: "claimed" }> & {
        clientMessageId: string;
      })
    | null = null;
  if (prepared.command.kind === "sendMessage") {
    const clientMessageId = normalizeIdempotencyClientMessageId(
      prepared.command.data.clientMessageId,
    );
    if (clientMessageId) {
      const claim = await clientMessageIdempotency.claim(
        clientMessageId,
        prepared.sessionId,
      );
      if (claim.kind === "duplicate") {
        return c.json({
          accepted: true,
          duplicate: true,
          sessionId: claim.sessionId,
          messageId: claim.messageId,
          epoch: sessionManager.frameLog.getEpoch(claim.sessionId),
        });
      }
      clientMessageClaim = { ...claim, clientMessageId };
    }
  }

  let promise: Promise<LoggedFrame[]>;
  try {
    ({ completion: promise } = await sessionManager.submitQueued(prepared.sessionId, {
      command: prepared.command,
      clientTraceId: context.clientTraceId,
      origin: context.origin,
      modelOverrides: context.modelOverrides,
      abortSignal: c.req.raw.signal,
    }));
  } catch (error) {
    if (clientMessageClaim) {
      await clientMessageIdempotency.release(
        clientMessageClaim.clientMessageId,
        clientMessageClaim.sessionId,
        clientMessageClaim.token,
      );
    }
    const deletionResponse = sessionDeletionErrorResponse(c, error);
    if (deletionResponse) return deletionResponse;
    if (error instanceof SessionActorQueueFullError) {
      return c.json({ error: "Session command queue is full" }, 429);
    }
    throw error;
  }
  if (clientMessageClaim) {
    promise = clientMessageIdempotency.maintain(
      clientMessageClaim.clientMessageId,
      clientMessageClaim.sessionId,
      clientMessageClaim.token,
      promise,
    );
  }

  if (isBackgroundCommand(prepared.command)) {
    void promise.catch((error) => {
      console.error("[commands] background command failed:", redactStreamErrorForLog(error));
    });
    return c.json({
      accepted: true,
      ...(prepared.command.kind === "startSession" ? { sessionId: prepared.sessionId } : {}),
      epoch: sessionManager.frameLog.getEpoch(prepared.sessionId),
    });
  }

  try {
    const frames = await promise;
    return c.json(commandFrames(frames));
  } catch (error) {
    console.error("[commands] command failed:", redactStreamErrorForLog(error));
    const deletionResponse = sessionDeletionErrorResponse(c, error);
    if (deletionResponse) return deletionResponse;
    if (error instanceof SessionActorCommandError) {
      return c.json(commandFailedResponse(prepared.command, error), 422);
    }
    return c.json({ error: publicStreamErrorReason() }, 500);
  }
}

streamRoutes.post("/commands", handleCommandPost);

streamRoutes.get("/events", async (c) => {
  const originError = requireTrustedOrigin(c);
  if (originError) return originError;

  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId is required" }, 400);
  if (!sessionManager.frameLog.hasSession(sessionId) && !(await sessionExists(sessionId))) {
    return c.json({ error: "Session not found" }, 404);
  }

  const client = requestClientAddress(c);
  const admission = sseAdmission.acquire(client.ip, sessionId, { loopback: client.loopback });
  if (!admission.accepted) {
    c.header("Retry-After", "1");
    return c.json({ error: "SSE connection limit exceeded", limit: admission.reason }, 429);
  }

  const afterSeq = parseSeq(c.req.header("Last-Event-ID") ?? c.req.query("after"));
  const requestedEpoch = parseOptionalSeq(c.req.query("epoch"));

  return streamSSE(c, async (stream) => {
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
      write: async (message) => {
        await stream.writeSSE(message);
        if (message.id && message.event === "frame") {
          try {
            const frame = JSON.parse(message.data) as BridgeFrame;
            const terminalFields = terminalDocumentFrameFields(
              frame,
              Number(message.id),
            );
            if (terminalFields) {
              console.info("[terminal-document] written", {
                stage: "written",
                sessionId,
                ...terminalFields,
              });
            }
          } catch {
            // 诊断不得影响 SSE 交付。
          }
        }
      },
      onClose: (reason, details) => {
        // overflow 是服务端主动淘汰一条慢连接，不代表用户取消本轮。
        // 让 agent 继续把候选态与 end 写入 FrameLog，客户端才能按游标重连回放。
        console.error("[events] SSE pump closed", {
          sessionId,
          ...details,
          reason,
        });
        stream.abort();
        cleanup();
      },
    });

    try {
      const read = sessionManager.frameLog.readFrom(sessionId, afterSeq);
      let subscribeAfter = afterSeq;
      if ((requestedEpoch !== null && requestedEpoch !== read.epoch) || read.gap) {
        subscribeAfter = appendRestoreSnapshot(sessionId, read.epoch);
      }

      unsubscribe = sessionManager.frameLog.subscribe(
        sessionId,
        subscribeAfter,
        (entry, delivery) => {
          const enqueued = pump.enqueue({
            id: String(entry.seq),
            event: "frame",
            data: JSON.stringify(entry.frame),
          }, {
            delivery,
            allowOversized: allowOversizedSseFrame(entry.frame),
          });
          const terminalFields = terminalDocumentFrameFields(
            entry.frame,
            entry.seq,
          );
          if (enqueued && terminalFields) {
            console.info("[terminal-document] enqueued", {
              stage: "enqueued",
              sessionId,
              delivery,
              ...terminalFields,
            });
          }
        },
      );
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

function appendRestoreSnapshot(sessionId: string, requestedEpoch: number): number {
  // readFrom 与真正追加之间若会话刚好被驱逐，必须以当前 epoch 为准；同一会话
  // 同一 epoch 的并发重连复用首个恢复，避免重复广播 reset + snapshot。
  const currentEpoch = sessionManager.frameLog.getEpoch(sessionId);
  const epoch = currentEpoch === requestedEpoch ? requestedEpoch : currentEpoch;
  const inflight = restoreInflight.get(sessionId);
  if (inflight?.epoch === epoch) return inflight.resetSeq - 1;

  const snapshotSeq = sessionManager.frameLog.readFrom(sessionId, Number.MAX_SAFE_INTEGER).nextSeq;
  const resetFrame: BridgeFrame = {
    kind: "restoreReset",
    data: { epoch, snapshotSeq },
  };
  const resetSeq = sessionManager.frameLog.append(
    sessionId,
    resetFrame,
    { delivery: "replay" },
  ) ?? snapshotSeq;
  const state: RestoreInflightState = {
    epoch,
    resetSeq,
    promise: Promise.resolve(),
  };
  state.promise = collectRestoreFrames(sessionId)
    .then((frames) => {
      for (const frame of frames) {
        // 恢复期间会话被驱逐/重建时，旧快照不得串入新 epoch。
        if (sessionManager.frameLog.getEpoch(sessionId) !== epoch) return;
        // 这批帧是为 gap/epoch 重连生成的权威回放。若按 live 计入 64 帧
        // 慢客户端预算，恢复本身超过上限时会 close → 重连 → 再生成恢复，
        // 形成永不收敛的自喂养循环。
        sessionManager.frameLog.append(sessionId, frame, { delivery: "replay" });
      }
    })
    .catch((error) => {
      if (sessionManager.frameLog.getEpoch(sessionId) !== epoch) return;
      console.error("[events] restore snapshot failed:", redactStreamErrorForLog(error));
      sessionManager.frameLog.append(
        sessionId,
        {
          kind: "stream",
          data: {
            kind: "draftingFailed",
            data: {
              streamId: "restore",
              reason: publicStreamErrorReason(),
              retriable: true,
            },
          },
        },
        { delivery: "replay" },
      );
    })
    .finally(() => {
      if (restoreInflight.get(sessionId) === state) {
        restoreInflight.delete(sessionId);
      }
    });
  restoreInflight.set(sessionId, state);
  void state.promise;
  return resetSeq - 1;
}

function parseSeq(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function parseOptionalSeq(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

/**
 * POST /api/v1/commit — non-streaming REST endpoint for commit operations.
 *
 * Accepts all "reviewing" patches and commits them atomically, returning
 * the collected BridgeFrame events as a JSON array. This avoids the
 * browser's HTTP/1.1 connection-limit issues that plague sequential SSE
 * requests during commit.
 */
streamRoutes.post("/commit", async (c) => {
  const originError = requireTrustedOrigin(c);
  if (originError) return originError;

  // /commit 载荷分支多(group vs patchIds)、各带精确文案,深校验保留在下方;
  // 这里仅用 parseBody 统一 JSON 解析失败处理(z.unknown 不改变原对象/数组的宽松语义)。
  const parsedBody = await parseBody(c, z.unknown());
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;

  if (body === null || typeof body !== "object") {
    return c.json({ error: "Body must be a non-null object" }, 400);
  }
  const {
    sessionId,
    patchIds,
    acceptReviewBatchIds,
    rejectReviewBatchIds,
    keepPendingReviewBatchIds,
  } = body as Record<string, unknown>;

  if (typeof sessionId !== "string" || !sessionId) {
    return c.json({ error: "sessionId must be a non-empty string" }, 400);
  }
  if (sessionId.length > MAX_COMMAND_STRING_LENGTH) {
    return c.json({ error: `sessionId must contain at most ${MAX_COMMAND_STRING_LENGTH} characters` }, 400);
  }
  const hasGroupCommit = Array.isArray(acceptReviewBatchIds);
  if (hasGroupCommit) {
    for (const field of ["acceptReviewBatchIds", "rejectReviewBatchIds", "keepPendingReviewBatchIds"] as const) {
      const value = ({ acceptReviewBatchIds, rejectReviewBatchIds, keepPendingReviewBatchIds })[field];
      if (value === undefined) continue;
      if (!Array.isArray(value)) return c.json({ error: `${field} must be an array` }, 400);
      if (value.length > MAX_COMMAND_ARRAY_LENGTH) {
        return c.json({ error: `${field} must contain at most ${MAX_COMMAND_ARRAY_LENGTH} items` }, 400);
      }
      for (const id of value) {
        if (typeof id !== "string" || !id) {
          return c.json({ error: `${field}[] must be non-empty strings` }, 400);
        }
        if (id.length > MAX_COMMAND_STRING_LENGTH) {
          return c.json({ error: `${field}[] must contain at most ${MAX_COMMAND_STRING_LENGTH} characters` }, 400);
        }
      }
    }
    const accepted = new Set(acceptReviewBatchIds as string[]);
    if ((rejectReviewBatchIds as string[] | undefined)?.some((id) => accepted.has(id))) {
      return c.json({
        error: "acceptReviewBatchIds and rejectReviewBatchIds must not overlap",
      }, 400);
    }
    const keptPending = keepPendingReviewBatchIds as string[] | undefined;
    if (keptPending?.some((id) => accepted.has(id))) {
      return c.json({
        error: "acceptReviewBatchIds and keepPendingReviewBatchIds must not overlap",
      }, 400);
    }
    const rejected = new Set((rejectReviewBatchIds as string[] | undefined) ?? []);
    if (keptPending?.some((id) => rejected.has(id))) {
      return c.json({
        error: "rejectReviewBatchIds and keepPendingReviewBatchIds must not overlap",
      }, 400);
    }
  } else {
    if (!Array.isArray(patchIds) || patchIds.length === 0) {
      return c.json({ error: "patchIds must be a non-empty array" }, 400);
    }
    if (patchIds.length > MAX_COMMAND_ARRAY_LENGTH) {
      return c.json({ error: `patchIds must contain at most ${MAX_COMMAND_ARRAY_LENGTH} items` }, 400);
    }
    for (const id of patchIds) {
      if (typeof id !== "string" || !id) {
        return c.json({ error: "patchIds[] must be non-empty strings" }, 400);
      }
      if (id.length > MAX_COMMAND_STRING_LENGTH) {
        return c.json({ error: `patchIds[] must contain at most ${MAX_COMMAND_STRING_LENGTH} characters` }, 400);
      }
    }
  }

  const command: Command = hasGroupCommit
    ? {
        kind: "commitReviewGroups",
        data: {
          acceptReviewBatchIds: acceptReviewBatchIds as string[],
          rejectReviewBatchIds: (rejectReviewBatchIds as string[] | undefined) ?? [],
          keepPendingReviewBatchIds: (keepPendingReviewBatchIds as string[] | undefined) ?? [],
        },
      }
    : { kind: "commitPatches", data: { ids: patchIds as string[] } };
  const context = await readCommandRequestContext(c);

  // commit 故意是非抢占命令：经同一 actor 排在运行中的 sendMessage 后执行，避免旁路写
  // 与生成态交错。REST 端点保留，只为绕开浏览器 HTTP/1.1 的 SSE 连接数限制。
  // 本改动仅关闭 single-writer 旁路；手打块保真已有独立修复与回归，不在这里重复归因。
  const promise = sessionManager.submit(sessionId, {
    command,
    clientTraceId: context.clientTraceId,
    origin: context.origin,
    modelOverrides: context.modelOverrides,
  });

  try {
    return c.json(loggedCommandFrames(await promise));
  } catch (error) {
    console.error("[commit] command failed:", redactStreamErrorForLog(error));
    const deletionResponse = sessionDeletionErrorResponse(c, error);
    if (deletionResponse) return deletionResponse;
    if (error instanceof SessionActorQueueFullError) {
      return c.json({ error: "Session command queue is full" }, 429);
    }
    if (error instanceof SessionActorCommandError && error.frames.length > 0) {
      return c.json(loggedCommandFrames(error.frames));
    }
    return c.json({ error: publicStreamErrorReason() }, 500);
  }
});

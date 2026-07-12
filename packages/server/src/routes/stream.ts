import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Command, BridgeFrame } from "@qingagent/contract-ts";
import { safeParsePmDoc } from "@qingagent/pm-schema";
import {
  getSession,
  findSessionByPatch,
  recordCommandSpan,
  normalizeClientTraceId,
  parseOrigin,
  resolveCommandSessionId,
  sessionManager,
  collectRestoreFrames,
  sessionExists,
} from "../gateway/bridgeHandler";
import type { LoggedFrame } from "../gateway/frameLog";
import { SessionActorCommandError } from "../gateway/sessionActor";
import {
  updatePatchVerdict,
  commitPatches as commitPatchesBridge,
  commitReviewGroups,
} from "@qingagent/core";
import { commandSchema } from "@qingagent/contract-ts/schemas";
import { resolveRequestModelOverrides } from "../modelOverridesProvider";
import { requireTrustedOrigin } from "../lib/trustedOrigin";
import { formatCommandError, parseBody } from "../lib/validation";

const PUBLIC_STREAM_ERROR_REASON = "模型服务暂时不可用，请稍后重试";
const JSON_SECRET_HEADER_RE = /(["'](?:authorization|x-api-key)["']\s*:\s*["'])(?:Bearer\s+)?[^"']+(["'])/gi;
const TEXT_SECRET_HEADER_RE = /\b(authorization|x-api-key)\b(\s*[:=]\s*)(?:Bearer\s+)?[^\s"',;}\]]+/gi;
const SK_TOKEN_RE = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/g;

export function redactStreamErrorForLog(error: unknown): string {
  const raw = error instanceof Error ? error.stack ?? error.message : String(error);
  return raw
    .replace(JSON_SECRET_HEADER_RE, "$1[REDACTED]$2")
    .replace(TEXT_SECRET_HEADER_RE, "$1$2[REDACTED]")
    .replace(SK_TOKEN_RE, "sk-[REDACTED]");
}

export function publicStreamErrorReason(): string {
  return PUBLIC_STREAM_ERROR_REASON;
}

function validateLegacySections(value: unknown, field: string): string | null {
  if (!Array.isArray(value)) {
    return `${field} must be an array`;
  }
  for (const [index, section] of value.entries()) {
    if (section === null || typeof section !== "object") {
      return `${field}[${index}] must be an object`;
    }
    const item = section as Record<string, unknown>;
    if (typeof item.kind !== "string") {
      return `${field}[${index}].kind must be a string`;
    }
    const data = item.data;
    if (data === null || typeof data !== "object") {
      return `${field}[${index}].data must be an object`;
    }
    const d = data as Record<string, unknown>;
    switch (item.kind) {
      case "h1":
      case "p":
      case "penNote":
        if (typeof d.text !== "string") return `${field}[${index}].data.text must be a string`;
        break;
      case "h2":
        if (typeof d.text !== "string") return `${field}[${index}].data.text must be a string`;
        if (d.anchor !== null && typeof d.anchor !== "string") {
          return `${field}[${index}].data.anchor must be null or string`;
        }
        break;
      case "code":
        if (typeof d.body !== "string") return `${field}[${index}].data.body must be a string`;
        break;
      case "table":
        if (!Array.isArray(d.head) || !Array.isArray(d.rows)) {
          return `${field}[${index}].data.head and rows must be arrays`;
        }
        break;
      case "image":
        if (typeof d.src !== "string") return `${field}[${index}].data.src must be a string`;
        if (typeof d.alt !== "string") return `${field}[${index}].data.alt must be a string`;
        if (d.caption !== null && typeof d.caption !== "string") {
          return `${field}[${index}].data.caption must be null or string`;
        }
        if (d.width !== null && typeof d.width !== "number") {
          return `${field}[${index}].data.width must be null or number`;
        }
        if (d.height !== null && typeof d.height !== "number") {
          return `${field}[${index}].data.height must be null or number`;
        }
        break;
      default:
        return `${field}[${index}].kind is not supported`;
    }
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
 * discriminatedUnion)做结构 + 语义校验;PM 文档 / legacySections 的深层结构仍由
 * 本文件的 `validatePmDoc` / `validateLegacySections` 承担(见 updateDocDeepError),
 * 避免 contract-ts 反向依赖 pm-schema。返回 null 表示通过,否则返回错误文案(含字段路径)。
 *
 * 仍以 `validateCommandKind` 之名导出,供既有单测直接调用(薄 wrapper,内部走 zod)。
 */
export function validateCommandKind(body: unknown): string | null {
  const result = commandSchema.safeParse(body);
  if (!result.success) return formatCommandError(result.error, body).error;
  return updateDocDeepError(result.data);
}

/**
 * updateDoc 的深层文档校验(zod 层对 doc/legacySections 只做直通)。与旧行为逐字一致:
 * 有 doc → safeParsePmDoc;否则校验 legacySections。其它 kind 一律通过。
 */
export function updateDocDeepError(command: Command): string | null {
  if (command.kind !== "updateDoc") return null;
  if (command.data.doc !== undefined) {
    return validatePmDoc(command.data.doc, "updateDoc.data.doc");
  }
  return validateLegacySections(command.data.legacySections, "updateDoc.data.legacySections");
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
    command.kind === "cancelStream" ||
    command.kind === "cancelAskUser"
  );
}

function commandFrames(entries: LoggedFrame[]): BridgeFrame[] {
  return entries.map((entry) => entry.frame);
}

function logCommitFrame(sessionId: string, frame: BridgeFrame): { seq: number; frame: BridgeFrame } {
  const seq = sessionManager.frameLog.append(sessionId, frame);
  if (seq === null) {
    throw new Error("Failed to append commit frame");
  }
  return { seq, frame };
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
    visitorKey: c.req.header("x-deepseek-key"),
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

  // updateDoc 的 doc/legacySections 深层结构校验(zod 层只做直通),与旧行为一致。
  const deepError = updateDocDeepError(command);
  if (deepError) {
    return c.json({ error: deepError, issues: [{ path: "data", message: deepError, code: "custom" }] }, 400);
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

  const promise = sessionManager.submit(prepared.sessionId, {
    command: prepared.command,
    clientTraceId: context.clientTraceId,
    origin: context.origin,
    modelOverrides: context.modelOverrides,
  });

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
    if (error instanceof SessionActorCommandError && error.frames.length > 0) {
      return c.json(commandFrames(error.frames));
    }
    return c.json({ error: publicStreamErrorReason() }, 500);
  }
}

streamRoutes.post("/commands", handleCommandPost);
streamRoutes.post("/stream", handleCommandPost);

streamRoutes.get("/events", (c) => {
  const originError = requireTrustedOrigin(c);
  if (originError) return originError;

  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId is required" }, 400);

  const afterSeq = parseSeq(c.req.header("Last-Event-ID") ?? c.req.query("after"));
  const requestedEpoch = parseOptionalSeq(c.req.query("epoch"));

  return streamSSE(c, async (stream) => {
    let writeChain = Promise.resolve();
    const enqueueWrite = (entry: LoggedFrame) => {
      writeChain = writeChain
        .then(() =>
          stream.writeSSE({
            id: String(entry.seq),
            event: "frame",
            data: JSON.stringify(entry.frame),
          }),
        )
        .catch(() => undefined);
      return writeChain;
    };

    const read = sessionManager.frameLog.readFrom(sessionId, afterSeq);
    let subscribeAfter = afterSeq;
    if ((requestedEpoch !== null && requestedEpoch !== read.epoch) || read.gap) {
      subscribeAfter = appendRestoreSnapshot(sessionId, read.epoch);
    }

    const unsubscribe = sessionManager.frameLog.subscribe(
      sessionId,
      subscribeAfter,
      (entry) => {
        void enqueueWrite(entry);
      },
    );

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

function appendRestoreSnapshot(sessionId: string, epoch: number): number {
  const snapshotSeq = sessionManager.frameLog.readFrom(sessionId, Number.MAX_SAFE_INTEGER).nextSeq;
  const resetFrame: BridgeFrame = {
    kind: "restoreReset",
    data: { epoch, snapshotSeq },
  };
  const resetSeq = sessionManager.frameLog.append(sessionId, resetFrame) ?? snapshotSeq;
  void collectRestoreFrames(sessionId)
    .then((frames) => {
      for (const frame of frames) {
        sessionManager.frameLog.append(sessionId, frame);
      }
    })
    .catch((error) => {
      console.error("[events] restore snapshot failed:", redactStreamErrorForLog(error));
      sessionManager.frameLog.append(sessionId, {
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: {
            streamId: "restore",
            reason: publicStreamErrorReason(),
            retriable: true,
          },
        },
      });
    });
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

  // 阶段4a follow-up — /commit 是独立 REST 端点（不走 handleCommand），所以
  // commit 操作此前没有 ② command span。这里读 x-client-trace-id（与 /stream 端点
  // 一致），下面确定 validIds 后补记一条 command span，使 commit 也能按单次点击关联。
  const rawClientTraceId = c.req.header("x-client-trace-id");
  const modelOverrides = await resolveRequestModelOverrides({
    visitorKey: c.req.header("x-deepseek-key"),
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

  if (typeof sessionId !== "string" || !sessionId) {
    return c.json({ error: "sessionId must be a non-empty string" }, 400);
  }
  const hasGroupCommit = Array.isArray(acceptReviewBatchIds);
  if (hasGroupCommit) {
    for (const field of ["acceptReviewBatchIds", "rejectReviewBatchIds", "keepPendingReviewBatchIds"] as const) {
      const value = ({ acceptReviewBatchIds, rejectReviewBatchIds, keepPendingReviewBatchIds })[field];
      if (value === undefined) continue;
      if (!Array.isArray(value)) return c.json({ error: `${field} must be an array` }, 400);
      for (const id of value) {
        if (typeof id !== "string" || !id) {
          return c.json({ error: `${field}[] must be non-empty strings` }, 400);
        }
      }
    }
  } else {
    if (!Array.isArray(patchIds) || patchIds.length === 0) {
      return c.json({ error: "patchIds must be a non-empty array" }, 400);
    }
    for (const id of patchIds) {
      if (typeof id !== "string" || !id) {
        return c.json({ error: "patchIds[] must be non-empty strings" }, 400);
      }
    }
  }

  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: `Session not found: ${sessionId}` }, 404);
  }
  session.modelOverrides = modelOverrides;

  try {
    const loggedFrames: Array<{ seq: number; frame: BridgeFrame }> = [];
    const clientTraceId = normalizeClientTraceId(rawClientTraceId, sessionId);
    session.clientTraceId = clientTraceId;
    // 0603 — /commit 独立端点也读 x-origin,绑会话 + 带进 command/db_write span。
    const origin = parseOrigin(c.req.header("x-origin"));
    session.origin = origin;

    if (hasGroupCommit) {
      const commandSpan = recordCommandSpan(
        {
          kind: "commitPatches",
          data: {
            ids: [],
            reviewBatchIds: acceptReviewBatchIds as string[],
          },
        } as Command,
        sessionId,
        clientTraceId,
        origin,
      );

      try {
        for await (const frame of commitReviewGroups(session, {
          acceptReviewBatchIds: acceptReviewBatchIds as string[],
          rejectReviewBatchIds: (rejectReviewBatchIds as string[] | undefined) ?? [],
          keepPendingReviewBatchIds: (keepPendingReviewBatchIds as string[] | undefined) ?? [],
        })) {
          loggedFrames.push(logCommitFrame(sessionId, frame));
        }
        commandSpan.endOk({ accepted: true, frameCount: loggedFrames.length });
      } catch (error) {
        commandSpan.endError(error, { failureKind: "commitFailed" });
        throw error;
      }

      return c.json(loggedFrames);
    }

    // Filter to review items that actually exist. Validation-failed tool calls are
    // never registered, so skip them silently.
    const validIds = (patchIds as string[]).filter(
      (id) => session.suggestions?.has(id),
    );
    if (validIds.length === 0) {
      return c.json([]);
    }

    // 阶段4a follow-up — 记 ② command span（复用 handleCommand 路径的
    // recordCommandSpan(command, sessionId, clientTraceId)，与 /stream 路径同范式与同
    // summarizeCommandInput 摘要逻辑，避免在 REST 这里另拼一套不一致的实现）。
    // - clientTraceId 经 normalizeClientTraceId 归一化（合法 32hex 用 header，否则用
    //   sessionIdToTraceId(sessionId) 兜底），与 /stream、clientlog 同协议（修 Codex
    //   review #2/#3：不直接把 raw header 塞进 span）。
    // - 同时绑到 session.clientTraceId，使紧随其后的 updatePatchVerdict / commitPatches
    //   触发的 ④ db_write span 也带上同一个 clientTraceId，四层不断链（修 Codex review #2）。
    // - 构造合成 commitPatches Command 喂给 recordCommandSpan，input 由
    //   summarizeCommandInput 取 { patchIds, patchCount }，只含 id 摘要，绝不放文档正文。
    // recordCommandSpan 内部已 try/catch，绝不影响 commit 主链路。
    const commandSpan = recordCommandSpan(
      { kind: "commitPatches", data: { ids: validIds } } as Command,
      sessionId,
      clientTraceId,
      origin,
    );

    try {
      // 1. Accept all patches that are still in "reviewing" status
      for (const id of validIds) {
        const verdict = session.patchVerdicts.get(id);
        if (!verdict) {
          for (const frame of updatePatchVerdict(session, id, "accepted")) {
            loggedFrames.push(logCommitFrame(sessionId, frame));
          }
        }
      }

      // 2. Commit all patches
      for await (const frame of commitPatchesBridge(session, validIds)) {
        loggedFrames.push(logCommitFrame(sessionId, frame));
      }
      commandSpan.endOk({ accepted: true, frameCount: loggedFrames.length });
    } catch (error) {
      commandSpan.endError(error, { failureKind: "commitFailed" });
      throw error;
    }

    return c.json(loggedFrames);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, 500);
  }
});

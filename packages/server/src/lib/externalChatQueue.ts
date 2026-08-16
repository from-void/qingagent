import crypto from "node:crypto";
import type { Context } from "hono";
import type { ReviewContext } from "@qingagent/contract-ts";
import { commandSchema } from "@qingagent/contract-ts/schemas";
import { getOrRestoreSession, sessionManager } from "../gateway/bridgeHandler";
import { SessionActorQueueFullError } from "../gateway/sessionActor";
import { resolveRequestModelOverrides } from "../modelOverridesProvider";
import { externalError } from "./externalError";

export async function queueExternalChat(
  c: Context,
  input: {
    sessionId: string;
    text: string;
    reviewContext?: ReviewContext;
    event?: "chat" | "review_run";
    responseExtra?: Record<string, unknown>;
    includeAfterSeq?: boolean;
  },
): Promise<Response> {
  const startedAt = Date.now();
  const evt = input.event ?? "chat";
  const client = parseExternalClient(c.req.header("x-qa-client"));
  const session = await getOrRestoreSession(input.sessionId);
  if (!session) {
    log(evt, client, input.sessionId, startedAt, "rejected:SESSION_NOT_FOUND");
    return externalError(c, 404, "SESSION_NOT_FOUND");
  }
  const parsed = commandSchema.safeParse({
    kind: "sendMessage",
    data: {
      sessionId: input.sessionId,
      text: input.text,
      skills: [],
      chips: [],
      fileIds: [],
      clientMessageId: `external-${client}-${crypto.randomUUID()}`,
      ...(input.reviewContext ? { reviewContext: input.reviewContext } : {}),
    },
  });
  if (!parsed.success || parsed.data.kind !== "sendMessage") {
    log(evt, client, input.sessionId, startedAt, "rejected:VALIDATION");
    return externalError(c, 400, "VALIDATION", "text 超过 64KB 上限");
  }
  const afterSeq = input.includeAfterSeq
    ? Math.max(
      0,
      sessionManager.frameLog.readFrom(input.sessionId, Number.MAX_SAFE_INTEGER).nextSeq - 1,
    )
    : undefined;
  let completion: Promise<unknown>;
  try {
    ({ completion } = await sessionManager.submitQueued(input.sessionId, {
      command: parsed.data,
      origin: "external",
      client,
      modelOverrides: await resolveRequestModelOverrides({}),
    }));
  } catch (error) {
    if (error instanceof SessionActorQueueFullError) {
      log(evt, client, input.sessionId, startedAt, "rejected:RATE_LIMITED");
      return externalError(c, 429, "RATE_LIMITED", "会话命令队列已满");
    }
    throw error;
  }
  void completion.catch(() => {
    console.warn(`[external] evt=${evt} session=${input.sessionId} result=async_failed`);
  });
  log(evt, client, input.sessionId, startedAt, "queued");
  return c.json({
    queued: true as const,
    note: "已入队,执行结果以 events 为准",
    ...(input.responseExtra ?? {}),
    ...(afterSeq === undefined ? {} : { afterSeq }),
  });
}

function parseExternalClient(
  value: string | undefined,
): "claudecode" | "codex" | "deepseek" | "agent" {
  if (value === "claudecode" || value === "codex" || value === "deepseek") return value;
  if (value === "chatgpt") return "codex"; // Codex 并入 ChatGPT 后的新客户端名
  return "agent";
}

function log(
  evt: string,
  client: string,
  sessionId: string,
  startedAt: number,
  result: string,
): void {
  console.log(
    `[external] evt=${evt} client=${client} session=${sessionId} ms=${Date.now() - startedAt} result=${result}`,
  );
}

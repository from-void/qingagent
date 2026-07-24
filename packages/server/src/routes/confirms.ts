import { Hono, type Context } from "hono";
import type { SubmitConfirmDecision } from "@qingagent/contract-ts";
import { submitConfirmDecisionSchema } from "@qingagent/contract-ts/schemas";
import {
  ConfirmDecisionError,
  confirmService,
  type SafeSubmitConfirmDecision,
} from "@qingagent/core/confirm";
import {
  getOrRestoreSession,
  sessionManager,
} from "../gateway/bridgeHandler";
import { handleConfirmDecision } from "../gateway/confirmRuntime";
import { SessionActorCommandError, SessionActorQueueFullError } from "../gateway/sessionActor";
import { requireTrustedOrigin } from "../lib/trustedOrigin";

const MAX_CONFIRM_BODY_BYTES = 16 * 1024;

async function readBoundedJson(c: Context): Promise<unknown> {
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CONFIRM_BODY_BYTES) {
    throw new ConfirmDecisionError("invalid", "确认请求体过大");
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new ConfirmDecisionError("invalid", "确认请求无效");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CONFIRM_BODY_BYTES) {
      await reader.cancel();
      throw new ConfirmDecisionError("invalid", "确认请求体过大");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ConfirmDecisionError("invalid", "确认请求无效");
  }
}

function safeSubmission(
  input: SubmitConfirmDecision,
): SafeSubmitConfirmDecision {
  const { secretValue: _secretValue, ...decision } = input.decision;
  return {
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    decisionId: input.decisionId,
    decision,
    hasSecretValue: input.decision.secretValue !== undefined,
  };
}

function decisionError(error: unknown): ConfirmDecisionError | null {
  if (error instanceof ConfirmDecisionError) return error;
  if (
    error instanceof SessionActorCommandError &&
    error.originalError instanceof ConfirmDecisionError
  ) {
    return error.originalError;
  }
  return null;
}

function errorStatus(code: ConfirmDecisionError["code"]): 400 | 404 | 409 | 410 {
  switch (code) {
    case "invalid": return 400;
    case "not_found": return 404;
    case "conflict": return 409;
    case "expired": return 410;
  }
  return 400;
}

export const confirmRoutes = new Hono();

confirmRoutes.post("/confirms/decision", async (c) => {
  const originError = requireTrustedOrigin(c);
  if (originError) return originError;

  let parsed: SubmitConfirmDecision;
  try {
    const raw = await readBoundedJson(c);
    const result = submitConfirmDecisionSchema.safeParse(raw);
    if (!result.success) {
      return c.json({ error: "确认请求无效" }, 400);
    }
    parsed = result.data;
  } catch (error) {
    const known = decisionError(error);
    return c.json({ error: known?.message ?? "确认请求无效" }, known ? errorStatus(known.code) : 400);
  }

  const session = await getOrRestoreSession(parsed.sessionId);
  if (!session) return c.json({ error: "没有可处理的确认请求" }, 404);
  if (parsed.decision.secretValue !== undefined) {
    confirmService.stageSecret(session, {
      confirmId: parsed.decision.id,
      toolCallId: parsed.toolCallId,
      value: parsed.decision.secretValue,
    });
  }
  const safe = safeSubmission(parsed);

  try {
    await sessionManager.runExclusive(parsed.sessionId, () => handleConfirmDecision(safe));
    return c.json({ accepted: true });
  } catch (error) {
    confirmService.discardSecret(session, parsed.decision.id);
    if (error instanceof SessionActorQueueFullError) {
      return c.json({ error: "会话命令队列已满" }, 429);
    }
    const known = decisionError(error);
    if (known) return c.json({ error: known.message }, errorStatus(known.code));
    return c.json({ error: "确认处理失败，命令未执行" }, 500);
  }
});

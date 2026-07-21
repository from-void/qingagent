import { Hono, type Context } from "hono";
import type {
  BridgeFrame,
  CancelConfirmedCommand,
  SubmitConfirmDecision,
} from "@qingagent/contract-ts";
import {
  cancelConfirmedCommandSchema,
  submitConfirmDecisionSchema,
} from "@qingagent/contract-ts/schemas";
import {
  ConfirmDecisionError,
  confirmService,
  type ConfirmService,
  type SafeSubmitConfirmDecision,
} from "@qingagent/core/confirm";
import { cancelConfirmedCommand } from "@qingagent/core";
import {
  getOrRestoreSession,
  sessionManager,
} from "../gateway/bridgeHandler";
import { handleConfirmDecision } from "../gateway/confirmRuntime";
import { SessionActorCommandError, SessionActorQueueFullError } from "../gateway/sessionActor";
import { requireTrustedOrigin } from "../lib/trustedOrigin";
import {
  createConfirmGrantWithResult,
  type ConfirmGrant,
  type ConfirmGrantCreation,
} from "@qingagent/db";
import {
  consumeConfirmUiGrant,
  insecureRememberAllowed,
} from "../lib/confirmUiGrant";

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
  const {
    secretValue: _secretValue,
    remember: _remember,
    uiGrantNonce: _uiGrantNonce,
    ...decision
  } = input.decision;
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

interface ConfirmRoutesDependencies {
  getSession?: typeof getOrRestoreSession;
  runExclusive?: (
    sessionId: string,
    task: () => AsyncGenerator<BridgeFrame>,
  ) => Promise<unknown>;
  handleDecision?: typeof handleConfirmDecision;
  service?: ConfirmService;
  consumeUiGrant?: typeof consumeConfirmUiGrant;
  insecureRememberAllowed?: () => boolean;
  createGrant?: (input: {
    kind: "install" | "command";
    source: "card";
  }) => Promise<ConfirmGrantCreation | ConfirmGrant>;
  cancelCommand?: typeof cancelConfirmedCommand;
}

export function createConfirmRoutes(
  dependencies: ConfirmRoutesDependencies = {},
): Hono {
  const routes = new Hono();
  const getSession = dependencies.getSession ?? getOrRestoreSession;
  const runExclusive = dependencies.runExclusive
    ?? ((sessionId, task) => sessionManager.runExclusive(sessionId, task));
  const decide = dependencies.handleDecision ?? handleConfirmDecision;
  const service = dependencies.service ?? confirmService;
  const consumeUiGrant = dependencies.consumeUiGrant ?? consumeConfirmUiGrant;
  const allowInsecureRemember = dependencies.insecureRememberAllowed
    ?? insecureRememberAllowed;
  const createGrant = dependencies.createGrant ?? createConfirmGrantWithResult;
  const cancelCommand = dependencies.cancelCommand ?? cancelConfirmedCommand;

  routes.post("/confirms/cancel", async (c) => {
    const originError = requireTrustedOrigin(c);
    if (originError) return originError;

    let parsed: CancelConfirmedCommand;
    try {
      const raw = await readBoundedJson(c);
      const result = cancelConfirmedCommandSchema.safeParse(raw);
      if (!result.success) {
        return c.json({ error: "停止请求无效" }, 400);
      }
      parsed = result.data;
    } catch {
      return c.json({ error: "停止请求无效" }, 400);
    }

    const session = await getSession(parsed.sessionId);
    if (!session) return c.json({ error: "没有找到正在执行的命令" }, 404);
    if (!cancelCommand(session, parsed.toolCallId)) {
      return c.json({ error: "这条命令已经结束或尚未开始" }, 409);
    }
    return c.json({ accepted: true }, 202);
  });

  routes.post("/confirms/decision", async (c) => {
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

  const session = await getSession(parsed.sessionId);
  if (!session) return c.json({ error: "没有可处理的确认请求" }, 404);
  const pending = session.pendingConfirms.get(parsed.toolCallId);
  const rememberRequested = parsed.decision.accepted && parsed.decision.remember === true;
  let rememberAuthorized = false;
  let rememberCreated = false;
  if (rememberRequested && pending?.confirmId !== parsed.decision.id) {
    const relatedPending = pending
      ?? Array.from(session.pendingConfirms.values()).find(
        (item) => item.confirmId === parsed.decision.id,
      )
      ?? (session.pendingConfirms.size === 1
        ? session.pendingConfirms.values().next().value
        : undefined);
    if (relatedPending) {
      await service.recordRememberRejected(
        session,
        relatedPending,
        parsed.decision.accepted,
        "stale-confirm",
      );
    }
  }
  if (rememberRequested && pending?.confirmId === parsed.decision.id) {
    if (pending.spec.kind === "send" || pending.spec.kind === "connect") {
      await service.recordRememberRejected(
        session,
        pending,
        parsed.decision.accepted,
        "forbidden-kind",
      );
      return c.json({ error: "该类别始终需要确认" }, 400);
    }
    if (pending.spec.kind === "install" || pending.spec.kind === "command") {
      if (pending.spec.rememberCategory?.kind !== pending.spec.kind) {
        await service.recordRememberRejected(
          session,
          pending,
          parsed.decision.accepted,
          "undeclared-category",
        );
      } else {
        const consumed = consumeUiGrant({
          purpose: "confirm",
          nonce: parsed.decision.uiGrantNonce,
          sessionId: parsed.sessionId,
          confirmId: parsed.decision.id,
          kind: pending.spec.kind,
        });
        rememberAuthorized = (
          process.env.NODE_ENV === "development" &&
          allowInsecureRemember()
        ) || consumed.ok;
        if (!rememberAuthorized) {
          await service.recordRememberRejected(
            session,
            pending,
            parsed.decision.accepted,
            consumed.reason ?? "invalid",
          );
        }
      }
    }
  }
  if (parsed.decision.secretValue !== undefined) {
    service.stageSecret(session, {
      confirmId: parsed.decision.id,
      toolCallId: parsed.toolCallId,
      value: parsed.decision.secretValue,
    });
  }
  const safe = safeSubmission(parsed);

  try {
    await runExclusive(parsed.sessionId, () => decide(safe, {
      ...(rememberRequested && rememberAuthorized
        ? {
            onAccepted: async (current) => {
              if (current.spec.kind !== "install" && current.spec.kind !== "command") return null;
              if (current.spec.rememberCategory?.kind !== current.spec.kind) return null;
              const creation = await createGrant({ kind: current.spec.kind, source: "card" });
              if ("grant" in creation) {
                rememberCreated = creation.created;
                return creation.grant;
              }
              // 兼容注入旧式 createGrant 的调用方；该接口每次调用都表示新建成功。
              rememberCreated = true;
              return creation;
            },
          }
        : {}),
    }));
    return c.json({ accepted: true, remembered: rememberCreated });
  } catch (error) {
    service.discardSecret(session, parsed.decision.id);
    if (error instanceof SessionActorQueueFullError) {
      return c.json({ error: "会话命令队列已满" }, 429);
    }
    const known = decisionError(error);
    if (known) return c.json({ error: known.message }, errorStatus(known.code));
    return c.json({ error: "确认处理失败，命令未执行" }, 500);
  }
  });

  return routes;
}

export const confirmRoutes = createConfirmRoutes();

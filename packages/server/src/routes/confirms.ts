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
import { applyBypassMode, cancelConfirmedCommand } from "@qingagent/core";
import {
  getOrRestoreSession,
  sessionManager,
} from "../gateway/bridgeHandler";
import { handleConfirmDecision } from "../gateway/confirmRuntime";
import {
  SessionActorCommandError,
  SessionActorExternalLeaseHeldError,
  SessionActorQueueFullError,
  type EnqueueTaskOptions,
} from "../gateway/sessionActor";
import { requireTrustedOrigin } from "../lib/trustedOrigin";
import {
  createConfirmGrantCanonical,
  type ConfirmGrantCanonical,
  type ConfirmGrantMutation,
} from "@qingagent/db";
import {
  consumeConfirmUiGrant,
  insecureRememberAllowed,
} from "../lib/confirmUiGrant";
import { attachOperationDenied, isAttachRequest } from "../lib/attachPolicy";

const MAX_CONFIRM_BODY_BYTES = 16 * 1024;
const CONFIRM_NOT_AVAILABLE_MESSAGE = "这张确认已处理或已失效，请查看命令结果。";
const CONFIRM_SUBMISSION_UNKNOWN_MESSAGE = "确认没有提交成功，命令尚未确定是否执行。请先查看命令卡，不要连续重复点击。";
const CONFIRM_EXECUTION_UNKNOWN_MESSAGE =
  "确认提交异常，命令执行状态未能确认；请先查看命令卡，不要重复提交。";

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
    bypassAll: _bypassAll,
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

function presentDecisionError(error: ConfirmDecisionError): string {
  if (error.code === "expired") return error.message;
  if (error.code === "not_found") return CONFIRM_NOT_AVAILABLE_MESSAGE;
  return CONFIRM_SUBMISSION_UNKNOWN_MESSAGE;
}

interface ConfirmRoutesDependencies {
  getSession?: typeof getOrRestoreSession;
  runExclusive?: (
    sessionId: string,
    task: () => AsyncGenerator<BridgeFrame>,
    options?: EnqueueTaskOptions,
  ) => Promise<unknown>;
  handleDecision?: typeof handleConfirmDecision;
  service?: ConfirmService;
  consumeUiGrant?: typeof consumeConfirmUiGrant;
  insecureRememberAllowed?: () => boolean;
  createGrant?: (input: {
    kind: "install" | "command" | "send" | "connect";
    source: "card";
    expectedRevocationEpoch: number;
  }) => Promise<ConfirmGrantMutation>;
  cancelCommand?: typeof cancelConfirmedCommand;
  applyBypass?: typeof applyBypassMode;
}

export function createConfirmRoutes(
  dependencies: ConfirmRoutesDependencies = {},
): Hono {
  const routes = new Hono();
  const getSession = dependencies.getSession ?? getOrRestoreSession;
  const runExclusive = dependencies.runExclusive
    ?? ((sessionId, task, options) =>
      sessionManager.runExclusive(sessionId, task, options));
  const decide = dependencies.handleDecision ?? handleConfirmDecision;
  const service = dependencies.service ?? confirmService;
  const consumeUiGrant = dependencies.consumeUiGrant ?? consumeConfirmUiGrant;
  const allowInsecureRemember = dependencies.insecureRememberAllowed
    ?? insecureRememberAllowed;
  const createGrant = dependencies.createGrant ?? createConfirmGrantCanonical;
  const cancelCommand = dependencies.cancelCommand ?? cancelConfirmedCommand;
  const applyBypass = dependencies.applyBypass ?? applyBypassMode;

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
      return c.json({ error: CONFIRM_SUBMISSION_UNKNOWN_MESSAGE }, 400);
    }
    parsed = result.data;
  } catch (error) {
    const known = decisionError(error);
    return c.json(
      { error: known ? presentDecisionError(known) : CONFIRM_SUBMISSION_UNKNOWN_MESSAGE },
      known ? errorStatus(known.code) : 400,
    );
  }

  // attach 的 confirmGrant=false：仅允许本次裁决，禁止“记住”或全局 bypass 写入。
  if (
    isAttachRequest(c)
    && (parsed.decision.remember === true || parsed.decision.bypassAll === true)
  ) return attachOperationDenied(c);

  const session = await getSession(parsed.sessionId);
  if (!session) return c.json({ error: CONFIRM_NOT_AVAILABLE_MESSAGE }, 404);
  const pending = session.pendingConfirms.get(parsed.toolCallId);
  const rememberRequested = parsed.decision.accepted && parsed.decision.remember === true;
  let rememberAuthorized = false;
  let rememberCreated = false;
  let rememberFailure: "not-saved" | "settings-changed" | undefined;
  let canonicalGrantState: ConfirmGrantCanonical | undefined;
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
    // 四类确认都可记住:是否给出「记住」由确认卡自己的 rememberCategory 声明决定
    if (
      pending.spec.kind === "install" ||
      pending.spec.kind === "command" ||
      pending.spec.kind === "send" ||
      pending.spec.kind === "connect"
    ) {
      if (pending.spec.rememberCategory?.kind !== pending.spec.kind) {
        rememberFailure = "not-saved";
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
          rememberFailure = "not-saved";
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
  // 「以后不用再问我」:只认当前这张卡自己声明过该勾选、且用户点的是「同意」。
  // 卡片过期/串卡(confirmId 对不上)一律不认,避免旧卡越过用户后来的设置变更。
  const bypassAuthorized = Boolean(
    parsed.decision.accepted &&
    parsed.decision.bypassAll === true &&
    pending?.confirmId === parsed.decision.id &&
    pending?.spec.bypassOption,
  );
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
              // 四类都可落 grant;真正的门槛是这张卡自己声明了 rememberCategory
              if (current.spec.rememberCategory?.kind !== current.spec.kind) return null;
              if (current.rememberRevocationEpoch === undefined) {
                rememberFailure = "settings-changed";
                await service.recordRememberRejected(
                  session,
                  current,
                  true,
                  "missing-revocation-line",
                );
                return null;
              }
              const creation = await createGrant({
                kind: current.spec.kind,
                source: "card",
                expectedRevocationEpoch: current.rememberRevocationEpoch,
              });
              canonicalGrantState = {
                present: creation.state.present,
                grantId: creation.state.grantId,
                version: creation.state.version,
              };
              if (creation.stale) {
                rememberFailure = "settings-changed";
                await service.recordRememberRejected(
                  session,
                  current,
                  true,
                  "revocation-line-advanced",
                );
                return null;
              }
              rememberCreated = creation.created;
              return creation.grant;
            },
          }
        : {}),
    }), { agentTurnDispatch: true });
    // 决策已经落定后才切换全局开关:本次命令仍按用户刚刚看到的那张卡执行,
    // 从下一条命令起不再询问、不再隔离。切换会让已有会话立即换形态。
    let bypassEnabled = false;
    if (bypassAuthorized) {
      try {
        bypassEnabled = (await applyBypass(true)).enabled;
      } catch {
        // 开关没存上不影响本次操作;维持切换前的已知档位,不伪报已保存。
        console.error("[security-bypass] 保存「以后不用再问我」失败，维持当前档位");
      }
    }
    return c.json({
      accepted: true,
      remembered: rememberCreated,
      ...(bypassAuthorized ? { bypassEnabled } : {}),
      ...(canonicalGrantState ?? {}),
      ...(rememberFailure ? { rememberFailure } : {}),
    });
  } catch (error) {
    service.discardSecret(session, parsed.decision.id);
    if (error instanceof SessionActorQueueFullError) {
      return c.json({ error: "会话命令队列已满" }, 429);
    }
    if (error instanceof SessionActorExternalLeaseHeldError) {
      return c.json({
        error: "Agent 正在编辑，稍后再试",
        reason: "external_lease_held",
      }, 409);
    }
    const known = decisionError(error);
    if (known) return c.json({ error: presentDecisionError(known) }, errorStatus(known.code));
    return c.json({ error: CONFIRM_EXECUTION_UNKNOWN_MESSAGE }, 500);
  }
  });

  return routes;
}

export const confirmRoutes = createConfirmRoutes();

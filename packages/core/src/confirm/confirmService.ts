import type {
  BridgeFrame,
  ConfirmDecision,
  ConfirmResolved,
} from "@qingagent/contract-ts";
import { confirmDecisionForSpecSchema } from "@qingagent/contract-ts/schemas";
import {
  appendConfirmAuditEvent,
  getConfirmGrantState,
  type ConfirmAuditEvent,
  type ConfirmGrant,
  type ConfirmGrantKind,
  type ConfirmGrantState,
} from "@qingagent/db";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { evaluateCommandPolicy } from "../workspace/commandPolicy.js";
import { SANDBOX_BIN_DIR } from "../workspace/sandboxPaths.js";
import { SANDBOX_TIMEOUT_MS, sessionWorkspaceDir } from "../workspace/sessionWorkspace.js";
import { AGENT_FIRST_CHUNK_TIMEOUT_MS } from "../agent-run/agentLimits.js";
import type { PendingConfirm, SessionState } from "../session/sessionState.js";
import { persistSessionMetadata, schedulePersist } from "../session/threadPersistence.js";
import {
  APPROVAL_PROOF_TTL_MS,
  clearApprovalProof,
  clearAllApprovalProofs,
  issueApprovalProof,
} from "./approvalProof.js";
import {
  buildCommandConfirmSpec,
  commandConfirmationDigest,
  executeCommandInputSchema,
  INVALID_EXECUTE_COMMAND_ARGS_MESSAGE,
} from "./commandConfirmation.js";
import {
  buildConnectAccountConfirmSpec,
  CONNECT_ACCOUNT_AUTH_TOOLS,
  connectAccountConfirmationDigest,
  isConnectAccountAuthTool,
  parseConnectAccountAuthInput,
} from "./connectAccountConfirmation.js";
import {
  buildCredentialAccessConfirmSpec,
  checkRequestedCredentialAccess,
  credentialAccessDigest,
  effectiveCredentialHome,
  requestCredentialAccessInputSchema,
  REQUEST_CREDENTIAL_ACCESS_TOOL,
} from "./credentialAccessConfirmation.js";
import { markCredentialAccessRejected } from "./credentialAccessCooldown.js";
import { secretLeaseStore, type SecretLeaseStore } from "./secretLeaseStore.js";

// 确认卡有效期。体验优先:用户离开工位、被会议打断再回来点确认属于常态,
// 10 分钟经常不够(真机上出现过"这张确认卡已过期");挂起等待本就不进入任何
// 回合预算,放宽到 30 分钟不引入新的资源占用。
export const CONFIRM_TTL_MS = Math.max(
  60_000,
  Number(process.env.QINGAGENT_CONFIRM_TTL_MS) || 30 * 60 * 1_000,
);

/**
 * 用户已确认后,整条恢复流(命令执行 + 模型收尾)的兜底墙。
 *
 * 铁律:它必须严格宽于前台命令自身的预算 SANDBOX_TIMEOUT_MS。两者相等时(旧值
 * 双 120s),任何接近自身预算的已确认命令都会先被上层墙掐死——命令被 kill、
 * 卡片落成笼统失败/中止,用户永远看不到"已超时"这种可操作真因,模型拿到的也
 * 只有一句"命令已取消",于是编出"可能是确认弹窗没有及时点击"。(0729 真机 P1)
 */
export const CONFIRM_RESUME_WALL_TIMEOUT_MS = Math.max(
  Number(process.env.QINGAGENT_CONFIRM_RESUME_TIMEOUT_MS) || 0,
  SANDBOX_TIMEOUT_MS + AGENT_FIRST_CHUNK_TIMEOUT_MS + 30_000,
);

/** 确认卡被提前收走的来源。只进日志,不进模型上下文,也不进卡面。 */
export type ConfirmCancelSource =
  | "turn-cleanup:userAbort"
  | "turn-cleanup:preemptedByNewMessage"
  | "turn-cleanup:globalStop"
  | "abort-signal"
  | "request-self-abort"
  | "unknown";
export const CONFIRM_CAPABLE_TOOLS = new Set<string>([
  WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
  REQUEST_CREDENTIAL_ACCESS_TOOL,
  ...CONNECT_ACCOUNT_AUTH_TOOLS,
]);

export interface SafeSubmitConfirmDecision {
  sessionId: string;
  toolCallId: string;
  decisionId: string;
  decision: Omit<ConfirmDecision, "secretValue">;
  hasSecretValue: boolean;
}

export class ConfirmDecisionError extends Error {
  constructor(
    readonly code: "invalid" | "not_found" | "conflict" | "expired",
    message: string,
  ) {
    super(message);
    this.name = "ConfirmDecisionError";
  }
}

export interface ConfirmServiceOptions {
  now?: () => number;
  createId?: () => string;
  persist?: (state: SessionState, reason: string) => Promise<void>;
  retryPersist?: (state: SessionState, reason: string) => Promise<void>;
  secrets?: SecretLeaseStore;
  loadGrant?: (kind: ConfirmGrantKind) => Promise<ConfirmGrant | null>;
  loadGrantState?: (kind: ConfirmGrantKind) => Promise<ConfirmGrantState>;
  appendAudit?: (
    event: Omit<ConfirmAuditEvent, "eventId" | "ts">,
  ) => Promise<unknown>;
  issueProof?: typeof issueApprovalProof;
}

export type RequestCommandConfirmResult =
  | { ok: true; pending: PendingConfirm; frame: BridgeFrame; storedGrantApproval?: undefined }
  | {
      ok: true;
      pending: PendingConfirm;
      frame?: undefined;
      storedGrantApproval: { decisionId: string; grant: ConfirmGrant };
    }
  | { ok: false; reason: string; failureKind?: "invalid_args" };

interface DecisionReceipt {
  decisionId: string;
  toolCallId: string;
  confirmId: string;
  resolution: ConfirmResolved["resolution"];
  expiresAt: number;
}

type ConfirmTerminalPersistReason = `confirm:${ConfirmResolved["resolution"]}`;

interface TerminalTombstone {
  pending: PendingConfirm;
  reason: ConfirmTerminalPersistReason;
}

/**
 * 确认流水线。
 *
 * **260811 产品口径:全局默认是「不再询问」;用户显式改为「每次询问」时才进入本流水线。**
 * 处于「每次询问」档时,装/外发/破坏/连接四类操作必须完整弹卡,不能因新默认而削弱;
 * 用户改回「不再询问」后则由工具门禁直接放行。全局开关本身见 ../security/bypassMode.ts。
 *
 * 注意:总开关生效点在各工具门禁(gatedExecuteCommandTool 与连接器授权工具的
 * requireApproval)——开着时
 * 根本不会产生审批事件,本服务不会被调到;本服务自身**不做**任何"要不要弹"的降级,
 * 一旦被调到就一定按「每次询问」档老老实实走完确认。
 */
export class ConfirmService {
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #persist: (state: SessionState, reason: string) => Promise<void>;
  readonly #retryPersist: (state: SessionState, reason: string) => Promise<void>;
  readonly #secrets: SecretLeaseStore;
  readonly #loadGrantState: (kind: ConfirmGrantKind) => Promise<ConfirmGrantState>;
  readonly #appendAudit: (
    event: Omit<ConfirmAuditEvent, "eventId" | "ts">,
  ) => Promise<unknown>;
  readonly #issueProof: typeof issueApprovalProof;
  readonly #receipts = new WeakMap<SessionState, Map<string, DecisionReceipt>>();
  readonly #terminalTombstones = new WeakMap<
    SessionState,
    Map<string, TerminalTombstone>
  >();

  constructor(options: ConfirmServiceOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    // main 已把 persistSessionMetadata 改为失败无条件抛,无需再显式要求 rethrow
    this.#persist = options.persist ?? ((state, reason) => persistSessionMetadata(state, reason));
    // 生产走自带退避与 dirty 记账的 schedulePersist；注入 persist 的单测默认沿用同一替身。
    this.#retryPersist = options.retryPersist ?? options.persist ?? schedulePersist;
    this.#secrets = options.secrets ?? secretLeaseStore;
    this.#loadGrantState = options.loadGrantState
      ?? (options.loadGrant
        ? async (kind) => {
            const grant = await options.loadGrant!(kind);
            return {
              kind,
              present: grant !== null,
              grantId: grant?.grantId ?? null,
              version: grant ? 1 : 0,
              revocationEpoch: 0,
              grant,
            };
          }
        : getConfirmGrantState);
    this.#appendAudit = options.appendAudit ?? appendConfirmAuditEvent;
    this.#issueProof = options.issueProof ?? issueApprovalProof;
  }

  async requestCommandConfirm(input: {
    state: SessionState;
    runId: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
    aborted: boolean;
    abortSignal?: AbortSignal;
    sandboxBinDir?: string;
  }): Promise<RequestCommandConfirmResult> {
    const requestAborted = () => input.aborted || input.abortSignal?.aborted === true;
    if (requestAborted()) return { ok: false, reason: "确认请求已取消" };
    if (!CONFIRM_CAPABLE_TOOLS.has(input.toolName)) {
      return { ok: false, reason: "工具不支持确认通道" };
    }
    if (!input.runId || !input.toolCallId) {
      return { ok: false, reason: "确认请求缺少运行标识" };
    }
    // 凭证共享、连接器授权与命令确认共用同一条确认流水线,只是卡面与摘要口径不同。
    let confirmReason = "";
    const credentialAccess = input.toolName === REQUEST_CREDENTIAL_ACCESS_TOOL;
    const connectAccount = isConnectAccountAuthTool(input.toolName);
    let credential: { declared: string; reason: string; digest: string } | null = null;
    let connectorAuth: ReturnType<typeof parseConnectAccountAuthInput> = null;
    let parsed: ReturnType<typeof executeCommandInputSchema.safeParse> | null = null;
    let requiresExplicitApproval = false;
    if (credentialAccess) {
      const credentialArgs = requestCredentialAccessInputSchema.safeParse(input.args);
      if (!credentialArgs.success) {
        return {
          ok: false,
          failureKind: "invalid_args",
          reason: "工具参数为空或格式损坏，请重新以合法 JSON 发起，注意转义",
        };
      }
      const checked = checkRequestedCredentialAccess(
        credentialArgs.data,
        effectiveCredentialHome(),
      );
      if (!checked.ok) return { ok: false, reason: "确认请求与当前共享规则不匹配" };
      credential = {
        declared: checked.declared,
        reason: checked.reason,
        digest: credentialAccessDigest(input.state.sessionId, credentialArgs.data),
      };
    } else if (connectAccount) {
      connectorAuth = parseConnectAccountAuthInput(input.toolName, input.args);
      if (!connectorAuth) {
        return {
          ok: false,
          failureKind: "invalid_args",
          reason: "工具参数为空或格式损坏，请重新以合法 JSON 发起，注意转义",
        };
      }
    } else {
      parsed = executeCommandInputSchema.safeParse(input.args);
      if (!parsed.success) {
        return {
          ok: false,
          failureKind: "invalid_args",
          reason: INVALID_EXECUTE_COMMAND_ARGS_MESSAGE,
        };
      }
      const decision = evaluateCommandPolicy(parsed.data.command, {
        workspaceCwd: sessionWorkspaceDir(input.state.sessionId),
        background: parsed.data.background === true,
        sandboxBinDir: input.sandboxBinDir ?? SANDBOX_BIN_DIR,
      });
      if (decision.action !== "confirm") {
        return { ok: false, reason: "确认请求与当前命令策略不匹配" };
      }
      confirmReason = decision.reason;
      requiresExplicitApproval = decision.requiresExplicitApproval === true;
    }

    const existing = input.state.pendingConfirms.get(input.toolCallId);
    if (existing?.status === "pending") {
      return {
        ok: true,
        pending: existing,
        frame: this.requestedFrame(existing),
      };
    }
    if (existing) return { ok: false, reason: "确认请求已进入恢复阶段" };

    const now = this.#now();
    const confirmId = this.#createId();
    let spec;
    try {
      spec = credential
        ? buildCredentialAccessConfirmSpec(credential, confirmId)
        : connectorAuth
          ? buildConnectAccountConfirmSpec(connectorAuth, confirmId)
          : buildCommandConfirmSpec(parsed!.data, confirmReason, confirmId, {
              requiresExplicitApproval,
            });
    } catch {
      return { ok: false, reason: "确认卡无法安全生成" };
    }
    let grantState: ConfirmGrantState | null = null;
    // 普通命令可按类别存量授权放行；安全边界例外永远不读取这类授权。
    if (
      !requiresExplicitApproval &&
      (
        spec.kind === "install" ||
        spec.kind === "command" ||
        spec.kind === "send" ||
        spec.kind === "connect"
      )
    ) {
      try {
        grantState = await this.#loadGrantState(spec.kind);
      } catch (error) {
        if (requestAborted()) return { ok: false, reason: "确认请求已取消" };
        console.error("[confirm-audit] grant state lookup failed; showing confirm card", {
          sessionId: input.state.sessionId,
          confirmId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (requestAborted()) return { ok: false, reason: "确认请求已取消" };
    const pending: PendingConfirm = {
      confirmId,
      runId: input.runId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      commandDigest: credential
        ? credential.digest
        : connectorAuth
          ? connectAccountConfirmationDigest(input.state.sessionId, connectorAuth)
          : commandConfirmationDigest(input.state.sessionId, parsed!.data),
      spec,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CONFIRM_TTL_MS).toISOString(),
      status: "pending",
      ...(grantState
        ? { rememberRevocationEpoch: grantState.revocationEpoch }
        : {}),
    };
    input.state.pendingConfirms.set(input.toolCallId, pending);
    try {
      await this.#persist(input.state, "confirm:requested");
    } catch {
      input.state.pendingConfirms.delete(input.toolCallId);
      return { ok: false, reason: "确认请求无法安全持久化" };
    }
    if (requestAborted()) {
      await this.cancelRequestedCommandConfirm(input.state, pending, "request-self-abort");
      return { ok: false, reason: "确认请求已取消" };
    }
    if (grantState?.grant) {
      try {
        const grant = grantState.grant;
        const decisionId = await this.#approveFromStoredGrant(
          input.state,
          pending,
          grant,
          input.abortSignal,
        );
        if (requestAborted()) {
          await this.cancelRequestedCommandConfirm(input.state, pending, "request-self-abort");
          return { ok: false, reason: "确认请求已取消" };
        }
        return {
          ok: true,
          pending,
          storedGrantApproval: { decisionId, grant },
        };
      } catch (error) {
        if (requestAborted()) {
          await this.cancelRequestedCommandConfirm(input.state, pending, "request-self-abort");
          return { ok: false, reason: "确认请求已取消" };
        }
        if (
          error instanceof ConfirmDecisionError &&
          error.message === "存量确认已撤销" &&
          input.state.pendingConfirms.get(pending.toolCallId) === pending &&
          pending.status === "pending"
        ) {
          pending.spec = {
            ...pending.spec,
            notice: "设置刚刚发生变化，这次操作需要重新确认。",
          };
          await this.#persist(input.state, "confirm:revocation-race-notice").catch(() => undefined);
        }
        console.error("[confirm-audit] stored grant lookup/approval failed; showing confirm card", {
          sessionId: input.state.sessionId,
          confirmId: pending.confirmId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (
          input.state.pendingConfirms.get(pending.toolCallId) !== pending ||
          pending.status !== "pending"
        ) {
          return {
            ok: false,
            reason: "确认没有完成，命令没有执行。请重新确认后再试。",
          };
        }
      }
    }
    if (requestAborted()) {
      await this.cancelRequestedCommandConfirm(input.state, pending, "request-self-abort");
      return { ok: false, reason: "确认请求已取消" };
    }
    return { ok: true, pending, frame: this.requestedFrame(pending) };
  }

  /**
   * 仅供服务端确认流水线内部调用。它不进入 HTTP route、agent toolset 或模型上下文；
   * 每次命中都按当前 pending 的精确 digest 签发一张新的短时 proof。
   */
  async #approveFromStoredGrant(
    state: SessionState,
    pending: PendingConfirm,
    grant: ConfirmGrant,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    abortSignal?.throwIfAborted();
    const pendingExpiresAt = Date.parse(pending.expiresAt);
    if (
      state.pendingConfirms.get(pending.toolCallId) !== pending ||
      pending.status !== "pending" ||
      !CONFIRM_CAPABLE_TOOLS.has(pending.toolName) ||
      pending.spec.kind !== grant.kind ||
      !Number.isFinite(pendingExpiresAt) ||
      pendingExpiresAt <= this.#now()
    ) {
      throw new ConfirmDecisionError("conflict", "存量授权与确认请求不匹配");
    }
    const decisionId = `stored-${this.#createId()}`.slice(0, 128);
    pending.status = "resuming";
    pending.decisionId = decisionId;
    pending.decisionSource = "stored-grant";
    pending.decisionAccepted = true;
    pending.decisionGrantId = grant.grantId;
    try {
      await this.#persist(state, "confirm:stored-grant-resuming");
    } catch (error) {
      this.#resetStoredGrantDecision(pending);
      throw error;
    }
    try {
      abortSignal?.throwIfAborted();
      const currentState = await this.#loadGrantState(grant.kind);
      abortSignal?.throwIfAborted();
      if (!currentState.grant || currentState.grant.grantId !== grant.grantId) {
        throw new ConfirmDecisionError("conflict", "存量确认已撤销");
      }
      this.#issueProof(state, {
        sessionId: state.sessionId,
        runId: pending.runId,
        toolCallId: pending.toolCallId,
        commandDigest: pending.commandDigest,
        expiresAt: Math.min(
          Date.parse(pending.expiresAt),
          this.#now() + APPROVAL_PROOF_TTL_MS,
        ),
      });
      await this.#safeAppendAudit(state, pending, {
        eventType: "decision_started",
        decision: "accepted",
        source: "stored-grant",
        grantId: grant.grantId,
        result: "stored-grant-approved",
      });
      return decisionId;
    } catch (error) {
      clearApprovalProof(state, pending.toolCallId);
      await this.#rollbackStoredGrantDecision(state, pending);
      throw error;
    }
  }

  async cancelRequestedCommandConfirm(
    state: SessionState,
    pending: PendingConfirm,
    source: ConfirmCancelSource = "unknown",
  ): Promise<void> {
    // 真机排障唯一入口:确认卡被谁收走,一行日志说清。
    console.info("[confirm-lifecycle] confirm cancelled", {
      sessionId: state.sessionId,
      confirmId: pending.confirmId,
      toolCallId: pending.toolCallId,
      kind: pending.spec.kind,
      status: pending.status,
      source,
      requestedAt: pending.requestedAt,
      expiresAt: pending.expiresAt,
      waitedMs: Math.max(0, this.#now() - Date.parse(pending.requestedAt)),
    });
    clearApprovalProof(state, pending.toolCallId);
    this.#secrets.delete(state, pending.confirmId);
    if (state.pendingConfirms.get(pending.toolCallId) !== pending) return;
    state.pendingConfirms.delete(pending.toolCallId);
    this.#rememberTerminalTombstone(
      state,
      pending,
      "aborted",
      "confirm:aborted",
    );
    const auditPersisted = await this.#safeAppendAudit(state, pending, {
      eventType: "decision_failed",
      decision: "failed",
      source: pending.decisionSource ?? "ui",
      grantId: pending.decisionGrantId ?? null,
      result: "request-cancelled",
    });
    try {
      await this.#persistTerminalDecisionState(state, "confirm:aborted");
    } catch (error) {
      // 审计账本中的取消墓碑与 metadata 终态是两条独立 durable 路径。
      // 只要前者成功，metadata 双写失败也不能让旧 pending 在冷恢复后复活。
      if (!auditPersisted) throw error;
    }
  }

  refreshApprovalProofForResume(
    state: SessionState,
    pending: PendingConfirm,
  ): void {
    const pendingExpiresAt = Date.parse(pending.expiresAt);
    if (
      state.pendingConfirms.get(pending.toolCallId) !== pending ||
      pending.status !== "resuming" ||
      pending.decisionAccepted !== true ||
      !CONFIRM_CAPABLE_TOOLS.has(pending.toolName) ||
      !Number.isFinite(pendingExpiresAt) ||
      pendingExpiresAt <= this.#now()
    ) {
      clearApprovalProof(state, pending.toolCallId);
      throw new ConfirmDecisionError("expired", "确认授权已经失效");
    }
    this.#issueProof(state, {
      sessionId: state.sessionId,
      runId: pending.runId,
      toolCallId: pending.toolCallId,
      commandDigest: pending.commandDigest,
      expiresAt: Math.min(
        pendingExpiresAt,
        this.#now() + APPROVAL_PROOF_TTL_MS,
      ),
    });
  }

  #resetStoredGrantDecision(pending: PendingConfirm): void {
    pending.status = "pending";
    delete pending.decisionId;
    delete pending.decisionSource;
    delete pending.decisionAccepted;
    delete pending.decisionGrantId;
  }

  async #rollbackStoredGrantDecision(
    state: SessionState,
    pending: PendingConfirm,
  ): Promise<void> {
    const decision = {
      status: pending.status,
      decisionId: pending.decisionId,
      decisionSource: pending.decisionSource,
      decisionAccepted: pending.decisionAccepted,
      decisionGrantId: pending.decisionGrantId,
    };
    this.#resetStoredGrantDecision(pending);
    try {
      await this.#persist(state, "confirm:stored-grant-rollback");
    } catch (error) {
      // durable snapshot 仍是 resuming；内存也恢复同态，交给恢复路径 fail-closed 收口。
      pending.status = decision.status;
      pending.decisionId = decision.decisionId;
      pending.decisionSource = decision.decisionSource;
      pending.decisionAccepted = decision.decisionAccepted;
      pending.decisionGrantId = decision.decisionGrantId;
      throw error;
    }
  }

  stageSecret(
    state: SessionState,
    input: { confirmId: string; toolCallId: string; value: string },
  ): void {
    const pending = state.pendingConfirms.get(input.toolCallId);
    this.#secrets.put(state, {
      ...input,
      expiresAt: pending ? Date.parse(pending.expiresAt) : this.#now() + 60_000,
    });
  }

  discardSecret(state: SessionState, confirmId: string): void {
    this.#secrets.delete(state, confirmId);
  }

  async beginDecision(
    state: SessionState,
    submission: SafeSubmitConfirmDecision,
  ): Promise<{ pending: PendingConfirm; idempotent: boolean; resolution: ConfirmResolved["resolution"] }> {
    this.#pruneReceipts(state);
    const receipt = this.#receipts.get(state)?.get(submission.decisionId);
    if (receipt) {
      // 幂等重试可能再次携带 secret；已完成请求不再有消费者，立即销毁本次 lease。
      this.#secrets.delete(state, submission.decision.id);
      if (
        receipt.toolCallId !== submission.toolCallId ||
        receipt.confirmId !== submission.decision.id
      ) {
        throw new ConfirmDecisionError("conflict", "确认决策标识已用于其他请求");
      }
      return {
        pending: {
          confirmId: receipt.confirmId,
          runId: "",
          toolCallId: receipt.toolCallId,
          toolName: "",
          commandDigest: "",
          spec: {
            id: receipt.confirmId,
            kind: "command",
            title: "确认",
            say: "确认已处理",
            footHint: "确认已处理",
            primaryLabel: "确认",
            secondaryLabel: "取消",
          },
          requestedAt: new Date(0).toISOString(),
          expiresAt: new Date(receipt.expiresAt).toISOString(),
          status: "resuming",
          decisionId: receipt.decisionId,
        },
        idempotent: true,
        resolution: receipt.resolution,
      };
    }

    const completedConfirm = Array.from(this.#receipts.get(state)?.values() ?? []).find(
      (item) =>
        item.toolCallId === submission.toolCallId &&
        item.confirmId === submission.decision.id,
    );
    if (completedConfirm) {
      throw new ConfirmDecisionError("conflict", "确认请求已经被处理");
    }

    if (state.sessionId !== submission.sessionId) {
      throw new ConfirmDecisionError("not_found", "没有可处理的确认请求");
    }
    const pending = state.pendingConfirms.get(submission.toolCallId);
    if (!pending || pending.confirmId !== submission.decision.id) {
      this.#secrets.delete(state, submission.decision.id);
      throw new ConfirmDecisionError("not_found", "没有可处理的确认请求");
    }
    if (pending.status === "resuming") {
      if (pending.decisionId === submission.decisionId) {
        return {
          pending,
          idempotent: true,
          resolution: submission.decision.accepted ? "accepted" : "rejected",
        };
      }
      this.#secrets.delete(state, pending.confirmId);
      throw new ConfirmDecisionError("conflict", "确认请求已经被处理");
    }
    if (pending.status === "terminal") {
      this.#secrets.delete(state, pending.confirmId);
      throw new ConfirmDecisionError("conflict", "确认请求已经被处理");
    }
    if (Date.parse(pending.expiresAt) <= this.#now()) {
      this.#secrets.delete(state, pending.confirmId);
      throw new ConfirmDecisionError(
        "expired",
        "这张确认卡已过期，命令没有执行。请重新确认。",
      );
    }

    const secretPresent = this.#secrets.has(state, {
      confirmId: pending.confirmId,
      toolCallId: pending.toolCallId,
    });
    if (secretPresent !== submission.hasSecretValue) {
      this.#secrets.delete(state, pending.confirmId);
      throw new ConfirmDecisionError("invalid", "确认字段与卡片不匹配");
    }
    if (
      submission.hasSecretValue &&
      !this.#secrets.hasUsableValue(state, {
        confirmId: pending.confirmId,
        toolCallId: pending.toolCallId,
      })
    ) {
      this.#secrets.delete(state, pending.confirmId);
      throw new ConfirmDecisionError("invalid", "确认字段与卡片不匹配");
    }
    const decisionForValidation: ConfirmDecision = submission.hasSecretValue
      ? { ...submission.decision, secretValue: "present" }
      : submission.decision;
    if (!confirmDecisionForSpecSchema(pending.spec).safeParse(decisionForValidation).success) {
      this.#secrets.delete(state, pending.confirmId);
      throw new ConfirmDecisionError("invalid", "确认字段与卡片不匹配");
    }

    pending.status = "resuming";
    pending.decisionId = submission.decisionId;
    pending.decisionSource = "ui";
    pending.decisionAccepted = submission.decision.accepted;
    // pending 恢复或异常重试不得把上一轮 grant 归因带入本次 UI 决策。
    delete pending.decisionGrantId;
    try {
      await this.#persist(state, "confirm:resuming");
    } catch {
      pending.status = "pending";
      delete pending.decisionId;
      delete pending.decisionSource;
      delete pending.decisionAccepted;
      this.#secrets.delete(state, pending.confirmId);
      throw new ConfirmDecisionError("conflict", "确认状态无法安全持久化");
    }

    if (submission.decision.accepted && CONFIRM_CAPABLE_TOOLS.has(pending.toolName)) {
      try {
        this.#issueProof(state, {
          sessionId: state.sessionId,
          runId: pending.runId,
          toolCallId: pending.toolCallId,
          commandDigest: pending.commandDigest,
          expiresAt: Math.min(
            Date.parse(pending.expiresAt),
            this.#now() + APPROVAL_PROOF_TTL_MS,
          ),
        });
      } catch {
        clearApprovalProof(state, pending.toolCallId);
        try {
          await this.#rollbackStoredGrantDecision(state, pending);
        } catch {
          throw new ConfirmDecisionError("conflict", "确认授权签发失败，状态等待恢复");
        }
        throw new ConfirmDecisionError("conflict", "确认授权签发失败，请重试");
      }
    } else {
      clearApprovalProof(state, pending.toolCallId);
      // 拒绝共享后同一位置进入冷却,模型再申请也不再弹卡骚扰。
      if (pending.toolName === REQUEST_CREDENTIAL_ACCESS_TOOL && pending.spec.sub) {
        markCredentialAccessRejected(state, pending.spec.sub, this.#now());
      }
    }
    await this.#safeAppendAudit(state, pending, {
      eventType: "decision_started",
      decision: submission.decision.accepted ? "accepted" : "rejected",
      source: "ui",
      grantId: null,
      result: "decision-validated",
    });
    return {
      pending,
      idempotent: false,
      resolution: submission.decision.accepted ? "accepted" : "rejected",
    };
  }

  attachRememberedGrant(pending: PendingConfirm, grant: ConfirmGrant): void {
    if (pending.decisionSource !== "ui" || pending.decisionAccepted !== true) return;
    if (pending.spec.kind !== grant.kind) return;
    pending.decisionGrantId = grant.grantId;
  }

  async recordRememberRejected(
    state: SessionState,
    pending: PendingConfirm,
    accepted: boolean,
    reason: string,
  ): Promise<void> {
    await this.#safeAppendAudit(state, pending, {
      eventType: "remember_rejected",
      decision: accepted ? "accepted" : "rejected",
      source: "ui",
      grantId: null,
      result: `remember-rejected:${reason}`,
    });
  }

  async finishDecision(
    state: SessionState,
    pending: PendingConfirm,
    decisionId: string,
    resolution: ConfirmResolved["resolution"],
  ): Promise<void> {
    this.finishDecisionInMemory(state, pending, decisionId, resolution);
    try {
      await this.persistDecisionState(state, `confirm:${resolution}`);
    } finally {
      await this.recordDecisionFinished(state, pending, resolution);
    }
  }

  finishDecisionInMemory(
    state: SessionState,
    pending: PendingConfirm,
    decisionId: string,
    resolution: ConfirmResolved["resolution"],
  ): void {
    clearApprovalProof(state, pending.toolCallId);
    this.#secrets.delete(state, pending.confirmId);
    if (state.pendingConfirms.get(pending.toolCallId) === pending) {
      state.pendingConfirms.delete(pending.toolCallId);
      this.#rememberTerminalTombstone(
        state,
        pending,
        resolution,
        `confirm:${resolution}`,
      );
    }
    let receipts = this.#receipts.get(state);
    if (!receipts) {
      receipts = new Map();
      this.#receipts.set(state, receipts);
    }
    receipts.set(decisionId, {
      decisionId,
      toolCallId: pending.toolCallId,
      confirmId: pending.confirmId,
      resolution,
      expiresAt: this.#now() + CONFIRM_TTL_MS,
    });
  }

  async failDecision(state: SessionState, pending: PendingConfirm): Promise<void> {
    this.failDecisionInMemory(state, pending);
    try {
      await this.persistDecisionState(state, "confirm:failed");
    } finally {
      await this.recordDecisionFailed(state, pending);
    }
  }

  failDecisionInMemory(state: SessionState, pending: PendingConfirm): void {
    clearApprovalProof(state, pending.toolCallId);
    this.#secrets.delete(state, pending.confirmId);
    if (state.pendingConfirms.get(pending.toolCallId) === pending) {
      state.pendingConfirms.delete(pending.toolCallId);
      this.#rememberTerminalTombstone(
        state,
        pending,
        "failed",
        "confirm:failed",
      );
    }
  }

  async expireDecision(state: SessionState, pending: PendingConfirm): Promise<void> {
    this.expireDecisionInMemory(state, pending);
    try {
      await this.persistDecisionState(state, "confirm:expired");
    } finally {
      await this.recordDecisionExpired(state, pending);
    }
  }

  expireDecisionInMemory(state: SessionState, pending: PendingConfirm): void {
    clearApprovalProof(state, pending.toolCallId);
    this.#secrets.delete(state, pending.confirmId);
    if (state.pendingConfirms.get(pending.toolCallId) === pending) {
      state.pendingConfirms.delete(pending.toolCallId);
      this.#rememberTerminalTombstone(
        state,
        pending,
        "expired",
        "confirm:expired",
      );
    }
  }

  persistDecisionState(
    state: SessionState,
    reason: ConfirmTerminalPersistReason,
  ): Promise<void> {
    return this.#persistTerminalDecisionState(state, reason);
  }

  recordDecisionFinished(
    state: SessionState,
    pending: PendingConfirm,
    resolution: ConfirmResolved["resolution"],
  ): Promise<void> {
    return this.#recordAudit(state, pending, {
      eventType: "decision_finished",
      decision: resolution === "accepted" ? "accepted" : "rejected",
      source: pending.decisionSource ?? "ui",
      grantId: pending.decisionGrantId ?? null,
      result: resolution,
    });
  }

  recordDecisionFailed(
    state: SessionState,
    pending: PendingConfirm,
  ): Promise<void> {
    return this.#recordAudit(state, pending, {
      eventType: "decision_failed",
      decision: "failed",
      source: pending.decisionSource ?? "ui",
      grantId: pending.decisionGrantId ?? null,
      result: "failed",
    });
  }

  recordDecisionExpired(
    state: SessionState,
    pending: PendingConfirm,
  ): Promise<void> {
    return this.#recordAudit(state, pending, {
      eventType: "decision_expired",
      decision: "expired",
      source: "expired",
      grantId: null,
      result: "expired",
    });
  }

  clearSession(state: SessionState): void {
    clearAllApprovalProofs(state);
    this.#secrets.clear(state);
    this.#receipts.delete(state);
    this.#terminalTombstones.delete(state);
    state.pendingConfirms.clear();
  }

  requestedFrame(pending: PendingConfirm): BridgeFrame {
    return {
      kind: "confirmRequested",
      data: {
        toolCallId: pending.toolCallId,
        spec: pending.spec,
        requestedAt: pending.requestedAt,
        expiresAt: pending.expiresAt,
      },
    };
  }

  resolvedFrame(
    pending: PendingConfirm,
    resolution: ConfirmResolved["resolution"],
    message?: string,
  ): BridgeFrame {
    return {
      kind: "confirmResolved",
      data: {
        id: pending.confirmId,
        toolCallId: pending.toolCallId,
        resolution,
        ...(message ? { message } : {}),
      },
    };
  }

  #pruneReceipts(state: SessionState): void {
    const receipts = this.#receipts.get(state);
    if (!receipts) return;
    const now = this.#now();
    for (const [id, receipt] of receipts) {
      if (receipt.expiresAt <= now) receipts.delete(id);
    }
    if (receipts.size === 0) this.#receipts.delete(state);
  }

  #rememberTerminalTombstone(
    state: SessionState,
    pending: PendingConfirm,
    resolution: ConfirmResolved["resolution"],
    reason: ConfirmTerminalPersistReason,
  ): void {
    let tombstones = this.#terminalTombstones.get(state);
    if (!tombstones) {
      tombstones = new Map();
      this.#terminalTombstones.set(state, tombstones);
    }
    tombstones.set(pending.toolCallId, {
      pending: {
        ...pending,
        status: "terminal",
        terminalResolution: resolution,
      },
      reason,
    });
  }

  async #persistTerminalDecisionState(
    state: SessionState,
    reason: ConfirmTerminalPersistReason,
  ): Promise<void> {
    const tombstones = Array.from(
      this.#terminalTombstones.get(state)?.values() ?? [],
    ).filter((item) => item.reason === reason);
    if (tombstones.length === 0) {
      await this.#persist(state, reason);
      return;
    }

    // main 要求先把 live pending 从内存移除，避免慢存储阻塞会话清理；墓碑只放进
    // 独立快照落盘，既保留分支的防复活语义，也不会让已结束确认重新暴露为活状态。
    const terminalState: SessionState = {
      ...state,
      pendingConfirms: new Map(state.pendingConfirms),
    };
    for (const tombstone of tombstones) {
      terminalState.pendingConfirms.set(
        tombstone.pending.toolCallId,
        tombstone.pending,
      );
    }

    try {
      await this.#persist(terminalState, `${reason}:terminal`);
    } catch (error) {
      this.#queueTerminalPersistRetry(state, terminalState, tombstones, reason);
      throw error;
    }

    this.#forgetTerminalTombstones(state, tombstones);
    try {
      await this.#persist(state, reason);
    } catch (error) {
      this.#queueCleanupPersistRetry(state, reason);
      throw error;
    }
  }

  #queueTerminalPersistRetry(
    state: SessionState,
    terminalState: SessionState,
    tombstones: TerminalTombstone[],
    reason: ConfirmTerminalPersistReason,
  ): void {
    void this.#retryPersist(terminalState, `${reason}:terminal-retry`).then(async () => {
      this.#forgetTerminalTombstones(state, tombstones);
      await this.#retryPersist(state, `${reason}:cleanup-retry`);
    }).catch((error) => {
      console.error("[confirm-persist] terminal retry failed; session remains dirty", {
        sessionId: state.sessionId,
        confirmIds: tombstones.map((item) => item.pending.confirmId),
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  #forgetTerminalTombstones(
    state: SessionState,
    tombstones: TerminalTombstone[],
  ): void {
    const current = this.#terminalTombstones.get(state);
    if (!current) return;
    for (const tombstone of tombstones) {
      if (current.get(tombstone.pending.toolCallId) === tombstone) {
        current.delete(tombstone.pending.toolCallId);
      }
    }
    if (current.size === 0) this.#terminalTombstones.delete(state);
  }

  #queueCleanupPersistRetry(
    state: SessionState,
    reason: ConfirmTerminalPersistReason,
  ): void {
    void this.#retryPersist(state, `${reason}:cleanup-retry`).catch((error) => {
      console.error("[confirm-persist] cleanup retry failed; terminal tombstone remains durable", {
        sessionId: state.sessionId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async #safeAppendAudit(
    state: SessionState,
    pending: PendingConfirm,
    input: Pick<
      ConfirmAuditEvent,
      "eventType" | "decision" | "source" | "grantId" | "result"
    >,
  ): Promise<boolean> {
    try {
      await this.#appendAudit({
        ...input,
        subjectId: "local-user",
        sessionId: state.sessionId,
        runId: pending.runId,
        toolCallId: pending.toolCallId,
        confirmId: pending.confirmId,
        kind: pending.spec.kind,
        commandDigest: pending.commandDigest,
        commandPreview: pending.spec.commandPreview ?? "",
        policyVersion: "command-policy-v1",
        isolationEpoch: null,
        configHash: null,
      });
      return true;
    } catch (error) {
      const previous = state.confirmAuditDegraded;
      state.confirmAuditDegraded = {
        failureCount: (previous?.failureCount ?? 0) + 1,
        lastFailedAt: new Date(this.#now()).toISOString(),
        lastEventType: input.eventType,
        lastConfirmId: pending.confirmId,
      };
      console.error("[confirm-audit] append failed", {
        sessionId: state.sessionId,
        confirmId: pending.confirmId,
        eventType: input.eventType,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await this.#retryPersist(state, "confirm:audit-degraded");
      } catch (persistError) {
        console.error("[confirm-audit] degraded marker persist failed; session remains dirty", {
          sessionId: state.sessionId,
          confirmId: pending.confirmId,
          eventType: input.eventType,
          error: persistError instanceof Error ? persistError.message : String(persistError),
        });
      }
      return false;
    }
  }

  async #recordAudit(
    state: SessionState,
    pending: PendingConfirm,
    input: Pick<
      ConfirmAuditEvent,
      "eventType" | "decision" | "source" | "grantId" | "result"
    >,
  ): Promise<void> {
    await this.#safeAppendAudit(state, pending, input);
  }
}

export const confirmService = new ConfirmService();

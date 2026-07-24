import type {
  BridgeFrame,
  ConfirmDecision,
  ConfirmResolved,
} from "@qingagent/contract-ts";
import { confirmDecisionForSpecSchema } from "@qingagent/contract-ts/schemas";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { evaluateCommandPolicy } from "../workspace/commandPolicy.js";
import { SANDBOX_BIN_DIR } from "../workspace/sandboxPaths.js";
import { sessionWorkspaceDir } from "../workspace/sessionWorkspace.js";
import type { PendingConfirm, SessionState } from "../session/sessionState.js";
import { persistSessionMetadata } from "../session/threadPersistence.js";
import { clearApprovalProof, clearAllApprovalProofs, issueApprovalProof } from "./approvalProof.js";
import {
  buildCommandConfirmSpec,
  commandConfirmationDigest,
  executeCommandInputSchema,
} from "./commandConfirmation.js";
import { secretLeaseStore, type SecretLeaseStore } from "./secretLeaseStore.js";

export const CONFIRM_TTL_MS = 10 * 60 * 1_000;
export const CONFIRM_CAPABLE_TOOLS = new Set<string>([
  WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
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
  secrets?: SecretLeaseStore;
}

export type RequestCommandConfirmResult =
  | { ok: true; pending: PendingConfirm; frame: BridgeFrame }
  | { ok: false; reason: string };

interface DecisionReceipt {
  decisionId: string;
  toolCallId: string;
  confirmId: string;
  resolution: ConfirmResolved["resolution"];
  expiresAt: number;
}

export class ConfirmService {
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #persist: (state: SessionState, reason: string) => Promise<void>;
  readonly #secrets: SecretLeaseStore;
  readonly #receipts = new WeakMap<SessionState, Map<string, DecisionReceipt>>();

  constructor(options: ConfirmServiceOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    // main 已把 persistSessionMetadata 改为失败无条件抛,无需再显式要求 rethrow
    this.#persist = options.persist ?? ((state, reason) => persistSessionMetadata(state, reason));
    this.#secrets = options.secrets ?? secretLeaseStore;
  }

  async requestCommandConfirm(input: {
    state: SessionState;
    runId: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
    aborted: boolean;
    sandboxBinDir?: string;
  }): Promise<RequestCommandConfirmResult> {
    if (input.aborted) return { ok: false, reason: "确认请求已取消" };
    if (!CONFIRM_CAPABLE_TOOLS.has(input.toolName)) {
      return { ok: false, reason: "工具不支持确认通道" };
    }
    if (!input.runId || !input.toolCallId) {
      return { ok: false, reason: "确认请求缺少运行标识" };
    }
    const parsed = executeCommandInputSchema.safeParse(input.args);
    if (!parsed.success) return { ok: false, reason: "确认请求参数无效" };
    const decision = evaluateCommandPolicy(parsed.data.command, {
      workspaceCwd: sessionWorkspaceDir(input.state.sessionId),
      background: parsed.data.background === true,
      sandboxBinDir: input.sandboxBinDir ?? SANDBOX_BIN_DIR,
    });
    if (decision.action !== "confirm") {
      return { ok: false, reason: "确认请求与当前命令策略不匹配" };
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
      spec = buildCommandConfirmSpec(parsed.data, decision.reason, confirmId);
    } catch {
      return { ok: false, reason: "确认卡无法安全生成" };
    }
    const pending: PendingConfirm = {
      confirmId,
      runId: input.runId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      commandDigest: commandConfirmationDigest(input.state.sessionId, parsed.data),
      spec,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CONFIRM_TTL_MS).toISOString(),
      status: "pending",
    };
    input.state.pendingConfirms.set(input.toolCallId, pending);
    try {
      await this.#persist(input.state, "confirm:requested");
    } catch {
      input.state.pendingConfirms.delete(input.toolCallId);
      return { ok: false, reason: "确认请求无法安全持久化" };
    }
    return { ok: true, pending, frame: this.requestedFrame(pending) };
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
    if (Date.parse(pending.expiresAt) <= this.#now()) {
      this.#secrets.delete(state, pending.confirmId);
      throw new ConfirmDecisionError("expired", "确认请求已过期");
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
    try {
      await this.#persist(state, "confirm:resuming");
    } catch {
      pending.status = "pending";
      delete pending.decisionId;
      this.#secrets.delete(state, pending.confirmId);
      throw new ConfirmDecisionError("conflict", "确认状态无法安全持久化");
    }

    if (submission.decision.accepted && pending.toolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND) {
      issueApprovalProof(state, {
        sessionId: state.sessionId,
        runId: pending.runId,
        toolCallId: pending.toolCallId,
        commandDigest: pending.commandDigest,
        expiresAt: Math.min(Date.parse(pending.expiresAt), this.#now() + 60_000),
      });
    } else {
      clearApprovalProof(state, pending.toolCallId);
    }
    return {
      pending,
      idempotent: false,
      resolution: submission.decision.accepted ? "accepted" : "rejected",
    };
  }

  async finishDecision(
    state: SessionState,
    pending: PendingConfirm,
    decisionId: string,
    resolution: ConfirmResolved["resolution"],
  ): Promise<void> {
    this.finishDecisionInMemory(state, pending, decisionId, resolution);
    await this.persistDecisionState(state, `confirm:${resolution}`);
  }

  finishDecisionInMemory(
    state: SessionState,
    pending: PendingConfirm,
    decisionId: string,
    resolution: ConfirmResolved["resolution"],
  ): void {
    clearApprovalProof(state, pending.toolCallId);
    this.#secrets.delete(state, pending.confirmId);
    state.pendingConfirms.delete(pending.toolCallId);
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
    await this.persistDecisionState(state, "confirm:failed");
  }

  failDecisionInMemory(state: SessionState, pending: PendingConfirm): void {
    clearApprovalProof(state, pending.toolCallId);
    this.#secrets.delete(state, pending.confirmId);
    state.pendingConfirms.delete(pending.toolCallId);
  }

  async expireDecision(state: SessionState, pending: PendingConfirm): Promise<void> {
    this.expireDecisionInMemory(state, pending);
    await this.persistDecisionState(state, "confirm:expired");
  }

  expireDecisionInMemory(state: SessionState, pending: PendingConfirm): void {
    clearApprovalProof(state, pending.toolCallId);
    this.#secrets.delete(state, pending.confirmId);
    state.pendingConfirms.delete(pending.toolCallId);
  }

  persistDecisionState(
    state: SessionState,
    reason:
      | `confirm:${ConfirmResolved["resolution"]}`
      | "confirm:failed"
      | "confirm:expired",
  ): Promise<void> {
    return this.#persist(state, reason);
  }

  clearSession(state: SessionState): void {
    clearAllApprovalProofs(state);
    this.#secrets.clear(state);
    this.#receipts.delete(state);
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
}

export const confirmService = new ConfirmService();

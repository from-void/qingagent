import type {
  BridgeFrame,
  ToolCallSpec,
} from "@qingagent/contract-ts";
import { mastra } from "../mastra.js";
import { ABORT_CLEANUP_ACTIVE_TURN_TIMEOUT_MS } from "./agentLimits.js";
import {
  streamEnd,
  toolCallUpdated,
} from "./frames.js";
import type { SessionState } from "../session/sessionState.js";
import {
  clearStaleSuspensionIfInactive,
  getActiveSuspensionOwner,
} from "../session/sessionState.js";
import { clearDraftConfirmationState } from "../doc-engine/draftScratch.js";
import { syncContentAndProjectDocState } from "../doc-engine/docStateSync.js";
import { schedulePersist } from "../session/threadPersistence.js";
import { USER_ABORT_REASON } from "./streamErrors.js";
import { invalidateTurnOwnership } from "../session/turnOwnership.js";
import { alignCommandCardWithStatus } from "./toolCards.js";
import { isPersistentBackgroundCommand } from "./backgroundCommandSettlement.js";
import { terminateSessionBackgroundCommands } from "./backgroundCommandTermination.js";
import {
  confirmService,
  type ConfirmCancelSource,
  type ConfirmService,
} from "../confirm/confirmService.js";

const logger = mastra.getLogger();
const turnStreamEndOwners = new WeakMap<Promise<void>, string>();

export type TurnCleanupReason =
  | "userAbort"
  | "preemptedByNewMessage"
  | "globalStop";

function abortReasonForCleanup(reason: TurnCleanupReason): string {
  if (reason === "preemptedByNewMessage") return "preemptedByNewMessage";
  if (reason === "globalStop") return "globalStop";
  return USER_ABORT_REASON;
}

function confirmCancelSourceFor(reason: TurnCleanupReason): ConfirmCancelSource {
  return `turn-cleanup:${reason}` as ConfirmCancelSource;
}

/**
 * 待确认卡被回合清理收走时给用户的说明。必须如实、可操作:绝不能让用户以为
 * 是自己"没及时点",也绝不能只丢一个笼统的"已中止"。
 */
function abortedConfirmMessage(reason: TurnCleanupReason): string {
  if (reason === "preemptedByNewMessage") {
    return "刚才那张确认卡随上一条消息一起结束了，命令没有执行。需要的话我可以重新发起。";
  }
  if (reason === "globalStop") {
    return "已停止，这张确认卡一并收回，命令没有执行。需要的话我可以重新发起。";
  }
  return "本轮已结束，这张确认卡没能送达，命令没有执行。需要的话我可以重新发起。";
}

/**
 * 同一句真话也要给模型。模型只看到含糊的"已取消"时会自己编原因(真机上编出
 * "可能是确认弹窗没有及时点击"),这里把真实归因写进模型上下文堵死瞎猜。
 */
function abortedConfirmModelNote(reason: TurnCleanupReason): string {
  const cause = reason === "preemptedByNewMessage"
    ? "上一轮被用户的新消息接替"
    : reason === "globalStop"
      ? "用户点了停止"
      : "本轮在等待期间被系统结束";
  return (
    `[系统事实] 上一张命令确认卡因为${cause}而被收回，命令没有执行。` +
    "这不是用户拒绝，也不是用户没有及时点击确认；不要向用户这样解释。" +
    "如果这一步仍然必要，直接重新发起同一条命令的确认。"
  );
}

export function createTurnCompletion(streamId: string): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  turnStreamEndOwners.set(promise, streamId);
  return { promise, resolve };
}

export function turnCompletionOwnsStreamEnd(
  completion: Promise<void>,
  streamId: string,
): boolean {
  return turnStreamEndOwners.get(completion) === streamId;
}

function terminalizeInFlightToolCalls(
  state: SessionState,
  reason: TurnCleanupReason,
): Array<{ messageId: string; toolCallId: string; spec: ToolCallSpec }> {
  const updates: Array<{ messageId: string; toolCallId: string; spec: ToolCallSpec }> = [];

  for (const message of state.chatHistory) {
    for (let i = 0; i < message.parts.length; i++) {
      const part = message.parts[i]!;
      if (part.kind !== "toolCall") continue;
      if (part.data.status.kind !== "pending" && part.data.status.kind !== "running") {
        continue;
      }
      if (
        reason === "preemptedByNewMessage" &&
        (
          isPersistentBackgroundCommand(part.data) ||
          [...(state._backgroundCommandOwnerByPid?.values() ?? [])].includes(part.data.id)
        )
      ) {
        continue;
      }
      const spec = alignCommandCardWithStatus({
        ...part.data,
        status: { kind: "aborted" },
        body: part.data.body.kind === "commandCard"
          ? {
              kind: "commandCard",
              data: { ...part.data.body.data, terminalKind: "aborted" },
            }
          : part.data.body.kind === "generic" &&
              part.data.name === "mastra_workspace_get_process_output"
            ? {
                kind: "generic",
                data: { ...part.data.body.data, terminalKind: "aborted" },
              }
            : part.data.body,
        result: part.data.result,
      });
      message.parts[i] = { kind: "toolCall", data: spec };
      updates.push({ messageId: message.id, toolCallId: spec.id, spec });
    }
  }

  return updates;
}

function activeTurnToolCallIds(state: SessionState): Set<string> {
  const activeAgentMessageId = state._activeAgentMessageId;
  if (!activeAgentMessageId) return new Set();
  const message = state.chatHistory.find((item) => item.id === activeAgentMessageId);
  if (!message) return new Set();
  return new Set(
    message.parts
      .filter((part) => part.kind === "toolCall")
      .map((part) => part.data.id),
  );
}

interface InterruptedToolFact {
  id: string;
  name: string;
  backgroundPid: string | null;
}

function interruptedToolFacts(
  state: SessionState,
  activeAgentMessageId: string | null,
  excludedToolCallIds: ReadonlySet<string>,
): InterruptedToolFact[] {
  if (!activeAgentMessageId) return [];
  const message = state.chatHistory.find((item) => item.id === activeAgentMessageId);
  if (!message) return [];
  const pidsByOwner = new Map<string, string>();
  for (const [pid, ownerToolCallId] of state._backgroundCommandOwnerByPid ?? []) {
    pidsByOwner.set(ownerToolCallId, pid);
  }
  return message.parts.flatMap((part) => {
    if (
      part.kind !== "toolCall" ||
      excludedToolCallIds.has(part.data.id) ||
      (part.data.status.kind !== "pending" && part.data.status.kind !== "running") ||
      isPersistentBackgroundCommand(part.data)
    ) {
      return [];
    }
    const backgroundPid = pidsByOwner.get(part.data.id) ?? null;
    if (part.data.result !== null && backgroundPid === null) return [];
    return [{
      id: part.data.id,
      name: part.data.name,
      backgroundPid,
    }];
  });
}

function interruptedToolModelNote(facts: InterruptedToolFact[]): string {
  const items = facts.map((fact) =>
    fact.backgroundPid
      ? `${fact.name}（toolCallId:${fact.id}，后台 PID:${fact.backgroundPid}，进程仍在运行）`
      : `${fact.name}（toolCallId:${fact.id}）`
  ).join("、");
  const backgroundPids = facts
    .map((fact) => fact.backgroundPid)
    .filter((pid): pid is string => pid !== null);
  const nextStep = backgroundPids.length > 0
    ? `后台进程仍属本会话，可用原 PID ${backgroundPids.join("、")} 继续轮询；其余步骤如仍需要，再重新发起。`
    : "这些步骤如仍需要，请重新发起，不能假装已经拿到结果。";
  return (
    `[系统事实] 上一轮被用户的新消息接替，以下工具结果未送达：${items}。` +
    "这不是工具或其背后服务失败，也不表示登录态失效；不要据此猜测。" +
    nextStep
  );
}

// 自然收尾时把残留在 running 的工具调用落终态,清掉"工具调用完、对话已回复,
// 但 toolCall 仍转圈 loading"的残留(如 result 帧缺失 / 达 maxSteps 截断)。
// 只有流式参数起始帧、没有任何参数/结果的空占位，能确定本轮没有真正执行工具，必须落 failed；
// 其它无主 running 保持原有 done 语义。active suspension owner 保留。
// 中断改写另由 terminalizeInFlightToolCalls 置 aborted。
export function finalizeLingeringRunningToolCalls(
  state: SessionState,
): Array<{ messageId: string; toolCallId: string; spec: ToolCallSpec }> {
  const updates: Array<{ messageId: string; toolCallId: string; spec: ToolCallSpec }> = [];
  const activeOwner = getActiveSuspensionOwner(state);
  const activeConfirmToolCallIds = new Set(
    Array.from(state.pendingConfirms.values())
      .filter((pending) => pending.status === "pending")
      .map((pending) => pending.toolCallId),
  );

  for (const message of state.chatHistory) {
    for (let i = 0; i < message.parts.length; i++) {
      const part = message.parts[i]!;
      if (part.kind !== "toolCall") continue;
      const isOwnedSuspensionToolCall =
        activeOwner !== null && part.data.id === activeOwner.toolCallId;
      const shouldFinalize =
        part.data.status.kind === "running" &&
        !isOwnedSuspensionToolCall &&
        !activeConfirmToolCallIds.has(part.data.id) &&
        !isPersistentBackgroundCommand(part.data);
      if (!shouldFinalize) continue;

      const isUnexecutedStreamingPlaceholder =
        part.data.result === null &&
        part.data.body.kind === "generic" &&
        part.data.body.data.argsJson === "";
      const isCommandWithoutResult =
        part.data.result === null && part.data.body.kind === "commandCard";
      const failedReason = isCommandWithoutResult ? "命令未返回结果" : "本轮未产出结果";
      const spec = alignCommandCardWithStatus({
        ...part.data,
        status: isUnexecutedStreamingPlaceholder || isCommandWithoutResult
          ? { kind: "failed", data: { retriable: true, reason: failedReason } }
          : { kind: "done" },
        result: isUnexecutedStreamingPlaceholder || isCommandWithoutResult
          ? { kind: "genericText", data: failedReason }
          : part.data.result,
      });
      message.parts[i] = { kind: "toolCall", data: spec };
      updates.push({ messageId: message.id, toolCallId: spec.id, spec });
    }
  }

  return updates;
}

async function waitForActiveTurnCleanup(
  activeTurnPromise: Promise<unknown>,
  timeoutMs: number,
): Promise<"settled" | "timeout"> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([
      activeTurnPromise.then(
        () => "settled" as const,
        (err) => {
          logger.warn("Active turn rejected during abort cleanup", { error: String(err) });
          return "settled" as const;
        },
      ),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function* abortAndCleanupTurn(
  state: SessionState,
  options: {
    activeTurnTimeoutMs?: number;
    emitStreamEnd?: boolean;
    reason?: TurnCleanupReason;
    confirmService?: Pick<
      ConfirmService,
      "cancelRequestedCommandConfirm" | "resolvedFrame"
    >;
    /** 仅供生命周期单测注入；生产统一走会话 workspace。 */
    terminateBackgroundCommands?: typeof terminateSessionBackgroundCommands;
  } = {},
): AsyncGenerator<BridgeFrame> {
  const activeTurnPromise = state._activeTurnPromise;
  const reason = options.reason ?? "userAbort";
  const interruptedAgentMessageId = reason === "preemptedByNewMessage"
    ? state._activeAgentMessageId
    : null;
  const abortedStreamId = state.streamId;
  const activeTurnOwnsStreamEnd =
    activeTurnPromise !== null &&
    abortedStreamId !== null &&
    turnCompletionOwnsStreamEnd(activeTurnPromise, abortedStreamId);
  const currentToolCallIds = activeTurnToolCallIds(state);
  const pendingConfirms = Array.from(state.pendingConfirms.values()).filter(
    (pending) =>
      pending.status === "pending" &&
      (
        reason === "globalStop" ||
        currentToolCallIds.has(pending.toolCallId)
      ),
  );
  state._abortController?.abort(abortReasonForCleanup(reason));
  invalidateTurnOwnership(state);

  let activeTurnOutcome: "absent" | "settled" | "timeout" = "absent";
  if (activeTurnPromise) {
    activeTurnOutcome = await waitForActiveTurnCleanup(
      activeTurnPromise,
      options.activeTurnTimeoutMs ?? ABORT_CLEANUP_ACTIVE_TURN_TIMEOUT_MS,
    );
    if (activeTurnOutcome === "timeout") {
      logger.warn("Timed out waiting for active turn cleanup; orphaning turn", {
        streamId: abortedStreamId,
      });
      if (
        activeTurnOwnsStreamEnd &&
        options.emitStreamEnd !== false
      ) {
        turnStreamEndOwners.delete(activeTurnPromise);
      }
    }
  }

  state.streamId = null;
  state._abortController = null;
  state._activeTurnPromise = null;
  state._currentChips = null;

  const confirmationService = options.confirmService ?? confirmService;
  for (const pending of pendingConfirms) {
    if (
      state.pendingConfirms.get(pending.toolCallId) !== pending ||
      pending.status !== "pending"
    ) {
      continue;
    }
    try {
      await confirmationService.cancelRequestedCommandConfirm(
        state,
        pending,
        confirmCancelSourceFor(reason),
      );
    } catch (error) {
      logger.error("Failed to persist aborted confirm during turn cleanup", {
        streamId: abortedStreamId,
        toolCallId: pending.toolCallId,
        source: confirmCancelSourceFor(reason),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // 用户侧看到真话(带 message 的 resolved 会 toast 出来),模型侧也拿到真话。
    state.messages.push({
      role: "system",
      content: abortedConfirmModelNote(reason),
    });
    yield confirmationService.resolvedFrame(
      pending,
      "aborted",
      abortedConfirmMessage(reason),
    );
  }

  if (reason === "preemptedByNewMessage") {
    // 待确认调用有专门的确认取消事实注记，且命令尚未执行，不能重复标成“工具结果未送达”。
    const confirmedToolCallIds = new Set(
      pendingConfirms.map((pending) => pending.toolCallId),
    );
    const facts = interruptedToolFacts(
      state,
      interruptedAgentMessageId,
      confirmedToolCallIds,
    );
    if (facts.length > 0) {
      state.messages.push({
        role: "system",
        content: interruptedToolModelNote(facts),
      });
    }
  }

  if (reason === "userAbort" || reason === "globalStop") {
    const settlements = await (
      options.terminateBackgroundCommands ?? terminateSessionBackgroundCommands
    )(state, "userStop");
    for (const settlement of settlements) {
      yield toolCallUpdated(
        settlement.messageId,
        settlement.toolCallId,
        settlement.spec,
      );
    }
  }

  const updates = terminalizeInFlightToolCalls(state, reason);
  for (const update of updates) {
    yield toolCallUpdated(update.messageId, update.toolCallId, update.spec);
  }
  state._activeAgentMessageId = null;
  clearStaleSuspensionIfInactive(state);

  clearDraftConfirmationState(state);
  yield* syncContentAndProjectDocState(state, "agent_turn_finally_idle");
  const settledActiveTurnWillEmitEnd =
    activeTurnOwnsStreamEnd && activeTurnOutcome === "settled";
  if (
    abortedStreamId &&
    options.emitStreamEnd !== false &&
    !settledActiveTurnWillEmitEnd
  ) {
    yield streamEnd(abortedStreamId, { kind: "cancelled" });
  }

  await schedulePersist(state, "abortAndCleanupTurn").catch((err) =>
    logger.error("Persist after abortAndCleanupTurn failed", { error: String(err) }),
  );
}

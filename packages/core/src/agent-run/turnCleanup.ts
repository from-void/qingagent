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
import {
  confirmService,
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
  } = {},
): AsyncGenerator<BridgeFrame> {
  const activeTurnPromise = state._activeTurnPromise;
  const abortedStreamId = state.streamId;
  const activeTurnOwnsStreamEnd =
    activeTurnPromise !== null &&
    abortedStreamId !== null &&
    turnCompletionOwnsStreamEnd(activeTurnPromise, abortedStreamId);
  const reason = options.reason ?? "userAbort";
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
      await confirmationService.cancelRequestedCommandConfirm(state, pending);
    } catch (error) {
      logger.error("Failed to persist aborted confirm during turn cleanup", {
        streamId: abortedStreamId,
        toolCallId: pending.toolCallId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    yield confirmationService.resolvedFrame(pending, "aborted");
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

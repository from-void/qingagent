import type {
  BridgeFrame,
  ChatMessage,
  MessagePart,
  ToolCallSpec,
} from "@qingagent/contract-ts";
import { mastra } from "../mastra.js";
import { ABORT_CLEANUP_ACTIVE_TURN_TIMEOUT_MS } from "./agentLimits.js";
import {
  chatMessageAdded,
  chatMessageAppended,
  newId,
  nowIso,
  streamEnd,
  toolCallUpdated,
} from "./frames.js";
import type { SessionState } from "../session/sessionState.js";
import {
  clearStaleSuspensionIfInactive,
  getActiveSuspensionOwner,
  appendPartToChatHistory,
  nextSeq,
} from "../session/sessionState.js";
import { clearDraftConfirmationState } from "../doc-engine/draftScratch.js";
import { syncContentAndProjectDocState } from "../doc-engine/docStateSync.js";
import { schedulePersist } from "../session/threadPersistence.js";
import { USER_ABORT_REASON } from "./streamErrors.js";
import { invalidateTurnOwnership } from "../session/turnOwnership.js";
import { alignCommandCardWithStatus } from "./toolCards.js";

const logger = mastra.getLogger();

export type TurnCleanupReason =
  | "userAbort"
  | "preemptedByNewMessage"
  | "globalStop";

export const PREEMPTED_BY_NEW_MESSAGE_NOTICE =
  "本轮已被新消息中断。若有后台进程，它没有被自动终止，当前状态仍待确认。";

function abortReasonForCleanup(reason: TurnCleanupReason): string {
  if (reason === "preemptedByNewMessage") return "preemptedByNewMessage";
  if (reason === "globalStop") return "globalStop";
  return USER_ABORT_REASON;
}

export function createTurnCompletion(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function terminalizeInFlightToolCalls(
  state: SessionState,
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
        status: {
          kind: "failed",
          data: { retriable: false, reason: "本轮生成已中断" },
        },
        result: part.data.result ?? { kind: "genericText", data: "本轮生成已中断" },
      });
      message.parts[i] = { kind: "toolCall", data: spec };
      updates.push({ messageId: message.id, toolCallId: spec.id, spec });
    }
  }

  return updates;
}

// 自然收尾时把残留在 running 的工具调用落终态,清掉"工具调用完、对话已回复,
// 但 toolCall 仍转圈 loading"的残留(如 result 帧缺失 / 达 maxSteps 截断)。
// 只有流式参数起始帧、没有任何参数/结果的空占位，能确定本轮没有真正执行工具，必须落 failed；
// 其它无主 running 保持原有 done 语义。active suspension owner 保留。
// 中断改写另由 terminalizeInFlightToolCalls 置 failed。
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
        !activeConfirmToolCallIds.has(part.data.id);
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

async function* appendPreemptionNotice(
  state: SessionState,
  preferredMessageId: string | null,
): AsyncGenerator<BridgeFrame> {
  let messageId = preferredMessageId;
  let message = messageId
    ? state.chatHistory.find((item) => item.id === messageId && item.role.kind === "agent")
    : undefined;
  if (!message) {
    messageId = newId();
    message = {
      id: messageId,
      role: { kind: "agent" },
      ts: nowIso(),
      parts: [],
      chips: null,
    } satisfies ChatMessage;
    state.chatHistory.push(message);
    yield chatMessageAdded(message);
  }
  if (!messageId) return;

  const textPart: MessagePart = {
    kind: "text",
    data: { body: PREEMPTED_BY_NEW_MESSAGE_NOTICE },
  };
  const seq = nextSeq(state, messageId);
  appendPartToChatHistory(state, messageId, textPart);
  yield chatMessageAppended(messageId, seq, textPart);
  state.messages.push({
    role: "assistant",
    content: PREEMPTED_BY_NEW_MESSAGE_NOTICE,
  });
}

export async function* abortAndCleanupTurn(
  state: SessionState,
  options: {
    activeTurnTimeoutMs?: number;
    emitStreamEnd?: boolean;
    reason?: TurnCleanupReason;
  } = {},
): AsyncGenerator<BridgeFrame> {
  const activeTurnPromise = state._activeTurnPromise;
  const abortedStreamId = state.streamId;
  const activeAgentMessageId = state._activeAgentMessageId;
  const reason = options.reason ?? "userAbort";
  state._abortController?.abort(abortReasonForCleanup(reason));
  invalidateTurnOwnership(state);

  if (activeTurnPromise) {
    const outcome = await waitForActiveTurnCleanup(
      activeTurnPromise,
      options.activeTurnTimeoutMs ?? ABORT_CLEANUP_ACTIVE_TURN_TIMEOUT_MS,
    );
    if (outcome === "timeout") {
      logger.warn("Timed out waiting for active turn cleanup; orphaning turn", {
        streamId: abortedStreamId,
      });
    }
  }

  state.streamId = null;
  state._abortController = null;
  state._activeTurnPromise = null;
  state._currentChips = null;

  const updates = terminalizeInFlightToolCalls(state);
  for (const update of updates) {
    yield toolCallUpdated(update.messageId, update.toolCallId, update.spec);
  }
  if (reason === "preemptedByNewMessage") {
    yield* appendPreemptionNotice(
      state,
      activeAgentMessageId ?? state._activeAgentMessageId,
    );
  }
  state._activeAgentMessageId = null;
  clearStaleSuspensionIfInactive(state);

  clearDraftConfirmationState(state);
  yield* syncContentAndProjectDocState(state, "agent_turn_finally_idle");
  if (abortedStreamId && options.emitStreamEnd !== false) {
    yield streamEnd(abortedStreamId, { kind: "cancelled" });
  }

  await schedulePersist(state, "abortAndCleanupTurn").catch((err) =>
    logger.error("Persist after abortAndCleanupTurn failed", { error: String(err) }),
  );
}

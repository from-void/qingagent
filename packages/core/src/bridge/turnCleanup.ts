import type { BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";
import { mastra } from "../mastra.js";
import { ABORT_CLEANUP_ACTIVE_TURN_TIMEOUT_MS } from "./agentLimits.js";
import { streamEnd, toolCallUpdated } from "./frames.js";
import type { SessionState } from "./sessionState.js";
import {
  clearStaleSuspensionIfInactive,
  getActiveSuspensionOwner,
} from "./sessionState.js";
import { clearDraftConfirmationState } from "./draftScratch.js";
import { syncContentAndProjectDocState } from "./docStateSync.js";
import { schedulePersist } from "./threadPersistence.js";
import { USER_ABORT_REASON } from "./streamErrors.js";

const logger = mastra.getLogger();

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

      const spec: ToolCallSpec = {
        ...part.data,
        status: {
          kind: "failed",
          data: { retriable: false, reason: "本轮生成已中断" },
        },
      };
      message.parts[i] = { kind: "toolCall", data: spec };
      updates.push({ messageId: message.id, toolCallId: spec.id, spec });
    }
  }

  return updates;
}

// 自然收尾时把残留在 running 的工具调用落终态(done),清掉"工具调用完、对话已回复,
// 但 toolCall 仍转圈 loading"的残留(如 result 帧缺失 / 达 maxSteps 截断)。
// active suspension owner 保留;其它无主 running 视为孤儿并落 done。
// 中断改写另由 terminalizeInFlightToolCalls 置 failed。
export function finalizeLingeringRunningToolCalls(
  state: SessionState,
): Array<{ messageId: string; toolCallId: string; spec: ToolCallSpec }> {
  const updates: Array<{ messageId: string; toolCallId: string; spec: ToolCallSpec }> = [];
  const activeOwner = getActiveSuspensionOwner(state);

  for (const message of state.chatHistory) {
    for (let i = 0; i < message.parts.length; i++) {
      const part = message.parts[i]!;
      if (part.kind !== "toolCall") continue;
      const isOwnedSuspensionToolCall =
        activeOwner !== null && part.data.id === activeOwner.toolCallId;
      const shouldFinalize = part.data.status.kind === "running" && !isOwnedSuspensionToolCall;
      if (!shouldFinalize) continue;

      const spec: ToolCallSpec = { ...part.data, status: { kind: "done" } };
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
  options: { activeTurnTimeoutMs?: number; emitStreamEnd?: boolean } = {},
): AsyncGenerator<BridgeFrame> {
  const activeTurnPromise = state._activeTurnPromise;
  const abortedStreamId = state.streamId;
  state._abortController?.abort(USER_ABORT_REASON);

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

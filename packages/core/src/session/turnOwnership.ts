import type { SessionState } from "./sessionState.js";

export const TURN_OWNER_REQUEST_CONTEXT_KEY = "qingagentTurnOwner";
export const TURN_GENERATION_REQUEST_CONTEXT_KEY = "qingagentTurnGeneration";

export interface TurnOwnership {
  owner: string;
  generation: number;
}

export interface TurnWriteGuard {
  owner: string | null;
  generation: number;
  abortSignal?: AbortSignal;
}

interface RequestContextLike {
  get(key: string): unknown;
  set?(key: string, value: unknown): void;
}

interface ToolExecutionContextLike {
  abortSignal?: AbortSignal;
  requestContext?: RequestContextLike;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as AbortSignal).throwIfAborted === "function",
  );
}

/** 为一次 agent 尝试领取单调代次；同一 stream 的 idle-timeout 重试也必须重新领取。 */
export function beginTurnOwnership(
  state: SessionState,
  owner: string,
): TurnOwnership {
  const previous = Number.isSafeInteger(state._turnGeneration)
    ? state._turnGeneration
    : 0;
  const ownership = {
    owner,
    generation: previous + 1,
  };
  state._turnOwner = ownership.owner;
  state._turnGeneration = ownership.generation;
  return ownership;
}

export function bindTurnOwnershipToRequestContext(
  requestContext: RequestContextLike,
  ownership: TurnOwnership,
): void {
  requestContext.set?.(TURN_OWNER_REQUEST_CONTEXT_KEY, ownership.owner);
  requestContext.set?.(
    TURN_GENERATION_REQUEST_CONTEXT_KEY,
    ownership.generation,
  );
}

export function turnOwnershipFromRequestContext(
  requestContext: RequestContextLike | undefined,
): TurnOwnership | null {
  const owner = requestContext?.get(TURN_OWNER_REQUEST_CONTEXT_KEY);
  const generation = requestContext?.get(TURN_GENERATION_REQUEST_CONTEXT_KEY);
  return typeof owner === "string" &&
      Number.isSafeInteger(generation) &&
      (generation as number) >= 0
    ? { owner, generation: generation as number }
    : null;
}

/**
 * 工具 execute 一进入就快照 signal + owner/generation。RequestContext 在 idle 重试时
 * 会切到新 signal/代次，不能等到提交时再从可变上下文读取，否则旧工具会冒充新轮。
 */
export function captureTurnWriteGuard(
  state: SessionState,
  context?: ToolExecutionContextLike,
): TurnWriteGuard {
  const contextualOwnership = turnOwnershipFromRequestContext(
    context?.requestContext,
  );
  const contextualSignal = context?.abortSignal ??
    context?.requestContext?.get("abortSignal");
  return {
    owner: contextualOwnership?.owner ?? state._turnOwner,
    generation: contextualOwnership?.generation ?? state._turnGeneration,
    ...(isAbortSignal(contextualSignal)
      ? { abortSignal: contextualSignal }
      : {}),
  };
}

/** 写点提交前的最后一道栅栏：先服从 abort，再校验会话当前 owner/generation。 */
export function assertTurnWriteAllowed(
  state: SessionState,
  guard: TurnWriteGuard,
): void {
  guard.abortSignal?.throwIfAborted();
  if (
    state._turnOwner === guard.owner &&
    state._turnGeneration === guard.generation
  ) {
    return;
  }
  throw new DOMException("迟到的旧轮次写入已拒绝", "AbortError");
}

export function endTurnOwnership(
  state: SessionState,
  ownership: TurnOwnership,
): void {
  if (
    state._turnOwner === ownership.owner &&
    state._turnGeneration === ownership.generation
  ) {
    state._turnOwner = null;
  }
}

/** 用户取消/空闲超时一发生就撤销当前写资格，不能只等 generator 的 finally。 */
export function invalidateTurnOwnership(
  state: SessionState,
  expected?: TurnOwnership | null,
): void {
  if (
    expected &&
    (
      state._turnOwner !== expected.owner ||
      state._turnGeneration !== expected.generation
    )
  ) {
    return;
  }
  state._turnOwner = null;
}

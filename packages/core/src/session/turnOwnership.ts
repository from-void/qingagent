import type { SessionState } from "./sessionState.js";
import {
  TURN_GENERATION_REQUEST_CONTEXT_KEY,
  TURN_OWNER_REQUEST_CONTEXT_KEY,
  TURN_WRITE_GUARD_FACTORY_REQUEST_CONTEXT_KEY,
  assertTurnWriteAllowed,
  captureTurnWriteGuard,
  type RequestContextLike,
  type TurnOwnership,
  type TurnWriteGuardFactory,
} from "../utils/turnWriteGuard.js";

export {
  TURN_GENERATION_REQUEST_CONTEXT_KEY,
  TURN_OWNER_REQUEST_CONTEXT_KEY,
  TURN_WRITE_GUARD_FACTORY_REQUEST_CONTEXT_KEY,
  assertTurnWriteAllowed,
  captureBoundTurnWriteGuard,
  captureTurnWriteGuard,
  turnOwnershipFromRequestContext,
} from "../utils/turnWriteGuard.js";
export type {
  TurnOwnership,
  TurnWriteGuard,
  TurnWriteGuardAssertion,
} from "../utils/turnWriteGuard.js";

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

/**
 * 把会话态写入所有权桥接给全局工具。factory 在工具 execute 入口调用并立即快照本轮
 * owner/generation；返回的断言可安全带到异步编译后的最终写点，不能被后续重试冒领。
 */
export function bindTurnWriteGuardFactoryToRequestContext(
  state: SessionState,
  requestContext: RequestContextLike,
): void {
  requestContext.set?.(
    TURN_WRITE_GUARD_FACTORY_REQUEST_CONTEXT_KEY,
    ((abortSignal?: AbortSignal) => {
      const guard = captureTurnWriteGuard(state, {
        abortSignal,
        requestContext,
      });
      return () => assertTurnWriteAllowed(state, guard);
    }) satisfies TurnWriteGuardFactory,
  );
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

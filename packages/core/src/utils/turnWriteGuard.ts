export const TURN_OWNER_REQUEST_CONTEXT_KEY = "qingagentTurnOwner";
export const TURN_GENERATION_REQUEST_CONTEXT_KEY = "qingagentTurnGeneration";
export const TURN_WRITE_GUARD_FACTORY_REQUEST_CONTEXT_KEY =
  "qingagentTurnWriteGuardFactory";

export interface TurnOwnership {
  owner: string;
  generation: number;
}

export interface TurnWriteGuard {
  owner: string | null;
  generation: number;
  abortSignal?: AbortSignal;
}

export interface TurnOwnedState {
  _turnOwner: string | null;
  _turnGeneration: number;
}

export interface RequestContextLike {
  get(key: string): unknown;
  set?(key: string, value: unknown): void;
}

export interface ToolExecutionContextLike {
  abortSignal?: AbortSignal;
  requestContext?: RequestContextLike;
}

export type TurnWriteGuardAssertion = () => void;
export type TurnWriteGuardFactory = (
  abortSignal?: AbortSignal,
) => TurnWriteGuardAssertion;

function isAbortSignal(value: unknown): value is AbortSignal {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as AbortSignal).throwIfAborted === "function",
  );
}

export function captureBoundTurnWriteGuard(
  context?: ToolExecutionContextLike,
): TurnWriteGuardAssertion | undefined {
  const factory = context?.requestContext?.get(
    TURN_WRITE_GUARD_FACTORY_REQUEST_CONTEXT_KEY,
  );
  return typeof factory === "function"
    ? (factory as TurnWriteGuardFactory)(context?.abortSignal)
    : undefined;
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

/** 工具入口快照 signal + owner/generation，供最终写点拒绝迟到写入。 */
export function captureTurnWriteGuard(
  state: TurnOwnedState,
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

/** 写点提交前的最后一道栅栏：先服从 abort，再校验当前 owner/generation。 */
export function assertTurnWriteAllowed(
  state: TurnOwnedState,
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

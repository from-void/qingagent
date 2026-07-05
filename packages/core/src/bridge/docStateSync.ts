import type { BridgeFrame, DocState } from "@qingagent/contract-ts";
import {
  deriveContentState,
  emitProjectedDocState,
} from "./docStateMachine.js";
import {
  type DocStateTransitionReason,
  type TransitionDocStateOptions,
  idleDocState,
  normalizeTargetDocState,
  transitionDocState,
} from "./docStateTransitions.js";
import type { SessionState } from "./sessionState.js";

export function restoreDocStateAfterGenerateSvg(
  previous: DocState | null,
  state: SessionState,
): DocState {
  return normalizeTargetDocState(
    state,
    previous ?? idleDocState(state),
    "generate_svg_finished",
  );
}

export function* transitionAndProjectDocState(
  state: SessionState,
  target: DocState | ((state: SessionState) => DocState),
  reason: DocStateTransitionReason,
  options: TransitionDocStateOptions = {},
): Generator<BridgeFrame> {
  transitionDocState(state, target, reason, options);
  yield* emitProjectedDocState(state, reason);
}

export function* syncContentAndProjectDocState(
  state: SessionState,
  reason: DocStateTransitionReason,
  options: TransitionDocStateOptions = { mode: "normalize" },
): Generator<BridgeFrame> {
  yield* transitionAndProjectDocState(state, deriveContentState(state), reason, options);
}

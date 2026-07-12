import type { DocState, ToolCallSpec } from "@qingagent/contract-ts";
import type { SessionState } from "../session/sessionState.js";
import { getActiveSuspensionOwner, hasActiveSuspension } from "../session/sessionState.js";
import { hasApplicableSuggestion, hasCanonicalDoc } from "./docFacts.js";
import { isQuestionnaireTool } from "../agent-run/questionnaireTools.js";

export type DocStateTransitionReason =
  | "draft_candidate_committed"
  | "draft_candidate_noop"
  | "enter_review"
  | "ask_user_started"
  | "ask_user_suspended"
  | "ask_user_abandoned"
  | "generate_doc_started"
  | "generate_doc_failed"
  | "generate_svg_started"
  | "generate_svg_finished"
  | "agent_turn_failed"
  | "agent_turn_finally_idle"
  | "resume_failed"
  | "restore_normalized"
  | "user_doc_write"
  | "patches_committed_toast"
  | "patches_committed_idle";

export interface DocStateFacts {
  hasDoc: boolean;
  hasReviewPatch: boolean;
  hasApplicableReviewPatch: boolean;
  hasOpenAskUser: boolean;
  hasActiveSuspension: boolean;
}

export interface RestoreDocStateFacts {
  persistedKind: string;
  hasDoc: boolean;
  hasReviewPatch: boolean;
  hasApplicableReviewPatch: boolean;
  hasOpenAskUserToolCall: boolean;
  hasRestorableSuspension: boolean;
}

export interface TransitionDocStateOptions {
  expectedFrom?: readonly DocState["kind"][];
  mode?: "strict" | "normalize";
}

export interface TransitionDocStateResult {
  changed: boolean;
}

export class DocStateTransitionError extends Error {
  constructor(
    message: string,
    readonly from: DocState["kind"],
    readonly to: DocState["kind"],
    readonly reason: DocStateTransitionReason,
  ) {
    super(message);
    this.name = "DocStateTransitionError";
  }
}

function iterToolCalls(state: SessionState): ToolCallSpec[] {
  const specs: ToolCallSpec[] = [];
  for (const message of state.chatHistory) {
    for (const part of message.parts) {
      if (part.kind === "toolCall") {
        specs.push(part.data);
      }
    }
  }
  return specs;
}

export function deriveDocStateFacts(state: SessionState): DocStateFacts {
  const hasSuggestion = hasApplicableSuggestion(state);
  return {
    hasDoc: hasCanonicalDoc(state),
    hasReviewPatch: hasSuggestion,
    hasApplicableReviewPatch: hasSuggestion,
    hasOpenAskUser: iterToolCalls(state).some(
      (spec) =>
        isQuestionnaireTool(spec.name) &&
        (spec.status.kind === "pending" || spec.status.kind === "running"),
    ),
    hasActiveSuspension: hasActiveSuspension(state),
  };
}

export function idleDocState(
  state: Pick<SessionState, "doc" | "legacySections">,
): DocState {
  return hasCanonicalDoc(state) ? { kind: "editing" } : { kind: "empty" };
}

function contentKindFromFacts(facts: {
  hasDoc: boolean;
  hasApplicableReviewPatch: boolean;
}): DocState["kind"] {
  if (!facts.hasDoc) return "empty";
  if (facts.hasApplicableReviewPatch) return "pendingReview";
  return "editing";
}

export function normalizeRestoredDocStateKind(
  facts: RestoreDocStateFacts,
): DocState["kind"] {
  return contentKindFromFacts(facts);
}

export function normalizePersistedDocStateKind(
  state: SessionState,
): DocState["kind"] {
  return contentKindFromFacts(deriveDocStateFacts(state));
}

function warnNormalized(
  reason: DocStateTransitionReason,
  target: DocState,
  normalized: DocState,
  detail: string,
): void {
  console.warn("docState normalized", {
    reason,
    target: target.kind,
    normalized: normalized.kind,
    detail,
  });
}

export function normalizeTargetDocState(
  state: SessionState,
  target: DocState,
  reason: DocStateTransitionReason,
): DocState {
  const facts = deriveDocStateFacts(state);
  const normalized = idleDocState(state);

  switch (target.kind) {
    case "empty":
      if (facts.hasDoc || facts.hasReviewPatch) {
        warnNormalized(reason, target, normalized, "empty target violates content facts");
        return normalized;
      }
      return target;
    case "editing":
      if (!facts.hasDoc) {
        warnNormalized(reason, target, normalized, "editing target without document");
        return normalized;
      }
      return target;
    case "pendingReview":
      if (!facts.hasDoc || !facts.hasApplicableReviewPatch) {
        warnNormalized(reason, target, normalized, "pendingReview target violates review facts");
        return normalized;
      }
      return target;
  }
}

function assertAllowedSource(
  from: DocState["kind"],
  target: DocState,
  reason: DocStateTransitionReason,
  facts: DocStateFacts,
): void {
  const allowed: Record<DocState["kind"], readonly DocState["kind"][]> = {
    empty: ["editing"],
    editing: ["empty", "pendingReview"],
    pendingReview: ["editing"],
  };

  const stalePendingReviewToEmpty =
    from === "pendingReview" &&
    target.kind === "empty" &&
    !facts.hasDoc &&
    !facts.hasApplicableReviewPatch &&
    (reason === "restore_normalized" ||
      reason === "resume_failed" ||
      reason === "agent_turn_finally_idle");

  if (stalePendingReviewToEmpty) return;

  // from 可能是旧快照遗留的 legacy 8 态字面量(经 restore 进入,尚未归一到 3 态),
  // 此时 allowed[from] 为 undefined;统一抛 DocStateTransitionError(而非 .includes 的
  // TypeError),让 normalize 模式按既有 try/catch 降级到 idleDocState。
  const allowedTargets = allowed[from] as readonly DocState["kind"][] | undefined;
  if (!allowedTargets || !allowedTargets.includes(target.kind)) {
    throw new DocStateTransitionError(
      `Illegal docState transition ${from} -> ${target.kind}`,
      from,
      target.kind,
      reason,
    );
  }
}

function reasonClearsToolOverlay(reason: DocStateTransitionReason): boolean {
  return (
    reason === "ask_user_abandoned" ||
    reason === "generate_doc_failed" ||
    reason === "generate_svg_finished" ||
    reason === "agent_turn_failed" ||
    reason === "agent_turn_finally_idle" ||
    reason === "resume_failed"
  );
}

function assertTargetInvariants(
  state: SessionState,
  target: DocState,
  reason: DocStateTransitionReason,
): void {
  const facts = deriveDocStateFacts(state);
  const from = state.docState.kind;
  const fail = (message: string): never => {
    throw new DocStateTransitionError(message, from, target.kind, reason);
  };

  if (reasonClearsToolOverlay(reason) && facts.hasActiveSuspension) {
    fail("leaving a tool overlay requires no active suspension");
  }

  switch (target.kind) {
    case "empty":
      if (facts.hasDoc) fail("empty requires no document sections");
      if (facts.hasReviewPatch) fail("empty requires no review patches");
      return;
    case "editing":
      if (!facts.hasDoc) fail("editing requires document sections");
      if (from === "pendingReview" && facts.hasApplicableReviewPatch) {
        fail("leaving pendingReview for editing requires cleared review patches");
      }
      return;
    case "pendingReview":
      if (!facts.hasDoc) fail("pendingReview requires document sections");
      if (!facts.hasReviewPatch || !facts.hasApplicableReviewPatch) {
        fail("pendingReview requires at least one review patch");
      }
      return;
  }
}

function assertExpectedFrom(
  state: SessionState,
  target: DocState,
  reason: DocStateTransitionReason,
  expectedFrom?: readonly DocState["kind"][],
): void {
  if (!expectedFrom || expectedFrom.includes(state.docState.kind)) return;
  throw new DocStateTransitionError(
    `Expected docState ${expectedFrom.join("|")} before ${reason}, got ${state.docState.kind}`,
    state.docState.kind,
    target.kind,
    reason,
  );
}

function validateTransition(
  state: SessionState,
  target: DocState,
  reason: DocStateTransitionReason,
  expectedFrom?: readonly DocState["kind"][],
): void {
  assertExpectedFrom(state, target, reason, expectedFrom);
  const facts = deriveDocStateFacts(state);
  assertAllowedSource(state.docState.kind, target, reason, facts);
  assertTargetInvariants(state, target, reason);
}

export function transitionDocState(
  state: SessionState,
  target: DocState | ((state: SessionState) => DocState),
  reason: DocStateTransitionReason,
  options: TransitionDocStateOptions = {},
): TransitionDocStateResult {
  const mode = options.mode ?? "strict";
  let nextState = typeof target === "function" ? target(state) : target;

  if (mode === "normalize") {
    nextState = normalizeTargetDocState(state, nextState, reason);
  }

  if (nextState.kind === state.docState.kind) {
    return { changed: false };
  }

  if (mode === "strict") {
    validateTransition(state, nextState, reason, options.expectedFrom);
  } else {
    try {
      validateTransition(state, nextState, reason, options.expectedFrom);
    } catch (err) {
      const normalized = idleDocState(state);
      console.warn("docState transition normalized", {
        reason,
        from: state.docState.kind,
        target: nextState.kind,
        normalized: normalized.kind,
        error: err instanceof Error ? err.message : String(err),
      });
      nextState = normalized;
      if (nextState.kind === state.docState.kind) {
        return { changed: false };
      }
      if (reason !== "restore_normalized") {
        validateTransition(state, nextState, reason);
      }
    }
  }

  state.docState = nextState;
  return { changed: true };
}

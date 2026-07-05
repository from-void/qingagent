import { describe, expect, it, vi } from "vitest";
import type { ContentDocState } from "@qingagent/contract-ts";
import { legacySectionsToPm } from "@qingagent/pm-schema";
import { createSession, recordSuspension } from "../bridge/sessionState.js";
import type { SessionState } from "../bridge/sessionState.js";
import {
  deriveActiveOverlay,
  deriveAgentBusy,
} from "../bridge/docStateMachine.js";
import {
  DocStateTransitionError,
  normalizeRestoredDocStateKind,
  transitionDocState,
} from "../bridge/docStateTransitions.js";

function seedDoc(state: SessionState): void {
  state.legacySections = [{ kind: "p", data: { text: "正文" } }];
  state.doc = legacySectionsToPm(state.legacySections as never);
}

function addPatch(state: SessionState): void {
  state.doc ??= legacySectionsToPm(state.legacySections as never);
  state.suggestions.set("patch-1", {
    messageId: "m",
    toolCallId: "patch-1",
    before: "旧",
    after: "新",
    blockIndex: 0,
    suggestion: {
      id: "patch-1",
      docId: state.docId,
      baseVersion: state.docVersion,
      baseSchemaVersion: state.doc.attrs.schemaVersion,
      status: "reviewing",
      anchor: {
        blockId: state.doc.content[0]?.attrs.blockId ?? "block-review",
        pmFrom: 1,
        pmTo: 2,
        quote: "旧",
        textHash: "test",
      },
      patch: { kind: "prosemirror_steps", steps: [] },
      preview: { deleteText: "旧", insertText: "新" },
      summary: "改正文",
    },
  });
}

function recordToolSuspension(
  state: SessionState,
  toolName: "askUser",
  toolCallId: string,
): void {
  recordSuspension(state, {
    streamId: "stream-1",
    runId: `run-${toolCallId}`,
    toolCallId,
    toolName,
  });
}

function addAskUser(state: SessionState): void {
  state.chatHistory.push({
    id: "m-ask",
    role: { kind: "agent" },
    ts: "2026-06-04T00:00:00.000Z",
    chips: null,
    parts: [
      {
        kind: "toolCall",
        data: {
          id: "ask-1",
          name: "askUser",
          render: { kind: "chatInline" },
          status: { kind: "pending" },
          body: { kind: "generic", data: { argsJson: "{}" } },
          result: null,
        },
      },
    ],
  });
}

function addRunningWriteDraft(state: SessionState): void {
  state.chatHistory.push({
    id: "m-running-write-draft",
    role: { kind: "agent" },
    ts: "2026-06-04T00:00:00.000Z",
    chips: null,
    parts: [
      {
        kind: "toolCall",
        data: {
          id: "writeDraft-running",
          name: "writeDraft",
          render: { kind: "chatInline" },
          status: { kind: "running", data: { progressPct: null, etaSec: null } },
          body: { kind: "generic", data: { argsJson: "{}" } },
          result: null,
        },
      },
    ],
  });
}

function attemptTransition(input: {
  from: ContentDocState["kind"];
  to: ContentDocState["kind"];
  setup?: (state: SessionState) => void;
  reason?: Parameters<typeof transitionDocState>[2];
}): { ok: boolean; finalKind: string; frameKinds: string[]; error: string | null } {
  const state = createSession(`tm-${input.from}-${input.to}`);
  state.docState = { kind: input.from } as unknown as SessionState["docState"];
  input.setup?.(state);
  try {
    const result = transitionDocState(
      state,
      { kind: input.to } as unknown as SessionState["docState"],
      input.reason ?? "restore_normalized",
    );
    return {
      ok: true,
      finalKind: state.docState.kind,
      frameKinds: result.changed ? ["changed"] : [],
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      finalKind: state.docState.kind,
      frameKinds: [],
      error: error instanceof Error ? error.name : String(error),
    };
  }
}

describe("R0 docState 3-state transition and invariant red tests", () => {
  it("TM-1..TM-8 enforce the target 3x3 transition matrix and no-frame same-kind rule", () => {
    const setupDoc = (s: SessionState) => seedDoc(s);
    const setupReview = (s: SessionState) => {
      seedDoc(s);
      addPatch(s);
    };
    const actual = {
      "empty->editing": attemptTransition({
        from: "empty",
        to: "editing",
        setup: setupDoc,
      }).ok,
      "empty->pendingReview": attemptTransition({
        from: "empty",
        to: "pendingReview",
        setup: setupReview,
      }).ok,
      "editing->empty": attemptTransition({ from: "editing", to: "empty" }).ok,
      "editing->pendingReview": attemptTransition({
        from: "editing",
        to: "pendingReview",
        setup: setupReview,
        reason: "enter_review",
      }).ok,
      "pendingReview->editing": attemptTransition({
        from: "pendingReview",
        to: "editing",
        setup: setupDoc,
        reason: "patches_committed_idle",
      }).ok,
      "pendingReview->empty": attemptTransition({
        from: "pendingReview",
        to: "empty",
        setup: setupReview,
      }).ok,
      "editing->editing frames": attemptTransition({
        from: "editing",
        to: "editing",
        setup: setupDoc,
      }).frameKinds,
    };

    expect(actual).toEqual({
      "empty->editing": true,
      "empty->pendingReview": false,
      "editing->empty": true,
      "editing->pendingReview": true,
      "pendingReview->editing": true,
      "pendingReview->empty": false,
      "editing->editing frames": [],
    });
  });

  it("INV-1..INV-10 enforce 3-state content and overlay/toolCall coupling", () => {
    const actual = {
      "INV-1 empty rejects doc": attemptTransition({
        from: "editing",
        to: "empty",
        setup: seedDoc,
      }).error,
      "INV-3 editing rejects no doc": attemptTransition({
        from: "empty",
        to: "editing",
      }).error,
      "INV-4 pendingReview requires doc and patch": attemptTransition({
        from: "editing",
        to: "pendingReview",
        setup: seedDoc,
        reason: "enter_review",
      }).error,
      "INV-7 editing with doc is legal": attemptTransition({
        from: "empty",
        to: "editing",
        setup: seedDoc,
      }).ok,
      "INV-8 askUser overlay derives from open toolCall": deriveActiveOverlay(
        makeStateForOverlay("inv-8", (s) => {
          addAskUser(s);
          recordToolSuspension(s, "askUser", "ask-1");
        }),
      ),
      "INV-9 agentBusy derives from running toolCall": deriveAgentBusy(
        makeStateForOverlay("inv-9", (s) => {
          s.streamId = "stream-running";
          addRunningWriteDraft(s);
        }),
      ),
    };

    expect(actual).toEqual({
      "INV-1 empty rejects doc": "DocStateTransitionError",
      "INV-3 editing rejects no doc": "DocStateTransitionError",
      "INV-4 pendingReview requires doc and patch": "DocStateTransitionError",
      "INV-7 editing with doc is legal": true,
      "INV-8 askUser overlay derives from open toolCall": "askUser",
      "INV-9 agentBusy derives from running toolCall": true,
    });
  });

  it("NT-1..NT-10 normalizes restore/resume facts into the 4-state model", () => {
    const actual = {
      "NT-2 suspension+askUser": normalizeRestoredDocStateKind({
        persistedKind: "plan",
        hasDoc: false,
        hasReviewPatch: false,
        hasApplicableReviewPatch: false,
        hasOpenAskUserToolCall: true,
        hasRestorableSuspension: true,
      }),
      "NT-5 review applicable": normalizeRestoredDocStateKind({
        persistedKind: "review",
        hasDoc: true,
        hasReviewPatch: true,
        hasApplicableReviewPatch: true,
        hasOpenAskUserToolCall: false,
        hasRestorableSuspension: false,
      }),
      "NT-4 stale askUser no suspension": normalizeRestoredDocStateKind({
        persistedKind: "plan",
        hasDoc: false,
        hasReviewPatch: false,
        hasApplicableReviewPatch: false,
        hasOpenAskUserToolCall: true,
        hasRestorableSuspension: false,
      }),
      "NT-6 review missing patch": normalizeRestoredDocStateKind({
        persistedKind: "review",
        hasDoc: true,
        hasReviewPatch: false,
        hasApplicableReviewPatch: false,
        hasOpenAskUserToolCall: false,
        hasRestorableSuspension: false,
      }),
      "NT-7 init with doc": normalizeRestoredDocStateKind({
        persistedKind: "init",
        hasDoc: true,
        hasReviewPatch: false,
        hasApplicableReviewPatch: false,
        hasOpenAskUserToolCall: false,
        hasRestorableSuspension: false,
      }),
      "NT-8 old busy idle with doc": normalizeRestoredDocStateKind({
        persistedKind: "locked",
        hasDoc: true,
        hasReviewPatch: false,
        hasApplicableReviewPatch: false,
        hasOpenAskUserToolCall: false,
        hasRestorableSuspension: false,
      }),
      "NT-9 old plan without suspension": normalizeRestoredDocStateKind({
        persistedKind: "plan",
        hasDoc: true,
        hasReviewPatch: false,
        hasApplicableReviewPatch: false,
        hasOpenAskUserToolCall: false,
        hasRestorableSuspension: false,
      }),
      "NT-10 committed": normalizeRestoredDocStateKind({
        persistedKind: "committed",
        hasDoc: true,
        hasReviewPatch: false,
        hasApplicableReviewPatch: false,
        hasOpenAskUserToolCall: false,
        hasRestorableSuspension: false,
      }),
      "NT-10 history": normalizeRestoredDocStateKind({
        persistedKind: "history",
        hasDoc: true,
        hasReviewPatch: false,
        hasApplicableReviewPatch: false,
        hasOpenAskUserToolCall: false,
        hasRestorableSuspension: false,
      }),
    };

    expect(actual).toEqual({
      "NT-2 suspension+askUser": "empty",
      "NT-4 stale askUser no suspension": "empty",
      "NT-5 review applicable": "pendingReview",
      "NT-6 review missing patch": "editing",
      "NT-7 init with doc": "editing",
      "NT-8 old busy idle with doc": "editing",
      "NT-9 old plan without suspension": "editing",
      "NT-10 committed": "editing",
      "NT-10 history": "editing",
    });
  });

  it("C7-1..C7-3 preserve from-kind guard semantics after plan/drafting/locked collapse", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const suspension = (s: SessionState) => {
      addAskUser(s);
      recordToolSuspension(s, "askUser", "ask-1");
    };
    const actual = {
      "C7-1 askUser finally no doc": attemptTransition({
        from: "empty",
        to: "empty",
        reason: "agent_turn_finally_idle",
      }).ok,
      "C7-1 unrelated no doc": attemptTransition({
        from: "empty",
        to: "editing",
        reason: "draft_candidate_committed",
      }).error,
      "C7-2 clear tool overlay with suspension": attemptTransition({
        from: "editing",
        to: "empty",
        setup: suspension,
        reason: "ask_user_abandoned",
      }).error,
      "C7-3 leave pendingReview with patches uncleared": attemptTransition({
        from: "pendingReview",
        to: "editing",
        setup: (s) => {
          seedDoc(s);
          addPatch(s);
        },
        reason: "patches_committed_idle",
      }).error,
    };
    warn.mockRestore();

    expect(actual).toEqual({
      "C7-1 askUser finally no doc": true,
      "C7-1 unrelated no doc": "DocStateTransitionError",
      "C7-2 clear tool overlay with suspension": "DocStateTransitionError",
      "C7-3 leave pendingReview with patches uncleared": "DocStateTransitionError",
    });
  });
});

function makeStateForOverlay(
  id: string,
  setup: (state: SessionState) => void,
): SessionState {
  const state = createSession(id);
  setup(state);
  return state;
}

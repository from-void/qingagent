import { describe, expect, it, vi } from "vitest";
import type { DocState, ToolCallSpec } from "@qingagent/contract-ts";
import { legacySectionsToPm } from "@qingagent/pm-schema";
import type { SessionState } from "../session/sessionState.js";
import { createSession, recordSuspension } from "../session/sessionState.js";
import {
  deriveDocStateFacts,
  DocStateTransitionError,
  idleDocState,
  normalizePersistedDocStateKind,
  normalizeRestoredDocStateKind,
  normalizeTargetDocState,
  transitionDocState,
} from "../doc-engine/docStateTransitions.js";
import { deriveContentState } from "../doc-engine/docStateMachine.js";

function seedDoc(state: SessionState): void {
  state.legacySections = [
    { kind: "h1", data: { text: "标题" } },
    { kind: "p", data: { text: "原始正文" } },
  ];
  state.doc = legacySectionsToPm(state.legacySections as never);
  state.docVersion = 1;
}

function addPatch(state: SessionState, id = "patch-1"): void {
  state.doc ??= legacySectionsToPm(state.legacySections as never);
  state.suggestions.set(id, {
    messageId: "agent-msg",
    toolCallId: id,
    before: "原始",
    after: "更新",
    blockIndex: 1,
    suggestion: {
      id,
      docId: state.docId,
      baseVersion: state.docVersion,
      baseSchemaVersion: state.doc.attrs.schemaVersion,
      status: "reviewing",
      anchor: {
        blockId: state.doc.content[1]?.attrs.blockId ?? "block-review",
        pmFrom: 1,
        pmTo: 3,
        quote: "原始",
        textHash: "test",
      },
      patch: { kind: "prosemirror_steps", steps: [] },
      preview: { deleteText: "原始", insertText: "更新" },
      summary: "更新正文",
    },
  });
}

function toolCall(
  name: string,
  status: ToolCallSpec["status"],
  id = `${name}-1`,
): ToolCallSpec {
  return {
    id,
    name,
    render: { kind: name === "askUser" ? "rightForm" : "chatInline" },
    status,
    body: { kind: "generic", data: { argsJson: "{}" } },
    result: null,
  };
}

function addToolCall(state: SessionState, spec: ToolCallSpec): void {
  state.chatHistory.push({
    id: "agent-msg",
    role: { kind: "agent" },
    ts: "2026-06-04T00:00:00.000Z",
    parts: [{ kind: "toolCall", data: spec }],
    chips: null,
  });
}

function makeState(
  from: DocState["kind"],
  setup: (state: SessionState) => void = () => {},
): SessionState {
  const state = createSession(`state-${from}-${Math.random()}`);
  state.docState = { kind: from };
  setup(state);
  return state;
}

describe("docState transition helpers", () => {
  it("derives facts from document, patches, tool calls, and suspension", () => {
    const state = makeState("editing", (s) => {
      seedDoc(s);
      addPatch(s);
      addToolCall(s, toolCall("writeDraft", { kind: "pending" }));
      addToolCall(s, toolCall("askUser", {
        kind: "running",
        data: { progressPct: null, etaSec: null },
      }));
      recordSuspension(s, {
        streamId: "stream-1",
        runId: "run-1",
        toolCallId: "askUser-1",
        toolName: "askUser",
      });
    });

    expect(deriveDocStateFacts(state)).toEqual({
      hasDoc: true,
      hasReviewPatch: true,
      hasApplicableReviewPatch: true,
      hasOpenAskUser: true,
      hasActiveSuspension: true,
    });
  });

  it("returns idle content state from document presence", () => {
    const empty = createSession("empty");
    const withDoc = createSession("with-doc");
    seedDoc(withDoc);

    expect(idleDocState(empty)).toEqual({ kind: "empty" });
    expect(idleDocState(withDoc)).toEqual({ kind: "editing" });
  });

  it("derives document presence from canonical PM doc before legacy sections", () => {
    const state = createSession("pm-doc-state");
    state.doc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "block-p" },
          content: [{ type: "text", text: "PM 正文" }],
        },
      ],
    };
    state.legacySections = [];

    expect(deriveDocStateFacts(state).hasDoc).toBe(true);
    expect(idleDocState(state)).toEqual({ kind: "editing" });
    expect(deriveContentState(state)).toEqual({ kind: "editing" });
  });

  it("normalizes restored docState into content 3-state facts", () => {
    const legacyKinds = [
      "init",
      "plan",
      "drafting",
      "draft",
      "locked",
      "review",
      "committed",
      "history",
      "empty",
      "editing",
      "pendingReview",
    ];

    for (const persistedKind of legacyKinds) {
      expect(
        normalizeRestoredDocStateKind({
          persistedKind,
          hasDoc: false,
          hasReviewPatch: false,
          hasApplicableReviewPatch: false,
          hasOpenAskUserToolCall: persistedKind === "plan",
          hasRestorableSuspension: persistedKind === "plan",
        }),
      ).toBe("empty");
      expect(
        normalizeRestoredDocStateKind({
          persistedKind,
          hasDoc: true,
          hasReviewPatch: false,
          hasApplicableReviewPatch: false,
          hasOpenAskUserToolCall: false,
          hasRestorableSuspension: false,
        }),
      ).toBe("editing");
    }

    expect(
      normalizeRestoredDocStateKind({
        persistedKind: "review",
        hasDoc: true,
        hasReviewPatch: true,
        hasApplicableReviewPatch: true,
        hasOpenAskUserToolCall: false,
        hasRestorableSuspension: false,
      }),
    ).toBe("pendingReview");
  });

  it("normalizes persisted docState from content facts only", () => {
    const review = makeState("pendingReview", (s) => {
      seedDoc(s);
      addPatch(s);
    });
    expect(normalizePersistedDocStateKind(review)).toBe("pendingReview");

    const stalePatchOnEditing = makeState("editing", (s) => {
      seedDoc(s);
      addPatch(s);
    });
    expect(normalizePersistedDocStateKind(stalePatchOnEditing)).toBe("pendingReview");

    expect(normalizePersistedDocStateKind(makeState("editing"))).toBe("empty");
    expect(normalizePersistedDocStateKind(makeState("empty", seedDoc))).toBe("editing");
  });

  it("allows the content 3x3 matrix and returns changed instead of frames", () => {
    const editing = makeState("empty", seedDoc);
    expect(transitionDocState(editing, { kind: "editing" }, "draft_candidate_committed"))
      .toEqual({ changed: true });
    expect(editing.docState).toEqual({ kind: "editing" });

    const review = makeState("editing", (s) => {
      seedDoc(s);
      addPatch(s);
    });
    expect(transitionDocState(review, { kind: "pendingReview" }, "enter_review"))
      .toEqual({ changed: true });
    expect(review.docState).toEqual({ kind: "pendingReview" });

    const committed = makeState("pendingReview", seedDoc);
    expect(transitionDocState(committed, { kind: "editing" }, "patches_committed_idle"))
      .toEqual({ changed: true });
    expect(committed.docState).toEqual({ kind: "editing" });

    expect(transitionDocState(committed, { kind: "editing" }, "draft_candidate_noop"))
      .toEqual({ changed: false });
  });

  it.each([
    ["empty -> pendingReview", "empty", "pendingReview", "enter_review", (s: SessionState) => {
      seedDoc(s);
      addPatch(s);
    }],
    ["pendingReview -> empty with patch", "pendingReview", "empty", "agent_turn_finally_idle", (s: SessionState) => {
      seedDoc(s);
      addPatch(s);
    }],
    ["pendingReview -> editing with uncleared patch", "pendingReview", "editing", "patches_committed_idle", (s: SessionState) => {
      seedDoc(s);
      addPatch(s);
    }],
    ["editing without document", "empty", "editing", "draft_candidate_committed", () => {}],
  ] as const)(
    "rejects %s",
    (_name, from, to, reason, setup) => {
      const state = makeState(from, setup);

      expect(() =>
        transitionDocState(state, { kind: to }, reason),
      ).toThrow(DocStateTransitionError);
    },
  );

  it("enforces expectedFrom when provided", () => {
    const state = makeState("editing", seedDoc);

    expect(() =>
      transitionDocState(
        state,
        { kind: "pendingReview" },
        "enter_review",
        { expectedFrom: ["pendingReview"] },
      ),
    ).toThrow(DocStateTransitionError);
  });

  it("normalizes stale targets to idle content", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = makeState("editing");

    expect(
      transitionDocState(
        state,
        { kind: "pendingReview" },
        "agent_turn_finally_idle",
        { mode: "normalize" },
      ),
    ).toEqual({ changed: true });

    expect(state.docState).toEqual({ kind: "empty" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("normalizes target docState directly", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = makeState("editing", seedDoc);

    expect(normalizeTargetDocState(state, { kind: "empty" }, "restore_normalized"))
      .toEqual({ kind: "editing" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps no-doc finally at empty and rejects clearing tool overlays with suspension", () => {
    const noDoc = makeState("empty");
    expect(transitionDocState(noDoc, { kind: "empty" }, "agent_turn_finally_idle"))
      .toEqual({ changed: false });

    const suspended = makeState("editing", (s) => {
      seedDoc(s);
      recordSuspension(s, {
        streamId: "stream-1",
        runId: "run-1",
        toolCallId: "ask-1",
        toolName: "askUser",
      });
    });
    expect(() =>
      transitionDocState(suspended, { kind: "empty" }, "ask_user_abandoned"),
    ).toThrow(DocStateTransitionError);
  });
});

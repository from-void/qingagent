import { describe, expect, it } from "vitest";
import type { ToolCallSpec } from "@qingagent/contract-ts";
import { legacySectionsToPm } from "@qingagent/pm-schema";
import {
  clearSuspension,
  createSession,
  recordSuspension,
} from "../bridge/sessionState.js";
import type { SessionState } from "../bridge/sessionState.js";
import {
  coerceLegacyContentKind,
  deriveActiveOverlay,
  deriveAgentBusy,
  deriveContentState,
  deriveEditorState,
} from "../bridge/docStateMachine.js";

function seedDoc(state: SessionState): void {
  state.legacySections = [{ kind: "p", data: { text: "正文" } }];
  state.doc = legacySectionsToPm(state.legacySections as never);
}

function seedReviewPatch(state: SessionState): void {
  state.doc ??= legacySectionsToPm(state.legacySections as never);
  state.suggestions.set("patch-1", {
    messageId: "msg-patch-1",
    toolCallId: "patch-1",
    before: "正文",
    after: "正文修改",
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
        pmTo: 3,
        quote: "正文",
        textHash: "test",
      },
      patch: { kind: "prosemirror_steps", steps: [] },
      preview: { deleteText: "正文", insertText: "正文修改" },
      summary: "修改正文",
    },
  });
}

function addToolCall(
  state: SessionState,
  name: string,
  status: ToolCallSpec["status"],
  id = `${name}-${status.kind}`,
): void {
  state.chatHistory.push({
    id: `msg-${id}`,
    role: { kind: "agent" },
    ts: "2026-06-04T00:00:00.000Z",
    chips: null,
    parts: [
      {
        kind: "toolCall",
        data: {
          id,
          name,
          render: { kind: "chatInline" },
          status,
          body: { kind: "generic", data: { argsJson: "{}" } },
          result: null,
        },
      },
    ],
  });
}

function recordToolSuspension(
  state: SessionState,
  toolName: "askUser",
  toolCallId: string,
  streamId = "stream-1",
): void {
  recordSuspension(state, {
    streamId,
    runId: `run-${toolCallId}`,
    toolCallId,
    toolName,
  });
}

function makeState(
  id: string,
  setup: (state: SessionState) => void = () => {},
): SessionState {
  const state = createSession(id);
  setup(state);
  return state;
}

function running(): ToolCallSpec["status"] {
  return { kind: "running", data: { progressPct: null, etaSec: null } };
}

describe("R0/R1 docState R5e derivation and mapping tests", () => {
  it("DC-1 derives the 3-state content model from document and patch facts only", () => {
    const actual = {
      idleNoDoc: deriveContentState(makeState("dc-idle")).kind,
      noDocWithAskUser: deriveContentState(
        makeState("dc-ask", (s) => addToolCall(s, "askUser", { kind: "pending" })),
      ).kind,
      noDocWithWriteDraft: deriveContentState(
        makeState("dc-generate", (s) => addToolCall(s, "writeDraft", running())),
      ).kind,
      doc: deriveContentState(makeState("dc-doc", seedDoc)).kind,
      docWithPatch: deriveContentState(
        makeState("dc-review", (s) => {
          seedDoc(s);
          seedReviewPatch(s);
        }),
      ).kind,
      committedCompat: deriveContentState(
        makeState("dc-committed", (s) => {
          seedDoc(s);
          s.docState = { kind: "editing" };
        }),
      ).kind,
      historyCompat: deriveContentState(
        makeState("dc-history", (s) => {
          seedDoc(s);
          s.docState = { kind: "editing" };
        }),
      ).kind,
    };

    expect(actual).toEqual({
      idleNoDoc: "empty",
      noDocWithAskUser: "empty",
      noDocWithWriteDraft: "empty",
      doc: "editing",
      docWithPatch: "pendingReview",
      committedCompat: "editing",
      historyCompat: "editing",
    });
  });

  it("DC-2/DC-3 derives agentBusy and the single active overlay without mutating state", () => {
    const state = makeState("overlay", (s) => {
      s.streamId = "stream-overlay";
      seedDoc(s);
      addToolCall(s, "askUser", { kind: "pending" }, "ask-1");
      addToolCall(s, "generateSvg", running(), "image-1");
      recordToolSuspension(s, "askUser", "ask-1", "stream-overlay");
    });
    const before = structuredClone({
      docState: state.docState,
      chatHistory: state.chatHistory,
      legacySections: state.legacySections,
    });

    const actual = {
      agentBusy: deriveAgentBusy(state),
      overlay: deriveActiveOverlay(state),
    };

    expect(actual).toEqual({
      agentBusy: false,
      overlay: "askUser",
    });
    expect({
      docState: state.docState,
      chatHistory: state.chatHistory,
      legacySections: state.legacySections,
    }).toEqual(before);
  });

  it("DC-4 applies overlay priority and ignores non-overlay draft tools", () => {
    const actual = {
      askUserFirst: deriveActiveOverlay(
        makeState("overlay-ask", (s) => {
          addToolCall(s, "askUser", { kind: "pending" }, "ask-1");
          addToolCall(s, "generateSvg", running());
          addToolCall(s, "writeDraft", running());
          recordToolSuspension(s, "askUser", "ask-1");
        }),
      ),
      imageBeforeDraftTool: deriveActiveOverlay(
        makeState("overlay-image", (s) => {
          addToolCall(s, "generateSvg", running());
          addToolCall(s, "writeDraft", running());
        }),
      ),
      draftToolOnly: deriveActiveOverlay(
        makeState("overlay-draft-tool", (s) =>
          addToolCall(s, "writeDraft", running(), "draft-tool"),
        ),
      ),
      terminalCalls: deriveActiveOverlay(
        makeState("overlay-terminal", (s) => {
          addToolCall(s, "askUser", {
            kind: "failed",
            data: { reason: "cancelled", retriable: false },
          });
          addToolCall(s, "writeDraft", { kind: "done" });
          addToolCall(s, "generateSvg", { kind: "done" });
        }),
      ),
    };

    expect(actual).toEqual({
      askUserFirst: "askUser",
      imageBeforeDraftTool: "imageProgress",
      draftToolOnly: null,
      terminalCalls: null,
    });
  });

  it("DC-5 derives agentBusy from stream ownership and clears it while suspended", () => {
    const actual = {
      runningWriteDraft: deriveAgentBusy(
        makeState("busy-doc", (s) => {
          s.streamId = "stream-doc";
          addToolCall(s, "writeDraft", running());
        }),
      ),
      runningGenerateSvg: deriveAgentBusy(
        makeState("busy-image", (s) => {
          s.streamId = "stream-image";
          addToolCall(s, "generateSvg", running());
        }),
      ),
      pendingWriteDraft: deriveAgentBusy(
        makeState("busy-pending", (s) =>
          addToolCall(s, "writeDraft", { kind: "pending" }),
        ),
      ),
      suspendedAskUser: deriveAgentBusy(
        makeState("busy-suspended", (s) => {
          s.streamId = "stream-1";
          addToolCall(s, "askUser", running(), "ask-1");
          recordToolSuspension(s, "askUser", "ask-1");
        }),
      ),
    };

    expect(actual).toEqual({
      runningWriteDraft: true,
      runningGenerateSvg: true,
      pendingWriteDraft: false,
      suspendedAskUser: false,
    });
  });

  it("ES-1 derives the 4-state editor model with locked aggregation and resume unlock", () => {
    const lockedAskUser = makeState("editor-ask", (s) => {
      seedDoc(s);
      addToolCall(s, "askUser", { kind: "pending" }, "ask-1");
      recordToolSuspension(s, "askUser", "ask-1");
    });
    const unlockedAfterFailedAskUser = makeState("editor-unlock", (s) => {
      seedDoc(s);
      addToolCall(s, "askUser", {
        kind: "failed",
        data: { reason: "not restorable", retriable: false },
      });
      recordToolSuspension(s, "askUser", "ask-1");
      clearSuspension(s);
    });

    const actual = {
      empty: deriveEditorState({ kind: "empty" }, false, null),
      editable: deriveEditorState({ kind: "editing" }, false, null),
      pendingReview: deriveEditorState({ kind: "pendingReview" }, false, null),
      lockedByAgentBusy: deriveEditorState({ kind: "editing" }, true, null),
      lockedByOverlay: deriveEditorState({ kind: "editing" }, false, "imageProgress"),
      emptyQuestionnaireLocked: deriveEditorState({ kind: "empty" }, false, "askUser"),
      resumableAskUser: deriveEditorState(
        deriveContentState(lockedAskUser),
        deriveAgentBusy(lockedAskUser),
        deriveActiveOverlay(lockedAskUser),
      ),
      nonRestorableAskUserCleared: deriveEditorState(
        deriveContentState(unlockedAfterFailedAskUser),
        deriveAgentBusy(unlockedAfterFailedAskUser),
        deriveActiveOverlay(unlockedAfterFailedAskUser),
      ),
    };

    expect(actual).toEqual({
      empty: "empty",
      editable: "editable",
      pendingReview: "pendingReview",
      lockedByAgentBusy: "locked",
      lockedByOverlay: "locked",
      emptyQuestionnaireLocked: "locked",
      resumableAskUser: "locked",
      nonRestorableAskUserCleared: "editable",
    });
  });

  it("BM-1/BM-2 coerces legacy wire kinds into the R5e 3-state content model", () => {
    const actual = Object.fromEntries(
      [
        "init",
        "plan",
        "drafting",
        "draft",
        "locked",
        "review",
        "committed",
        "history",
        "future-kind",
      ].map((kind) => [kind, coerceLegacyContentKind(kind).kind]),
    );

    expect(actual).toEqual({
      init: "empty",
      plan: "editing",
      drafting: "editing",
      draft: "editing",
      locked: "editing",
      review: "pendingReview",
      committed: "editing",
      history: "editing",
      "future-kind": "empty",
    });
  });

  it("BM-4 keeps committed/history restorable as editable content", () => {
    const actual = {
      init: coerceLegacyContentKind("init").kind,
      plan: coerceLegacyContentKind("plan").kind,
      drafting: coerceLegacyContentKind("drafting").kind,
      locked: coerceLegacyContentKind("locked").kind,
      draft: coerceLegacyContentKind("draft").kind,
      review: coerceLegacyContentKind("review").kind,
      committed: coerceLegacyContentKind("committed").kind,
      history: coerceLegacyContentKind("history").kind,
    };

    expect(actual).toEqual({
      init: "empty",
      plan: "editing",
      drafting: "editing",
      locked: "editing",
      draft: "editing",
      review: "pendingReview",
      committed: "editing",
      history: "editing",
    });
  });

  it("VM-1 keeps history viewing orthogonal to content and editor state", () => {
    const state = makeState("viewing-version", (s) => {
      seedDoc(s);
      (s as SessionState & { viewingVersion: number | null }).viewingVersion = 3;
    });
    const content = deriveContentState(state);

    expect({
      content: content.kind,
      editor: deriveEditorState(content, deriveAgentBusy(state), deriveActiveOverlay(state)),
    }).toEqual({
      content: "editing",
      editor: "editable",
    });
  });
});

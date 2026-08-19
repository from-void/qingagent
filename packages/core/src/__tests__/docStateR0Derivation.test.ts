import { describe, expect, it } from "vitest";
import type { ToolCallSpec } from "@qingagent/contract-ts";
import { pmDocFromText } from "./pmTestUtils.js";
import {
  clearSuspension,
  createSession,
  recordSuspension,
} from "../session/sessionState.js";
import type { SessionState } from "../session/sessionState.js";
import {
  deriveActiveOverlay,
  deriveAgentBusy,
  deriveContentState,
  deriveEditorState,
} from "../doc-engine/docStateMachine.js";

function seedDoc(state: SessionState): void {
  state.doc = pmDocFromText("正文");
}

function seedReviewPatch(state: SessionState): void {
  state.doc ??= pmDocFromText("正文");
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
      doc: state.doc,
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
      doc: state.doc,
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

  it("DC-5b 按可注入时钟派生外部租约，租约优先于 suspension/confirm 豁免", () => {
    const now = 1_000;
    const lease = {
      turnId: "turn-lease",
      principalId: "external:principal",
      expiresAt: now + 60_000,
      startedFromEmpty: false,
      directCommitCount: 0,
    };
    const active = makeState("busy-external-active", (state) => {
      state.externalBusyLease = lease;
    });
    const expired = makeState("busy-external-expired", (state) => {
      state.externalBusyLease = { ...lease, expiresAt: now };
    });
    const suspended = makeState("busy-external-suspended", (state) => {
      state.externalBusyLease = lease;
      addToolCall(state, "askUser", running(), "ask-lease");
      recordToolSuspension(state, "askUser", "ask-lease");
    });
    const confirming = makeState("busy-external-confirming", (state) => {
      state.externalBusyLease = lease;
      state.pendingConfirms.set("confirm-tool", {
        confirmId: "confirm-lease",
        runId: "run-confirm-lease",
        toolCallId: "confirm-tool",
        toolName: "executeCommand",
        commandDigest: "digest",
        spec: {
          id: "confirm-lease",
          kind: "command",
          title: "确认执行",
          say: "测试确认",
          primaryLabel: "执行",
          secondaryLabel: "取消",
        },
        requestedAt: "2026-08-19T00:00:00.000Z",
        expiresAt: "2026-08-19T00:01:00.000Z",
        status: "pending",
      });
    });

    expect({
      active: deriveAgentBusy(active, now),
      expired: deriveAgentBusy(expired, now),
      suspended: deriveAgentBusy(suspended, now),
      pendingConfirm: deriveAgentBusy(confirming, now),
    }).toEqual({
      active: true,
      expired: false,
      suspended: true,
      pendingConfirm: true,
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

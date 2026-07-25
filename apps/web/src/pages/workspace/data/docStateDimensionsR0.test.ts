import { describe, expect, it } from "vitest";
import type { ToolCallSpec, WorkspaceAction } from "./protocol";
import {
  DOC_EDITABLE,
} from "./protocol";
import { getChatInputBlockReason } from "./chatInputBlockReason";
import type { DocDimensions } from "./docDimensions";
import { deriveReviewUiState } from "./reviewUiState";
import {
  initialWorkspaceState,
  selectAgentBusy,
  selectGenerateSvgRunning,
  selectOpenAskUser,
  workspaceReducer,
} from "./workspaceState";
import { deriveDocDimensions } from "./docDimensions";
import { canEditDocument } from "./workspacePageView";

function askUser(status: ToolCallSpec["status"]): ToolCallSpec {
  return {
    id: "ask-1",
    name: "askUser",
    render: { kind: "chatInline" },
    status,
    body: {
      kind: "askUser",
      data: {
        id: "ask",
        mode: { kind: "overlay" },
        purpose: null,
        source: null,
        rationale: null,
        // 真实 suspended askUser 必带已流出的题目(suspend payload 含 questions);
        // 空题 + overlay 是 P4b 要兜的破态,会被 selectOpenAskUser guard 过滤。
        questions: [
          {
            id: "q-1",
            label: "写作方向?",
            kind: { kind: "text" },
            options: [],
            placeholder: null,
          },
        ],
      },
    },
    result: null,
  };
}

function reduce(...frames: WorkspaceAction[]) {
  return frames.reduce(workspaceReducer, initialWorkspaceState);
}

const lockedDim: DocDimensions = {
  content: { kind: "editing" },
  editor: "locked",
  overlay: "imageProgress",
  agentBusy: false,
};

describe("R0 frontend two-dimensional docState red tests", () => {
  it("front-end editability policy is keyed by the R5e 4-state editor model", () => {
    const editable = DOC_EDITABLE as Record<string, boolean | undefined>;

    expect({
      empty: editable.empty,
      editable: editable.editable,
      locked: editable.locked,
      pendingReview: editable.pendingReview,
      lockedBlockedReason: getChatInputBlockReason(lockedDim, false)?.placeholder,
    }).toEqual({
      empty: false,
      editable: true,
      locked: false,
      pendingReview: false,
      lockedBlockedReason: undefined,
    });
  });

  it("review UI reads pendingReview content without overlay coupling", () => {
    const actual = deriveReviewUiState({
      content: { kind: "pendingReview" },
      overlay: null,
      hasPatchCalls: true,
      visiblePatchCount: 2,
      patchRevealing: false,
      presentationCount: 2,
    });

    expect(actual).toMatchObject({
      effectiveReview: true,
      showPatchNav: true,
      livePatchCount: 2,
    });
  });

  it("N2 consumes backend overlay facts while content frames normalize 8-state legacy input to 3-state content", () => {
    const orphanGeneric = reduce(
      {
        kind: "docStateChanged",
        data: { state: { kind: "plan" }, activeOverlay: null, agentBusy: false },
      },
      {
        kind: "toolCallUpdated",
        data: {
          messageId: "agent-1",
          toolCallId: "generic-1",
          spec: {
            id: "generic-1",
            name: "writeDraft",
            render: { kind: "chatInline" },
            status: { kind: "pending" },
            body: { kind: "generic", data: { argsJson: "{}" } },
            result: null,
          },
        },
      },
    );
    const askUserState = reduce(
      {
        kind: "docStateChanged",
        data: { state: { kind: "plan" }, activeOverlay: "askUser", agentBusy: false },
      },
      {
        kind: "toolCallUpdated",
        data: {
          messageId: "agent-1",
          toolCallId: "ask-1",
          spec: askUser({ kind: "pending" }),
        },
      },
    );
    expect({
      contentKind: orphanGeneric.docState.kind,
      orphanEditor: deriveDocDimensions(orphanGeneric).editor,
      askUserPending: selectOpenAskUser(askUserState)?.id ?? null,
      askUserOverlay: deriveDocDimensions(askUserState).overlay,
    }).toEqual({
      contentKind: "editing",
      orphanEditor: "editable",
      askUserPending: "ask-1",
      askUserOverlay: "askUser",
    });
  });

  it("history viewing is orthogonal to content and editor state", () => {
    const state = reduce({
      kind: "docStateChanged",
      data: { state: { kind: "draft" }, activeOverlay: null, agentBusy: false },
    });
    const viewState = workspaceReducer(state, {
      kind: "viewingVersionSet",
      version: 2,
    });
    const dim = deriveDocDimensions(viewState);

    expect({
      contentKind: viewState.docState.kind,
      editor: dim.editor,
      viewingVersion: viewState.viewingVersion,
      editable: canEditDocument(dim, viewState.viewingVersion),
    }).toEqual({
      contentKind: "editing",
      editor: "editable",
      viewingVersion: 2,
      editable: false,
    });
  });

  it("locks editing from backend agentBusy at turn start and unlocks after idle projection", () => {
    const busy = reduce({
      kind: "docStateChanged",
      data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: true },
    });
    const busyDim = deriveDocDimensions(busy);
    const idle = workspaceReducer(busy, {
      kind: "docStateChanged",
      data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
    });
    const idleDim = deriveDocDimensions(idle);
    const askSuspended = reduce({
      kind: "docStateChanged",
      data: { state: { kind: "editing" }, activeOverlay: "askUser", agentBusy: false },
    });
    const askDim = deriveDocDimensions(askSuspended);

    expect({
      busyEditor: busyDim.editor,
      busyCanEdit: canEditDocument(busyDim, null),
      idleEditor: idleDim.editor,
      idleCanEdit: canEditDocument(idleDim, null),
      askEditor: askDim.editor,
      askCanEdit: canEditDocument(askDim, null),
    }).toEqual({
      busyEditor: "locked",
      busyCanEdit: false,
      idleEditor: "editable",
      idleCanEdit: true,
      askEditor: "locked",
      askCanEdit: false,
    });
  });

  it("imageProgress stays separate from generic agentBusy while its tool selector stays local", () => {
    const imageRunning: ToolCallSpec = {
      id: "img-1",
      name: "generateSvg",
      render: { kind: "chatInline" },
      status: { kind: "running", data: { progressPct: null, etaSec: null } },
      body: { kind: "generic", data: { argsJson: "{}" } },
      result: null,
    };
    const onlyImage = workspaceReducer(initialWorkspaceState, {
      kind: "toolCallUpdated",
      data: {
        messageId: "agent-1",
        toolCallId: "img-1",
        spec: imageRunning,
      },
    });
    const busy = workspaceReducer(onlyImage, {
      kind: "docStateChanged",
      data: { state: { kind: "editing" }, activeOverlay: "imageProgress", agentBusy: true },
    });

    expect({
      onlyImageAgentBusy: selectAgentBusy(onlyImage),
      onlyImageRunning: selectGenerateSvgRunning(onlyImage)?.id ?? null,
      onlyImageOverlay: deriveDocDimensions(onlyImage).overlay,
      busyAgentBusy: selectAgentBusy(busy),
      busyOverlay: deriveDocDimensions(busy).overlay,
    }).toEqual({
      onlyImageAgentBusy: false,
      onlyImageRunning: "img-1",
      onlyImageOverlay: null,
      busyAgentBusy: true,
      busyOverlay: "imageProgress",
    });
  });

  it("active agent stream raises agentBusy and locks editing even when the last projection was idle", () => {
    // 用户决议:agent 生成时禁止用户编辑。活跃 stream 是本轮仍在工作的直接证据，
    // 必须提升统一的 agentBusy，确保编辑锁、呼吸和 hover 提示同源。
    const editing = reduce({
      kind: "docStateChanged",
      data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
    });
    expect(deriveDocDimensions(editing).editor).toBe("editable");

    const streaming = workspaceReducer(editing, {
      kind: "stream",
      data: { kind: "start", data: { streamId: "s-gen" } },
    });
    const dim = deriveDocDimensions(streaming);
    expect({
      streamActive: streaming.streamActive,
      agentBusy: streaming.agentBusy,
      editor: dim.editor,
      editable: canEditDocument(dim, streaming.viewingVersion),
    }).toEqual({
      streamActive: true,
      agentBusy: true,
      editor: "locked",
      editable: false,
    });

    const ended = workspaceReducer(streaming, {
      kind: "stream",
      data: { kind: "end", data: { streamId: "s-gen", reason: { kind: "done" } } },
    });
    expect(deriveDocDimensions(ended).editor).toBe("editable");
  });

  it("does not keep chat input locked when askUser overlay has no actionable card", () => {
    const brokenAskUserDim: DocDimensions = {
      content: { kind: "editing" },
      editor: "locked",
      overlay: "askUser",
      agentBusy: false,
    };

    expect(getChatInputBlockReason(brokenAskUserDim, false, false, false)).toBeNull();
  });
});

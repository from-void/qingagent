// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AnnotationGroup, BridgeFrame, Command, DiffHunk, DocSuggestion, DocumentSnapshot, Resource, ToolCallSpec } from "@qingagent/contract-ts";
import type { PmBlockNode, PmDoc } from "@qingagent/pm-schema";
import type { ChatInputSnapshot } from "./components/ChatInput";
import type { DocDimensions } from "./data/docDimensions";
import {
  derivePatchPresentation,
  pmDocToViewDocumentSnapshot,
  suggestionToBlockPatchInput,
  suggestionToPatchOverlay,
  type AppliedPatch,
  type ViewDocumentSnapshot,
} from "./data/protocol";
import {
  initialWorkspaceState,
  selectPatches,
  workspaceReducer,
  type WorkspaceAction,
} from "./data/workspaceState";

declare global {
  // React 18 test-utils 在非 Jest jsdom 环境下读取这个标记。
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type MockServerStreamInstance = {
  listeners: Set<(frame: BridgeFrame) => void>;
  sendCommand: ReturnType<typeof vi.fn>;
  startSession: ReturnType<typeof vi.fn>;
  listDerivatives: ReturnType<typeof vi.fn>;
  getDerivativeDoc: ReturnType<typeof vi.fn>;
  commitReviewGroups: ReturnType<typeof vi.fn>;
  ignoreAnnotationGroups: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  emit: (frame: BridgeFrame) => void;
};

const serverStreamMock = vi.hoisted(() => ({
  instances: [] as MockServerStreamInstance[],
  // 可控 startSession(e2e-loop-0704 R15 回归用):置非 null 时替代默认的立即 resolve,
  // 用于模拟"建会话在途"窗口。用完的测试负责在 finally 里清回 null。
  startSessionImpl: null as (() => Promise<string>) | null,
}));

vi.mock("./data/serverStream", () => {
  class ServerStream {
    listeners = new Set<(frame: BridgeFrame) => void>();
    sendCommand = vi.fn(async (command: Command) => {
      if (command.kind === "updateDoc") {
        this.emit({
          kind: "docWriteResult",
          data: {
            ok: true,
            clientMutationId: command.data.clientMutationId,
            docVersion: command.data.expectedDocumentSnapshot + 1,
          },
        });
      }
    });
    startSession = vi.fn(async () =>
      serverStreamMock.startSessionImpl ? serverStreamMock.startSessionImpl() : "s-1",
    );
    listDerivatives = vi.fn(async () => []);
    getDerivativeDoc = vi.fn(async () => null);
    commitReviewGroups = vi.fn(async () => []);
    ignoreAnnotationGroups = vi.fn(async () => undefined);
    stop = vi.fn(() => {
      this.dispatchLocal?.({ kind: "streamTerminated", reason: "stop" });
    });
    dispose = vi.fn(() => {
      this.listeners.clear();
    });

    constructor(private readonly dispatchLocal?: (action: unknown) => void) {
      serverStreamMock.instances.push(this);
    }

    subscribe(listener: (frame: BridgeFrame) => void): () => void {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    }

    emit(frame: BridgeFrame): void {
      for (const listener of [...this.listeners]) listener(frame);
    }
  }

  return { ServerStream };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let restoreWorkspaceDomMocks: (() => void) | null = null;

function reviewDimensions(overrides: Partial<DocDimensions> = {}): DocDimensions {
  return {
    content: { kind: "pendingReview" },
    editor: "locked",
    overlay: null,
    agentBusy: true,
    ...overrides,
  };
}

function multiGroupDoc(count: number): ViewDocumentSnapshot {
  const paragraphs = Array.from({ length: count }, (_, index) => {
    const id = `p-${index + 1}`;
    return pmParagraph(`block-${id}`, `第 ${index + 1} 段 旧句子`);
  });
  return {
    version: 1,
    ts: "t",
    pmDoc: pmDoc(paragraphs),
    sections: Array.from({ length: count }, (_, index) => {
      const id = `p-${index + 1}`;
      return {
        kind: "p",
        spans: [
          { kind: "text", text: `第 ${index + 1} 段 ` },
          { kind: "patchDel", patchId: id, text: "旧句子" },
          { kind: "patchIns", patchId: id, text: "新句子" },
        ],
      };
    }),
  };
}

function patchMeta(count: number) {
  return new Map(
    Array.from({ length: count }, (_, index) => {
      const id = `p-${index + 1}`;
      return [
        id,
        {
          before: "旧句子",
          after: "新句子",
          kind: "text" as const,
          index: index + 1,
        },
      ] as const;
    }),
  );
}

function multiGroupReviewData(count: number): {
  suggestions: DocSuggestion[];
  applied: AppliedPatch[];
} {
  const suggestions: DocSuggestion[] = [];
  const applied: AppliedPatch[] = [];
  let pos = 0;
  for (let index = 0; index < count; index++) {
    const id = `p-${index + 1}`;
    const prefix = `第 ${index + 1} 段 `;
    const before = "旧句子";
    const after = "新句子";
    const pmFrom = pos + 1 + prefix.length;
    const pmTo = pmFrom + before.length;
    suggestions.push(reviewSuggestion({
      id,
      blockId: `block-${id}`,
      pmFrom,
      pmTo,
      before,
      after,
    }));
    applied.push(reviewAppliedPatch(id, index + 1, "replace", before, after));
    pos += prefix.length + before.length + 2;
  }
  return { suggestions, applied };
}

function pmText(text: string) {
  return { type: "text" as const, text };
}

function pmParagraph(blockId: string, text: string): PmBlockNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [pmText(text)] : [],
  };
}

function pmHeading(blockId: string, text: string): PmBlockNode {
  return {
    type: "heading",
    attrs: { blockId, level: 2 },
    content: text ? [pmText(text)] : [],
  };
}

function pmBulletList(blockId: string, itemBlockId: string, itemText: string): PmBlockNode {
  return {
    type: "bulletList",
    attrs: { blockId },
    content: [{
      type: "listItem",
      attrs: { blockId: itemBlockId },
      content: [pmParagraph(`${itemBlockId}-p`, itemText)],
    }],
  };
}

function pmCodeBlock(blockId: string, body: string): PmBlockNode {
  return {
    type: "codeBlock",
    attrs: { blockId, language: "ts" },
    content: body ? [{ type: "text", text: body }] : [],
  };
}

function pmDoc(content: PmBlockNode[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function wireSnapshotFromPmDoc(doc: PmDoc, version: number): DocumentSnapshot {
  return {
    version,
    ts: "t",
    doc,
  };
}

function pmPlainText(node: unknown): string {
  if (node === null || typeof node !== "object") return "";
  const record = node as { text?: unknown; content?: unknown };
  const ownText = typeof record.text === "string" ? record.text : "";
  const childText = Array.isArray(record.content)
    ? record.content.map((child) => pmPlainText(child)).join("\n")
    : "";
  return [ownText, childText].filter(Boolean).join("\n");
}

function blockSuggestion(id: string, hunk: DiffHunk): DocSuggestion {
  return {
    id,
    reviewBatchId: hunk.reviewBatchId,
    groupMode: hunk.groupMode,
    docId: "doc-1",
    baseVersion: 1,
    baseSchemaVersion: 1,
    status: "reviewing",
    anchor: {
      blockId: hunk.anchor.blockId ?? id,
      pmFrom: hunk.anchor.pmFrom ?? 0,
      pmTo: hunk.anchor.pmTo ?? hunk.anchor.pmFrom ?? 0,
      quote: hunk.beforeText ?? hunk.afterText ?? id,
      textHash: `hash-${id}`,
    },
    patch: { kind: "prosemirror_steps", steps: [] },
    preview: {
      deleteText: hunk.beforeText ?? "",
      insertText: hunk.afterText ?? "",
    },
    summary: hunk.summary,
    diffHunk: hunk,
  };
}

function reviewSuggestion({
  id,
  blockId,
  pmFrom,
  pmTo,
  before,
  after,
  stepType = "replace",
}: {
  id: string;
  blockId: string;
  pmFrom: number;
  pmTo: number;
  before: string;
  after: string;
  stepType?: string;
}): DocSuggestion {
  return {
    id,
    reviewBatchId: id,
    groupMode: "independent",
    docId: "doc-1",
    baseVersion: 1,
    baseSchemaVersion: 1,
    status: "reviewing",
    anchor: {
      blockId,
      pmFrom,
      pmTo,
      quote: before || after,
      textHash: `hash-${id}`,
    },
    patch: { kind: "prosemirror_steps", steps: [{ stepType, from: pmFrom, to: pmTo }] },
    preview: { deleteText: before, insertText: after },
    summary: "测试修改",
  };
}

function reviewAppliedPatch(
  id: string,
  index: number,
  kind: AppliedPatch["kind"],
  before: string,
  after: string,
  marks?: AppliedPatch["marks"],
): AppliedPatch {
  return {
    id,
    reviewBatchId: id,
    groupMode: "independent",
    before,
    after,
    kind,
    ...(marks ? { marks } : {}),
    index,
  };
}

function docDiffInsertReviewFixture() {
  const baseDoc = pmDocToViewDocumentSnapshot(pmDoc([
    pmParagraph("block-a", "第一段"),
    pmParagraph("block-b", "第二段"),
  ]), 3, "t");
  const hunk: DiffHunk = {
    hunkId: "insert-docdiff",
    reviewBatchId: "batch-insert-docdiff",
    groupMode: "atomic",
    op: "insert",
    blockPath: [],
    anchor: {},
    before: null,
    after: [
      pmHeading("block-new-title", "新增标题"),
      pmParagraph("block-new-p", "新增段落"),
      pmBulletList("block-new-list", "block-new-li", "新增列表"),
    ] as never,
    summary: "插入新增块",
    afterText: "新增标题\n新增段落\n新增列表",
  };
  const state = ([
    {
      kind: "docStateChanged",
      data: { state: { kind: "pendingReview" }, activeOverlay: null, agentBusy: false },
    },
    {
      kind: "docDiffReady",
      data: {
        baseVersion: 3,
        suggestions: [blockSuggestion("insert-docdiff", hunk)],
      },
    },
  ] satisfies WorkspaceAction[]).reduce(workspaceReducer, initialWorkspaceState);
  const patchCalls = selectPatches(state);
  const overlayInputs = patchCalls.flatMap((tc, order) => {
    if (tc.body.kind !== "docSuggestion" || tc.body.data.kind !== "suggestion") return [];
    const overlay = suggestionToPatchOverlay(baseDoc, tc.body.data.data, order);
    return overlay ? [overlay] : [];
  });
  const blockPatchInputs = patchCalls.flatMap((tc, order) => {
    if (tc.body.kind !== "docSuggestion" || tc.body.data.kind !== "suggestion") return [];
    const input = suggestionToBlockPatchInput(tc.body.data.data, order);
    return input ? [input] : [];
  });
  const presentation = derivePatchPresentation(baseDoc, overlayInputs, blockPatchInputs);
  const meta = new Map(
    presentation.applied.map((patch) => [
      patch.id,
      {
        before: patch.before,
        after: patch.after,
        kind: patch.kind,
        index: patch.index,
      },
    ]),
  );
  return { baseDoc, presentation, patchMeta: meta, blockPatchInputs };
}

function insertBlockDoc(): ViewDocumentSnapshot {
  return {
    version: 1,
    ts: "t",
    pmDoc: pmDoc([pmParagraph("block-new", "")]),
    sections: [{
      kind: "p",
      blockId: "block-new",
      blockPatch: { patchId: "insert-block", op: "insert" },
      spans: [{ kind: "patchIns", patchId: "insert-block", text: "新增段落" }],
    }],
  };
}

function insertBlockPatchMeta() {
  return new Map([
    [
      "insert-block",
      {
        before: "",
        after: "新增段落",
        kind: "insert" as const,
        index: 1,
      },
    ],
  ]);
}

function insertBlockReviewData(): {
  suggestions: DocSuggestion[];
  applied: AppliedPatch[];
} {
  return {
    suggestions: [
      reviewSuggestion({
        id: "insert-block",
        blockId: "block-new",
        pmFrom: 1,
        pmTo: 1,
        before: "",
        after: "新增段落",
      }),
    ],
    applied: [reviewAppliedPatch("insert-block", 1, "insert", "", "新增段落")],
  };
}

function mixedContentMarkDoc(): ViewDocumentSnapshot {
  return {
    version: 1,
    ts: "t",
    pmDoc: pmDoc([pmParagraph("mixed-block", "前 旧文 重点")]),
    sections: [{
      kind: "p",
      spans: [
        { kind: "text", text: "前 " },
        { kind: "patchDel", patchId: "mixed-text", text: "旧文" },
        { kind: "patchIns", patchId: "mixed-text", text: "新文" },
        { kind: "text", text: " " },
        {
          kind: "patchMark",
          patchId: "mixed-mark",
          text: "重点",
          op: "markAdd",
          marks: [{ type: "bold" }, { type: "highlight", attrs: { color: "yellow" } }],
          label: "将加粗、高亮",
        },
      ],
    }],
  };
}

function mixedContentMarkPatchMeta() {
  const changes = [
    { kind: "content" as const, before: "旧文", after: "新文" },
    {
      kind: "mark" as const,
      op: "markAdd" as const,
      marks: [{ type: "bold" as const }, { type: "highlight" as const, attrs: { color: "yellow" as const } }],
      label: "将加粗、高亮",
    },
  ];
  return new Map([
    [
      "mixed-text",
      {
        before: "旧文",
        after: "新文",
        kind: "text" as const,
        index: 1,
        changes,
      },
    ],
    [
      "mixed-mark",
      {
        before: "重点",
        after: "重点",
        kind: "markAdd" as const,
        marks: [{ type: "bold" as const }, { type: "highlight" as const, attrs: { color: "yellow" as const } }],
        label: "将加粗、高亮",
        index: 1,
        changes,
      },
    ],
  ]);
}

function mixedContentMarkReviewData(): {
  suggestions: DocSuggestion[];
  applied: AppliedPatch[];
} {
  return {
    suggestions: [
      reviewSuggestion({
        id: "mixed-text",
        blockId: "mixed-block",
        pmFrom: 3,
        pmTo: 5,
        before: "旧文",
        after: "新文",
      }),
      reviewSuggestion({
        id: "mixed-mark",
        blockId: "mixed-block",
        pmFrom: 6,
        pmTo: 8,
        before: "重点",
        after: "重点",
        stepType: "addMark",
      }),
    ],
    applied: [
      reviewAppliedPatch("mixed-text", 1, "replace", "旧文", "新文"),
      reviewAppliedPatch(
        "mixed-mark",
        1,
        "markAdd",
        "重点",
        "重点",
        [{ type: "bold" }, { type: "highlight", attrs: { color: "yellow" } }],
      ),
    ],
  };
}

function reviewToolCall(
  id: string,
  reviewBatchId: string,
  status: "reviewing" | "accepted" | "rejected",
  options: {
    blockId?: string;
    before?: string;
    after?: string;
    index?: number;
    groupMode?: "atomic" | "independent";
  } = {},
): ToolCallSpec {
  const blockId = options.blockId ?? "block-1";
  const before = options.before ?? "旧句子";
  const after = options.after ?? "新句子";
  const index = options.index ?? 0;
  const groupMode = options.groupMode ?? "atomic";
  return {
    id,
    name: "docSuggestion",
    render: { kind: "docInlinePatch" },
    status: { kind: status },
    body: {
      kind: "docSuggestion",
      data: {
        kind: "suggestion",
        data: {
          id,
          reviewBatchId,
          groupMode,
          docId: "doc-1",
          baseVersion: 1,
          baseSchemaVersion: 1,
          status,
          anchor: {
            blockId,
            pmFrom: 1,
            pmTo: 1 + before.length,
            quote: before,
            textHash: "hash",
          },
          patch: { kind: "prosemirror_steps", steps: [] },
          preview: { deleteText: before, insertText: after },
          diffHunk: {
            hunkId: id,
            reviewBatchId,
            groupMode,
            op: "replace",
            blockPath: [index],
            anchor: { blockId },
            before: null,
            after: null,
            summary: "替换句子",
            beforeText: before,
            afterText: after,
          },
          summary: "替换句子",
        },
      },
    },
    result: null,
  };
}

function rightPaneProps(overrides: Record<string, unknown> = {}) {
  const doc = multiGroupDoc(7);
  const reviewData = multiGroupReviewData(7);
  return {
    dimensions: reviewDimensions(),
    agentReasoning: false,
    doc,
    streamError: null,
    generationDraftDoc: null,
    viewingSnapshotDoc: null,
    wholeDocReview: false,
    wholeDocVersion: "new" as const,
    editedNewDoc: null,
    onWholeDocVersionChange: vi.fn(),
    patchesAccepted: new Set<string>(),
    patchesRejected: new Set<string>(),
    reviewedCount: 0,
    remainingCount: 7,
    activePatchIndex: -1,
    visiblePatchCount: 7,
    unrenderablePatchCount: 0,
    effectiveReview: true,
    reviewMaterializing: false,
    fullpageAsk: null,
    viewingVersion: null,
    committedToastVersion: null,
    docViewRef: { current: null },
    patchMeta: patchMeta(7),
    activePatchId: null,
    reviewSuggestions: reviewData.suggestions,
    reviewAppliedPatches: reviewData.applied,
    revealedPatchIds: null,
    revealCursors: new Map<string, number>(),
    typedByPatch: null,
    patchRevealing: false,
    tiptapEditor: null,
    sessionId: "s-1",
    stream: null,
    presentationRun: null,
    presentationReducedMotion: true,
    onToast: vi.fn(),
    onAiModify: vi.fn(async () => true),
    onSubmitPlan: vi.fn(),
    onJumpPrev: vi.fn(),
    onJumpNext: vi.fn(),
    onRejectAll: vi.fn(),
    onCommit: vi.fn(),
    onPatchVerdict: vi.fn(),
    onCancelAskUser: vi.fn(),
    onCloseViewingVersion: vi.fn(),
    onEditorReady: vi.fn(),
    onEditorChange: vi.fn(),
    onPresentationFinish: vi.fn(),
    onPresentationCancel: vi.fn(),
    onFillTemplate: vi.fn(),
    onCreateBlank: vi.fn(),
    ...overrides,
  };
}

describe("WorkspacePage review controls", () => {
  beforeEach(() => {
    vi.resetModules();
    serverStreamMock.instances.length = 0;
    window.location.hash = "";
    sessionStorage.clear();
    localStorage.setItem("qingagent.deepseek_api_key", "test-key");
    restoreWorkspaceDomMocks = installWorkspaceDomMocks();
  });

  afterEach(() => {
    restoreWorkspaceDomMocks?.();
    restoreWorkspaceDomMocks = null;
    localStorage.removeItem("qingagent.deepseek_api_key");
    vi.unstubAllEnvs();
    vi.useRealTimers();
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
  });

  it("离开工作区后延迟关闭客户端流", async () => {
    const { WorkspacePage } = await import("./WorkspacePage");
    await render(<WorkspacePage />);
    const stream = latestServerStream();
    vi.useFakeTimers();

    act(() => root?.unmount());
    root = null;
    expect(stream.dispose).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(75));
    expect(stream.dispose).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("StrictMode 演练 cleanup 会取消延迟释放并复用当前流", async () => {
    const { WorkspacePage } = await import("./WorkspacePage");
    await render(
      <StrictMode>
        <WorkspacePage />
      </StrictMode>,
    );
    const mountedStreams = [...serverStreamMock.instances];
    const stream = latestServerStream();
    vi.useFakeTimers();

    act(() => vi.advanceTimersByTime(75));
    expect(mountedStreams.length).toBeGreaterThan(0);
    for (const mountedStream of mountedStreams) {
      expect(mountedStream.dispose).not.toHaveBeenCalled();
    }

    act(() => root?.unmount());
    root = null;
    act(() => vi.advanceTimersByTime(75));
    expect(stream.dispose).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("编辑后 400ms 内返回首页会先以旧会话身份保存正文", async () => {
    window.location.hash = "#/workspace?session=s-1";
    const [{ useWorkspacePageController }, { WorkspaceDocumentPane }] =
      await Promise.all([
        import("./WorkspacePage"),
        import("./components/WorkspaceDocumentPane"),
      ]);
    const captured: {
      current: ReturnType<typeof useWorkspacePageController> | null;
    } = { current: null };
    function ControllerHarness() {
      const controller = useWorkspacePageController();
      captured.current = controller;
      return <WorkspaceDocumentPane controller={controller} />;
    }
    await render(<ControllerHarness />);
    const stream = latestServerStream();
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "待保存会话" } },
      {
        kind: "documentSnapshotWritten",
        data: {
          doc: wireSnapshotFromPmDoc(
            pmDoc([pmParagraph("p-home-save", "初始正文")]),
            1,
          ),
        },
      },
      {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
      },
    ]);
    await flushMicrotasks(5);
    const editor = captured.current?.tiptapEditor;
    expect(editor).not.toBeNull();
    vi.useFakeTimers();

    act(() => {
      editor!.commands.setContent(
        pmDoc([pmParagraph("p-home-save", "返回首页前的新正文")]),
      );
    });
    expect(updateDocCommands(stream)).toHaveLength(0);

    await act(async () => {
      await captured.current!.handleBackHome();
    });

    expect(updateDocCommands(stream)).toHaveLength(1);
    expect(updateDocCommands(stream)[0]?.data.sessionId).toBe("s-1");
    expect(JSON.stringify(updateDocCommands(stream)[0]?.data.doc)).toContain(
      "返回首页前的新正文",
    );
    act(() => vi.advanceTimersByTime(260));
    expect(window.location.hash).toBe("#/");
  }, 15_000);

  it("多 atomic group 且 agentBusy 未清零时仍渲染审查提交与 hover 取消控件", async () => {
    vi.useFakeTimers();
    const { RightPane } = await import("./WorkspacePage");
    const onPatchVerdict = vi.fn();
    await render(
      <section id="view-workspace">
        <RightPane {...rightPaneProps({ onPatchVerdict })} />
      </section>,
    );

    expect(host?.querySelector('[data-wf="PatchNav"]')).not.toBeNull();
    expect(host?.textContent).toContain("剩余 · 7 处");
    expect(host?.textContent).toContain("放弃全部");
    expect(host?.textContent).toContain("提交 ↵");
    expect(host?.textContent).not.toContain("提交已接受");
    expect(host?.querySelector(".wf-block-review")).toBeNull();
    expect(host?.querySelectorAll(".wf-patch-ins")).toHaveLength(7);
    expect(host?.querySelector(".patch-hover-popup")).toBeNull();
    const firstWrap = host!.querySelector("[data-patch-state]")!;
    act(() => {
      firstWrap.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    const firstPopup = host!.querySelector(".patch-hover-popup")!;
    expect(firstPopup!.classList.contains("is-visible")).toBe(true);
    act(() => {
      firstWrap.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: host }));
      vi.advanceTimersByTime(199);
    });
    expect(firstPopup!.classList.contains("is-visible")).toBe(true);
    act(() => {
      firstPopup!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: host }));
      vi.advanceTimersByTime(1);
    });
    expect(firstPopup!.classList.contains("is-visible")).toBe(true);
    act(() => {
      firstPopup.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: host }));
      vi.advanceTimersByTime(200);
    });
    expect(host!.querySelector(".patch-hover-popup")).toBeNull();
    act(() => {
      firstWrap.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    const visiblePopup = host!.querySelector(".patch-hover-popup")!;
    const buttons = [...visiblePopup.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["撤销"]);
    expect(visiblePopup.textContent).not.toContain("接受");
    expect(visiblePopup.textContent).not.toContain("拒绝");

    buttons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onPatchVerdict).toHaveBeenCalledTimes(1);
    expect(onPatchVerdict).toHaveBeenCalledWith("p-1", "rejected");
  }, 30000);

  it("空文档·左侧未推理→空引导态(模板区,非青字)", async () => {
    const { RightPane } = await import("./WorkspacePage");
    await render(
      <section id="view-workspace">
        <RightPane {...rightPaneProps({
          dimensions: reviewDimensions({ content: { kind: "empty" }, editor: "empty", agentBusy: false }),
          doc: null,
          agentReasoning: false,
        })} />
      </section>,
    );
    // 静止未操作 → 空引导态(模板区),不再是青字 loading;青字只留给推理态
    expect(host?.querySelector("[data-wf='StarterPanel']")).not.toBeNull();
    expect(host?.querySelector(".starter-card")).not.toBeNull();
    expect(host?.querySelector(".qing-empty")).toBeNull();
  });

  it("空文档·overlay 问卷挂起(不推理)→青字静候,不渲染可交互引导态(review #1)", async () => {
    const { RightPane } = await import("./WorkspacePage");
    await render(
      <section id="view-workspace">
        <RightPane {...rightPaneProps({
          // overlay 形态 askUser 挂起:agentBusy=false、agentReasoning=false,但 overlay=askUser、
          // 服务端 editorState=locked——此时给 StarterPanel 只会让填充/正文点击被拒(状态分叉)
          dimensions: reviewDimensions({
            content: { kind: "empty" },
            editor: "locked",
            overlay: "askUser",
            agentBusy: false,
          }),
          doc: null,
          agentReasoning: false,
          fullpageAsk: null,
        })} />
      </section>,
    );
    expect(host?.querySelector("[data-wf='StarterPanel']")).toBeNull();
    expect(host?.querySelector(".qing-empty")).not.toBeNull();
  });

  it("空文档·左侧推理中→青简 loading 推理态(非静止)", async () => {
    const { RightPane } = await import("./WorkspacePage");
    await render(
      <section id="view-workspace">
        <RightPane {...rightPaneProps({
          dimensions: reviewDimensions({ content: { kind: "empty" }, editor: "empty", agentBusy: true }),
          doc: null,
          agentReasoning: true,
        })} />
      </section>,
    );
    const loading = host?.querySelector(".qing-empty");
    expect(loading).not.toBeNull();
    expect(loading!.classList.contains("is-static")).toBe(false);
  });

  it("inline askUser 暂停时若已有文档,右侧保持只读正文而不是回到 loading", async () => {
    const { RightPane } = await import("./WorkspacePage");
    const doc = pmDocToViewDocumentSnapshot(
      pmDoc([pmParagraph("inline-ask-doc", "已有正文继续显示")]),
      8,
      "t-inline-ask",
    );

    await render(
      <section id="view-workspace">
        <RightPane
          {...rightPaneProps({
            dimensions: reviewDimensions({
              content: { kind: "empty" },
              editor: "locked",
              overlay: "askUser",
              agentBusy: false,
            }),
            doc,
            effectiveReview: false,
            remainingCount: 0,
            visiblePatchCount: 0,
          })}
        />
      </section>,
    );

    expect(host?.querySelector(".qing-empty")).toBeNull();
    expect(host?.querySelector('[data-wf="DocumentSnapshotView"]')).not.toBeNull();
    expect(host?.textContent).toContain("已有正文继续显示");
  });

  it("A2 插入块按 patchIns 正文混排并通过 hover popup 操作", async () => {
    const { RightPane } = await import("./WorkspacePage");
    const onPatchVerdict = vi.fn();
    const doc = insertBlockDoc();
    const reviewData = insertBlockReviewData();
    await render(
      <section id="view-workspace">
        <RightPane
          {...rightPaneProps({
            doc,
            patchMeta: insertBlockPatchMeta(),
            reviewSuggestions: reviewData.suggestions,
            reviewAppliedPatches: reviewData.applied,
            remainingCount: 1,
            visiblePatchCount: 1,
            onPatchVerdict,
          })}
        />
      </section>,
    );

    expect(host?.querySelector(".wf-block-review")).toBeNull();
    const inserted = host?.querySelector(".wf-patch-ins");
    expect(inserted?.textContent).toBe("新增段落");
    act(() => {
      host?.querySelector(".wf-patch-ins-wrap")?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    const popup = host?.querySelector(".patch-hover-popup");
    expect(popup).not.toBeNull();
    const buttons = [...popup!.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["撤销"]);
    expect(popup!.textContent).not.toContain("接受");

    buttons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onPatchVerdict).toHaveBeenCalledTimes(1);
    expect(onPatchVerdict).toHaveBeenCalledWith("insert-block", "rejected");
  });

  it("P7 docDiffReady 无锚新增块渲染为待接受块且可撤销", async () => {
    const { RightPane } = await import("./WorkspacePage");
    const onPatchVerdict = vi.fn();
    const { baseDoc, presentation, patchMeta, blockPatchInputs } = docDiffInsertReviewFixture();

    expect(presentation.droppedIds).toEqual([]);
    expect(presentation.conflictIds).toEqual([]);

    await render(
      <section id="view-workspace">
        <RightPane
          {...rightPaneProps({
            doc: baseDoc,
            patchMeta,
            remainingCount: 1,
            visiblePatchCount: 1,
            unrenderablePatchCount: 0,
            reviewSuggestions: [],
            reviewOverlayInputs: [],
            reviewBlockPatches: blockPatchInputs,
            reviewAppliedPatches: presentation.applied,
            onPatchVerdict,
          })}
        />
      </section>,
    );

    expect(host?.querySelector('[data-wf="PatchUnrenderableHint"]')).toBeNull();
    const inserted = host?.querySelector('[data-patch-id="insert-docdiff"].wf-blockmark.insert') as HTMLElement | null;
    expect(inserted).not.toBeNull();
    expect(inserted?.querySelector(".wf-patch-ins")?.textContent).toContain("新增标题");
    expect(inserted?.querySelector(".wf-patch-ins")?.textContent).toContain("新增段落");
    expect(inserted?.querySelector(".wf-patch-ins")?.textContent).toContain("新增列表");

    act(() => {
      inserted?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    const popup = host?.querySelector(".patch-hover-popup");
    expect(popup).not.toBeNull();
    const buttons = [...popup!.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["撤销"]);
    buttons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatchVerdict).toHaveBeenCalledWith("insert-docdiff", "rejected");

    await act(async () => {
      root?.render(
        <section id="view-workspace">
          <RightPane
            {...rightPaneProps({
              doc: baseDoc,
              patchesRejected: new Set(["insert-docdiff"]),
              patchMeta,
              remainingCount: 0,
              visiblePatchCount: 1,
              unrenderablePatchCount: 0,
              reviewSuggestions: [],
              reviewOverlayInputs: [],
              reviewBlockPatches: blockPatchInputs,
              reviewAppliedPatches: presentation.applied,
              onPatchVerdict,
            })}
          />
        </section>,
      );
    });

    const rejectedDoc = host?.querySelector('[data-wf="DocumentSnapshotView"]');
    expect(host?.querySelectorAll(".wf-patch-ins")).toHaveLength(0);
    expect(host?.querySelector(".wf-blockmark.insert")).toBeNull();
    expect(rejectedDoc?.textContent).not.toContain("新增标题");
    expect(rejectedDoc?.textContent).not.toContain("新增段落");
    expect(rejectedDoc?.textContent).not.toContain("新增列表");
  });

  it("docDiffReady 缺 editedDoc 时直接走内联审阅,不进入整理中占位", async () => {
    const { deriveReviewRenderMode, RightPane } = await import("./WorkspacePage");
    const mode = deriveReviewRenderMode({
      effectiveReview: true,
      editedNewDoc: null,
      changeRatio: 1,
      wholeDocReviewThreshold: 0.1,
    });

    expect(mode.wholeDocReview).toBe(false);
    expect(mode.awaitingWholeDocReviewMaterial).toBe(false);
    expect(mode.inlinePatchReview).toBe(true);

    await render(
      <section id="view-workspace">
        <RightPane
          {...rightPaneProps({
            effectiveReview: mode.inlinePatchReview,
            reviewMaterializing: mode.awaitingWholeDocReviewMaterial,
          })}
        />
      </section>,
    );

    expect(host?.textContent).not.toContain("正在整理审阅视图");
    expect(host?.querySelectorAll(".wf-patch-ins")).toHaveLength(7);
  });

  it("历史快照未加载时不回退渲染当前正文", async () => {
    const { RightPane } = await import("./WorkspacePage");
    const currentDoc = pmDocToViewDocumentSnapshot(
      pmDoc([pmParagraph("current-p", "当前正文")]),
      3,
      "t-current",
    );

    await render(
      <section id="view-workspace">
        <RightPane
          {...rightPaneProps({
            dimensions: reviewDimensions({
              content: { kind: "editing" },
              editor: "editable",
              agentBusy: false,
            }),
            doc: currentDoc,
            effectiveReview: false,
            viewingVersion: 2,
            viewingSnapshotDoc: null,
          })}
        />
      </section>,
    );

    expect(host?.textContent).toContain("正在查看历史版本 #2");
    expect(host?.textContent).toContain("正在加载历史版本");
    expect(host?.textContent).not.toContain("当前正文");
  });

  it("历史模式显示历史快照而不是当前正文", async () => {
    const { RightPane } = await import("./WorkspacePage");
    const currentDoc = pmDocToViewDocumentSnapshot(
      pmDoc([pmParagraph("current-p", "当前正文")]),
      3,
      "t-current",
    );
    const historyDoc = pmDocToViewDocumentSnapshot(
      pmDoc([pmParagraph("history-p", "历史正文")]),
      1,
      "t-history",
    );

    await render(
      <section id="view-workspace">
        <RightPane
          {...rightPaneProps({
            dimensions: reviewDimensions({
              content: { kind: "editing" },
              editor: "editable",
              agentBusy: false,
            }),
            doc: currentDoc,
            effectiveReview: false,
            viewingVersion: 2,
            viewingSnapshotDoc: historyDoc,
          })}
        />
      </section>,
    );

    expect(host?.textContent).toContain("正在查看历史版本 #2");
    expect(host?.textContent).toContain("历史正文");
    expect(host?.textContent).not.toContain("当前正文");
  });

  it("P7 docDiff 或 pendingReview 激活时压制 presentationRun", async () => {
    const { shouldSuppressPresentationRun } = await import("./WorkspacePage");

    expect(shouldSuppressPresentationRun({
      hasDocDiff: true,
      contentKind: "editing",
    })).toBe(true);
    expect(shouldSuppressPresentationRun({
      hasDocDiff: false,
      contentKind: "pendingReview",
    })).toBe(true);
    expect(shouldSuppressPresentationRun({
      hasDocDiff: false,
      contentKind: "editing",
    })).toBe(false);
  });

  it("generation_finished 到 editing 投影之间不以短暂 locked 清除揭示", async () => {
    const { shouldRetainPresentationRun } = await import("./WorkspacePage");
    expect(shouldRetainPresentationRun({
      reducedMotion: false,
      runDocVersion: 2,
      currentDocVersion: 2,
      runSessionId: "s-1",
      currentSessionId: "s-1",
    })).toBe(true);
    expect(shouldRetainPresentationRun({
      reducedMotion: false,
      runDocVersion: 2,
      currentDocVersion: 3,
      runSessionId: "s-1",
      currentSessionId: "s-1",
    })).toBe(false);
    expect(shouldRetainPresentationRun({
      reducedMotion: true,
      runDocVersion: 2,
      currentDocVersion: 2,
      runSessionId: "s-1",
      currentSessionId: "s-1",
    })).toBe(false);
    expect(shouldRetainPresentationRun({
      reducedMotion: false,
      runDocVersion: 2,
      currentDocVersion: 2,
      runSessionId: "s-old",
      currentSessionId: "s-1",
    })).toBe(false);
  });

  it("F#1 保存 A 在途且 B 已排队时不把旧稿 A 回灌成 canonical", async () => {
    const { shouldDispatchManualDocSavedForWriteResult } = await import("./WorkspacePage");
    const mutationA = pmDoc([pmParagraph("block-a", "旧稿 A")]);
    const mutationB = pmDoc([pmParagraph("block-b", "新稿 B")]);
    const canonicalWithB = workspaceReducer(initialWorkspaceState, {
      kind: "manualDocSaved",
      pmDoc: mutationB,
      version: 1,
    });
    const afterAOkFrame = workspaceReducer(canonicalWithB, {
      kind: "docWriteResult",
      data: { ok: true, clientMutationId: "mutation-a", docVersion: 2 },
    });
    const shouldDispatchA = shouldDispatchManualDocSavedForWriteResult({
      isLatestOwnMutation: true,
      writeOk: true,
      hasLastSentPmDoc: true,
      hasQueuedPmDoc: true,
    });
    const afterAResult = shouldDispatchA
      ? workspaceReducer(afterAOkFrame, {
          kind: "manualDocSaved",
          pmDoc: mutationA,
          version: 2,
        })
      : afterAOkFrame;

    expect(shouldDispatchA).toBe(false);
    expect(afterAResult.version).toBe(2);
    expect(afterAResult.doc?.pmDoc).toEqual(mutationB);
    expect(afterAResult.doc?.pmDoc).not.toEqual(mutationA);
    expect(shouldDispatchManualDocSavedForWriteResult({
      isLatestOwnMutation: true,
      writeOk: true,
      hasLastSentPmDoc: true,
      hasQueuedPmDoc: false,
    })).toBe(true);
  });

  it("进入 pendingReview 或整篇审时需要收起素材预览", async () => {
    const { shouldCloseMaterialPreviewForReview } = await import("./WorkspacePage");

    expect(shouldCloseMaterialPreviewForReview({
      contentKind: "pendingReview",
      wholeDocReview: false,
    })).toBe(true);
    expect(shouldCloseMaterialPreviewForReview({
      contentKind: "editing",
      wholeDocReview: true,
    })).toBe(true);
    expect(shouldCloseMaterialPreviewForReview({
      contentKind: "editing",
      wholeDocReview: false,
    })).toBe(false);
  });

  it("整篇审改动比例按 PM 可见字符统计代码块", async () => {
    const { computeWholeDocReviewChangeRatio } = await import("./WorkspacePage");
    const patch = reviewToolCall("code-hunk", "batch-code", "reviewing");
    if (patch.body.kind !== "docSuggestion" || patch.body.data.kind !== "suggestion") {
      throw new Error("fixture must be a docSuggestion");
    }
    patch.body.data.data.preview = {
      deleteText: "const a = 1;",
      insertText: "const a = 1;\nconst b = 2;",
    };
    patch.body.data.data.diffHunk = {
      ...patch.body.data.data.diffHunk!,
      beforeText: "const a = 1;",
      afterText: "const a = 1;\nconst b = 2;",
    };

    const ratio = computeWholeDocReviewChangeRatio({
      patches: [patch],
      baseDoc: pmDoc([pmCodeBlock("code-a", "const a = 1;")]),
      editedDoc: pmDoc([pmCodeBlock("code-a", "const a = 1;\nconst b = 2;")]),
    });

    expect(ratio).toBeGreaterThan(0);
  });

  it("提交分组默认应用全部未取消改动并丢弃已取消组", async () => {
    const { buildReviewGroupCommitSelection } = await import("./WorkspacePage");

    expect(buildReviewGroupCommitSelection([
      reviewToolCall("p-1", "batch-a", "reviewing"),
      reviewToolCall("p-2", "batch-b", "rejected"),
      reviewToolCall("p-3", "batch-c", "accepted"),
      reviewToolCall("p-4", "batch-d", "reviewing"),
      reviewToolCall("p-5", "batch-d", "rejected"),
    ])).toEqual({
      acceptReviewBatchIds: ["batch-a", "batch-c"],
      rejectReviewBatchIds: ["batch-b", "batch-d"],
    });
  });

  it("当前 hunk 拒绝命令只包含 patch id,不按 reviewBatchId 连带", async () => {
    const { buildPatchVerdictCommand } = await import("./WorkspacePage");

    expect(buildPatchVerdictCommand(
      [reviewToolCall("p-1", "batch-a", "reviewing")],
      "p-1",
      "rejected",
    )).toEqual({
      kind: "rejectPatch",
      data: { id: "p-1" },
    });
  });

  it("buildReviewOutcome 提交语义:每个 hunk 独立计算 verdict", async () => {
    const { buildReviewOutcome } = await import("./WorkspacePage");
    const outcome = buildReviewOutcome([
      reviewToolCall("p-1", "batch-a", "reviewing"),
      reviewToolCall("p-2", "batch-b", "rejected"),
      reviewToolCall("p-3", "batch-c", "accepted"),
      reviewToolCall("p-4", "batch-d1", "reviewing"),
      reviewToolCall("p-5", "batch-d2", "rejected"),
    ]);
    expect(outcome.acceptedCount).toBe(3);
    expect(outcome.rejectedCount).toBe(2);
    expect(outcome.hunks.map((h) => h.verdict)).toEqual([
      "accepted",
      "rejected",
      "accepted",
      "accepted",
      "rejected",
    ]);
    expect(outcome.hunks[0]).toMatchObject({
      beforeText: "旧句子",
      afterText: "新句子",
      // blockSummary 优先取 anchor.quote(定位正文的真实文字),而非笼统的 diffHunk.summary。
      blockSummary: "旧句子",
    });
  });

  it("buildReviewOutcome 提交语义:旧同批次任一 rejected 时整批 rejected,与后端提交一致", async () => {
    const { buildReviewOutcome } = await import("./WorkspacePage");
    const outcome = buildReviewOutcome([
      reviewToolCall("p-1", "legacy-batch", "reviewing"),
      reviewToolCall("p-2", "legacy-batch", "rejected"),
    ]);

    expect(outcome.acceptedCount).toBe(0);
    expect(outcome.rejectedCount).toBe(2);
    expect(outcome.hunks.map((h) => h.verdict)).toEqual(["rejected", "rejected"]);
  });

  it("ReviewOutcomeCard 展示同 batch 旧数据时按实际提交结果整批拒绝", async () => {
    const { buildReviewOutcome } = await import("./WorkspacePage");
    const { ReviewOutcomeCard } = await import("./components/ReviewOutcomeCard");
    const outcome = buildReviewOutcome([
      reviewToolCall("p-1", "batch-a", "reviewing"),
      reviewToolCall("p-2", "batch-a", "rejected"),
    ]);

    await render(<ReviewOutcomeCard data={outcome} />);
    const header = host!.querySelector<HTMLButtonElement>(".u-card-hd");
    expect(header).not.toBeNull();
    act(() => {
      header!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect([...host!.querySelectorAll(".wf-rvo-detail")]
      .map((item) => item.textContent)
      .filter((text): text is string => Boolean(text))
      .every((text) => text.includes("已拒绝"))).toBe(true);
  });

  // 旧断言(forceAllRejected 把 accepted 也全计 rejected)正是 e2e-loop-0704 P1 的错误语义:
  // 半采纳后"放弃全部"把已采纳处也计成拒绝,反馈卡误报"放弃本轮全部 N 处"。
  // 正确口径:放弃只作用于未表态的候选,已采纳的如实计 accepted。
  it("buildReviewOutcome rejectUndecided:未表态计 rejected,已采纳如实计 accepted", async () => {
    const { buildReviewOutcome } = await import("./WorkspacePage");
    const outcome = buildReviewOutcome(
      [
        reviewToolCall("p-1", "batch-a", "reviewing"),
        reviewToolCall("p-2", "batch-b", "accepted"),
      ],
      { rejectUndecided: true },
    );
    expect(outcome.acceptedCount).toBe(1);
    expect(outcome.rejectedCount).toBe(1);
    expect(outcome.hunks.map((h) => h.verdict)).toEqual(["rejected", "accepted"]);
  });

  it("buildReviewOutcome rejectUndecided:旧同批次 accepted+reviewing 按整批 rejected,避免误报保留", async () => {
    const { buildReviewOutcome } = await import("./WorkspacePage");
    const outcome = buildReviewOutcome(
      [
        reviewToolCall("p-1", "legacy-batch", "accepted"),
        reviewToolCall("p-2", "legacy-batch", "reviewing"),
      ],
      { rejectUndecided: true },
    );
    expect(outcome.acceptedCount).toBe(0);
    expect(outcome.rejectedCount).toBe(2);
    expect(outcome.hunks.map((h) => h.verdict)).toEqual(["rejected", "rejected"]);
  });

  it("buildReviewOutcome rejectUndecided:全部未表态时仍全计 rejected(纯放弃场景)", async () => {
    const { buildReviewOutcome } = await import("./WorkspacePage");
    const outcome = buildReviewOutcome(
      [
        reviewToolCall("p-1", "batch-a", "reviewing"),
        reviewToolCall("p-2", "batch-b", "reviewing"),
      ],
      { rejectUndecided: true },
    );
    expect(outcome.acceptedCount).toBe(0);
    expect(outcome.rejectedCount).toBe(2);
    expect(outcome.hunks.every((h) => h.verdict === "rejected")).toBe(true);
  });

  it("buildReviewOutcome 优先取 diffHunk.beforeText/afterText,缺失回落 preview", async () => {
    const { buildReviewOutcome } = await import("./WorkspacePage");
    const withHunkText = reviewToolCall("p-1", "batch-a", "rejected");
    if (withHunkText.body.kind === "docSuggestion" && withHunkText.body.data.kind === "suggestion") {
      withHunkText.body.data.data.diffHunk = {
        ...withHunkText.body.data.data.diffHunk!,
        beforeText: "hunk旧",
        afterText: "hunk新",
      };
    }
    const onlyPreview = reviewToolCall("p-2", "batch-b", "rejected");
    if (onlyPreview.body.kind === "docSuggestion" && onlyPreview.body.data.kind === "suggestion") {
      onlyPreview.body.data.data.diffHunk = undefined;
      onlyPreview.body.data.data.preview = { deleteText: "preview旧", insertText: "preview新" };
    }
    const outcome = buildReviewOutcome([withHunkText, onlyPreview]);
    expect(outcome.hunks[0]).toMatchObject({ beforeText: "hunk旧", afterText: "hunk新" });
    expect(outcome.hunks[1]).toMatchObject({ beforeText: "preview旧", afterText: "preview新" });
  });

  it("sendReviewOutcomeFollowup:全量采纳(rejectedCount=0)不发命令", async () => {
    const { sendReviewOutcomeFollowup } = await import("./WorkspacePage");
    const sendCommand = vi.fn().mockResolvedValue(undefined);
    sendReviewOutcomeFollowup({ sendCommand }, "s-1", {
      acceptedCount: 3,
      rejectedCount: 0,
      hunks: [],
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("sendReviewOutcomeFollowup:有拒绝时发 submitReviewOutcome 命令", async () => {
    const { sendReviewOutcomeFollowup } = await import("./WorkspacePage");
    const sendCommand = vi.fn().mockResolvedValue(undefined);
    const outcome = {
      acceptedCount: 1,
      rejectedCount: 1,
      hunks: [
        { verdict: "accepted" as const, blockSummary: "a", beforeText: "x", afterText: "y" },
        { verdict: "rejected" as const, blockSummary: "b", beforeText: "m", afterText: "n" },
      ],
    };
    sendReviewOutcomeFollowup({ sendCommand }, "s-1", outcome);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith({
      kind: "submitReviewOutcome",
      data: { sessionId: "s-1", outcome },
    });
  });

  // e2e-loop-0704 P1 回归:旧实现把已保留(accepted)的 batch 也塞进 reject 列表,
  // server 侧 commitReviewGroups 会强制覆盖 verdict → 已采纳改动被回滚丢失。
  // 正确语义:"放弃全部剩余"只拒未采纳的批次,已采纳的批次进 accept 列表保留提交。
  it("撤销全部只拒未采纳 batch,已采纳的 batch 保留提交", async () => {
    const { buildReviewGroupRejectSelection } = await import("./WorkspacePage");
    const doneLeakedCandidate = {
      ...reviewToolCall("p-5", "batch-done", "reviewing"),
      status: { kind: "done" } as const,
    };

    expect(buildReviewGroupRejectSelection([
      reviewToolCall("p-1", "batch-a", "reviewing"),
      reviewToolCall("p-2", "batch-b", "accepted"),
      reviewToolCall("p-3", "batch-c", "rejected"),
      reviewToolCall("p-4", "batch-b", "accepted"),
      doneLeakedCandidate,
    ])).toEqual({
      acceptReviewBatchIds: ["batch-b"],
      rejectReviewBatchIds: ["batch-a", "batch-c", "batch-done"],
    });
  });

  it("撤销全部时旧同批次内有拒有采仍按拒处理,避免旧数据误保留", async () => {
    const { buildReviewGroupRejectSelection } = await import("./WorkspacePage");

    // 旧 atomic 批内一处 accepted 一处 rejected:commitReviewGroups 的兼容入口仍只能按
    // reviewBatchId 表达,因此整批进 reject,避免把用户点过"取消"的内容又写回去。
    expect(buildReviewGroupRejectSelection([
      reviewToolCall("p-1", "batch-mix", "accepted"),
      reviewToolCall("p-2", "batch-mix", "rejected"),
      reviewToolCall("p-3", "batch-b", "reviewing"),
    ])).toEqual({
      acceptReviewBatchIds: [],
      rejectReviewBatchIds: ["batch-mix", "batch-b"],
    });
  });

  it("撤销全部时旧同批次内有采有未审仍按拒处理,避免未审核 hunk 被误提交", async () => {
    const { buildReviewGroupRejectSelection } = await import("./WorkspacePage");

    // 旧 atomic 批内一处 accepted 一处 reviewing:前端 commitReviewGroups 只能传 batch,
    // 不能表达"保留已采纳 id、放弃未审 id",因此整批走 reject 比误保留未审 hunk 更安全。
    expect(buildReviewGroupRejectSelection([
      reviewToolCall("p-1", "legacy-batch", "accepted"),
      reviewToolCall("p-2", "legacy-batch", "reviewing"),
      reviewToolCall("p-3", "batch-new", "accepted"),
    ])).toEqual({
      acceptReviewBatchIds: ["batch-new"],
      rejectReviewBatchIds: ["legacy-batch"],
    });
  });

  it("R38-c4 放弃 done 态整篇候选时仍发送 reject batch 并用服务端旧文快照回滚", async () => {
    const { buildReviewGroupRejectSelection } = await import("./WorkspacePage");
    const basePmDoc = pmDoc([pmParagraph("base-p", "旧文保留原始叙述")]);
    const candidatePmDoc = pmDoc([
      pmParagraph("base-p", "旧文保留原始叙述"),
      pmHeading("family-title", "向明海一家"),
      pmParagraph("family-p", "郑国秀和郑国强姐弟的移民家庭故事"),
    ]);
    const hunk: DiffHunk = {
      hunkId: "family-hunk",
      reviewBatchId: "batch-family",
      groupMode: "atomic",
      op: "insert",
      blockPath: [1],
      anchor: { blockId: "base-p", gravity: "after" },
      before: null,
      after: [
        pmHeading("family-title", "向明海一家"),
        pmParagraph("family-p", "郑国秀和郑国强姐弟的移民家庭故事"),
      ] as never,
      summary: "增加移民家庭故事细节",
      afterText: "向明海一家\n郑国秀和郑国强姐弟的移民家庭故事",
    };
    const suggestion = blockSuggestion("family-hunk", hunk);
    const doneToolCall: ToolCallSpec = {
      ...reviewToolCall("family-hunk", "batch-family", "reviewing"),
      status: { kind: "done" },
      body: {
        kind: "docSuggestion",
        data: {
          kind: "suggestion",
          data: suggestion,
        },
      },
    };

    const leakedCandidateActions: WorkspaceAction[] = [
      {
        kind: "docDiffReady",
        data: {
          baseVersion: 1,
          suggestions: [suggestion],
          previewDoc: basePmDoc,
          editedDoc: candidatePmDoc,
        },
      } as const,
      {
        kind: "docStateChanged",
        data: { state: { kind: "pendingReview" }, activeOverlay: null, agentBusy: false },
      } as const,
      {
        kind: "manualDocSaved",
        pmDoc: candidatePmDoc,
        version: 2,
      } as const,
      {
        kind: "toolCallUpdated",
        data: {
          messageId: "m-review",
          toolCallId: "family-hunk",
          spec: doneToolCall,
        },
      },
    ];
    const leakedCandidateState = leakedCandidateActions.reduce(workspaceReducer, initialWorkspaceState);

    expect(pmPlainText(leakedCandidateState.doc?.pmDoc)).toContain("向明海一家");
    const currentPatches = selectPatches(leakedCandidateState);
    expect(currentPatches.map((patch) => patch.status.kind)).toEqual(["reviewing"]);
    expect(buildReviewGroupRejectSelection(currentPatches)).toEqual({
      acceptReviewBatchIds: [],
      rejectReviewBatchIds: ["batch-family"],
    });

    const afterRejectFrameActions: WorkspaceAction[] = [
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(basePmDoc, 1) },
      },
      {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
      },
    ];
    const afterRejectFrames = afterRejectFrameActions.reduce(workspaceReducer, leakedCandidateState);

    const revertedText = pmPlainText(afterRejectFrames.doc?.pmDoc);
    expect(revertedText).toContain("旧文保留原始叙述");
    expect(revertedText).not.toContain("向明海一家");
    expect(revertedText).not.toContain("郑国秀和郑国强");
    expect(afterRejectFrames.docState).toEqual({ kind: "editing" });
    expect(afterRejectFrames.docDiff).toBeNull();
  });

  it("撤销全部需要二次确认后才丢弃整轮", async () => {
    const { RightPane } = await import("./WorkspacePage");
    const onRejectAll = vi.fn();
    await render(
      <section id="view-workspace">
        <RightPane {...rightPaneProps({ onRejectAll })} />
      </section>,
    );

    const rejectAll = [...host!.querySelectorAll("button")].find(
      (button) => button.textContent === "放弃全部",
    );
    expect(rejectAll).toBeTruthy();

    act(() => {
      rejectAll!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRejectAll).not.toHaveBeenCalled();
    expect(host?.textContent).toContain("放弃后，本轮剩余修改都不会保留");
    const confirm = [...host!.querySelectorAll("button")].find(
      (button) => button.textContent === "确认放弃全部",
    );
    expect(confirm).toBeTruthy();

    act(() => {
      confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRejectAll).toHaveBeenCalledTimes(1);
  });

  it("C11 放弃全部确认后不等待 commit 返回就解锁输入", async () => {
    const stream = await renderWorkspaceWithReview([
      textReviewToolCall("p-1", "batch-a", 0),
    ]);
    const pendingCommit = mockPendingCommit(stream);

    expect(getChatEditor().getAttribute("contenteditable")).toBe("false");

    await clickButton("放弃全部");
    await clickButton("确认放弃全部");

    expect(stream.commitReviewGroups).toHaveBeenCalledTimes(1);
    expect(getChatEditor().getAttribute("contenteditable")).toBe("true");

    await act(async () => {
      pendingCommit.resolve([docStateFrame("editing")]);
      await pendingCommit.promise;
    });
  });

  it("C11 放弃后收到 stale pendingReview 回帧时仍由 fallback 解锁", async () => {
    const stream = await renderWorkspaceWithReview([
      textReviewToolCall("p-1", "batch-a", 0),
    ]);
    const pendingCommit = mockPendingCommit(stream);

    await clickButton("放弃全部");
    await clickButton("确认放弃全部");
    expect(getChatEditor().getAttribute("contenteditable")).toBe("true");

    await emitFrames(stream, [docStateFrame("pendingReview")]);
    expect(getChatEditor().getAttribute("contenteditable")).toBe("false");

    await act(async () => {
      pendingCommit.resolve([docStateFrame("pendingReview")]);
      await pendingCommit.promise;
    });
    await flushMicrotasks();

    expect(getChatEditor().getAttribute("contenteditable")).toBe("true");
  });

  it("提交后 commit 响应缺状态转移帧(stale pendingReview)时由 fallback 解锁输入", async () => {
    // 回归(review-loop-0702 lane-B round-1):handleAcceptAll / handleRejectAll 均有
    // reviewCommitFramesLeavePendingReview 兜底,唯独 handleCommit(手动"提交 ↵"与逐条
    // 处理完的 auto-commit 汇入路径)没有——commit 响应缺状态转移帧时输入永久锁死。
    const stream = await renderWorkspaceWithReview([
      textReviewToolCall("p-1", "batch-a", 0),
    ]);
    const pendingCommit = mockPendingCommit(stream);

    expect(getChatEditor().getAttribute("contenteditable")).toBe("false");
    await clickButton("提交 ↵");
    expect(stream.commitReviewGroups).toHaveBeenCalledTimes(1);

    await act(async () => {
      // 响应里只有仍处 pendingReview 的帧,没有 documentSnapshotWritten / docCommitted /
      // 离开 pendingReview 的 docStateChanged → 必须触发兜底解锁
      pendingCommit.resolve([docStateFrame("pendingReview")]);
      await pendingCommit.promise;
    });
    await flushMicrotasks();

    expect(getChatEditor().getAttribute("contenteditable")).toBe("true");
  });

  it("C11 放弃后立刻追问时 sendMessage 等关闭审阅完成后再发送", async () => {
    const stream = await renderWorkspaceWithReview([
      textReviewToolCall("p-1", "batch-a", 0),
    ]);
    const pendingCommit = mockPendingCommit(stream);

    await clickButton("放弃全部");
    await clickButton("确认放弃全部");

    const editor = getChatEditor();
    bindInnerText(editor);
    await act(async () => {
      editor.innerText = "继续追问";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await clickButton("发送 →");
    expect(sendMessageCommands(stream)).toHaveLength(0);

    await act(async () => {
      pendingCommit.resolve([docStateFrame("editing")]);
      await pendingCommit.promise;
    });
    await flushMicrotasks(5);

    const sends = sendMessageCommands(stream);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      kind: "sendMessage",
      data: { sessionId: "s-1", text: "继续追问" },
    });
  });

  it("批注 reviewing 时发送不拦截、不确认且发送后保留", async () => {
    const stream = await renderWorkspaceWithAnnotations();
    const editor = getChatEditor();
    bindInnerText(editor);
    await act(async () => {
      editor.innerText = "继续写正文";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await clickButton("发送 →");
    await flushMicrotasks(5);
    expect(host?.querySelector('[data-wf="GlobalConfirm"]')).toBeNull();
    expect(sendMessageCommands(stream)).toHaveLength(1);
    expect(stream.ignoreAnnotationGroups).not.toHaveBeenCalled();
    expect(host?.querySelector('[data-annotation-group="annotation-1"]')).not.toBeNull();
  });

  it("accepted 批注发送后同样保留", async () => {
    const stream = await renderWorkspaceWithAnnotations("accepted");
    const editor = getChatEditor();
    bindInnerText(editor);
    await act(async () => {
      editor.innerText = "按已接受批注继续修改";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await clickButton("发送 →");
    await flushMicrotasks(5);
    expect(host?.querySelector('[data-wf="GlobalConfirm"]')).toBeNull();
    expect(sendMessageCommands(stream)).toHaveLength(1);
    expect(stream.ignoreAnnotationGroups).not.toHaveBeenCalled();
    expect(host?.querySelector('[data-annotation-group="annotation-1"]')).not.toBeNull();
  });

  it("docCommitted 不再整体清空批注", async () => {
    const stream = await renderWorkspaceWithAnnotations();

    await emitFrames(stream, [{ kind: "docCommitted", data: { sessionId: "s-1", version: 2 } }]);
    await flushMicrotasks(3);

    expect(stream.ignoreAnnotationGroups).not.toHaveBeenCalled();
    expect(host?.querySelector('[data-annotation-group="annotation-1"]')).not.toBeNull();
  });

  it("切衍生 tab 只隐藏批注，切回主文档后 reviewing 批注仍在且不发 ignore", async () => {
    const derivative = {
      docId: "deriv-annotation-tab",
      dtype: "gzh",
      templateId: "gzh-opinion",
      templateName: "深度观点文",
      privatePrompt: "",
      sourceVersion: 1,
      currentSourceVersion: 1,
      generatedAt: "2026-07-15T00:00:00.000Z",
      stale: false,
    };
    const stream = await renderWorkspaceWithAnnotations("reviewing", (nextStream) => {
      nextStream.listDerivatives.mockResolvedValue([derivative]);
      nextStream.getDerivativeDoc.mockResolvedValue({
        meta: derivative,
        docPm: JSON.stringify(pmDoc([pmParagraph("deriv-p-1", "衍生正文")])),
        docVersion: 1,
        title: "",
      });
    });
    await flushMicrotasks(5);

    const derivativeTab = Array.from(host!.querySelectorAll<HTMLElement>('[role="tab"]')).find((tab) => tab.textContent?.includes("公众号文章"));
    expect(derivativeTab).toBeTruthy();
    await clickElement(derivativeTab!);
    expect(host?.querySelector('[data-annotation-group="annotation-1"]')).toBeNull();
    expect(stream.ignoreAnnotationGroups).not.toHaveBeenCalled();

    const mainTab = Array.from(host!.querySelectorAll<HTMLElement>('[role="tab"]')).find((tab) => tab.textContent?.includes("测试批注"));
    expect(mainTab).toBeTruthy();
    await clickElement(mainTab!);
    expect(host?.querySelector('[data-annotation-group="annotation-1"]')).not.toBeNull();
    expect(stream.ignoreAnnotationGroups).not.toHaveBeenCalled();
  });

  it("批注意见编辑后确认生成短 chip，发送载荷展开完整指令", async () => {
    const stream = await renderWorkspaceWithAnnotations();
    const editor = getChatEditor();
    bindInnerText(editor);
    await act(async () => {
      editor.innerText = "帮我把这段润色一下";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });

    vi.useFakeTimers();
    await act(async () => {
      host!.querySelector<HTMLElement>('[data-annotation-group="annotation-1"]')!
        .dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(80);
    });
    const suggestion = host!.querySelector<HTMLTextAreaElement>(".ahc-suggestion textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        suggestion,
        "改为五月发布",
      );
      suggestion.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickButton("确认修改");

    const chip = editor.querySelector<HTMLElement>('.chat-chip[data-kind="annotation"]');
    expect(chip?.getAttribute("contenteditable")).toBe("false");
    expect(chip?.querySelector(".c-label")?.textContent).toBe("批注·事实有误");
    expect(chip?.dataset.text).toBe(
      "按批注修改:「甲组」——改为五月发布（批注:事实有误；原因:时间与资料不一致）\n",
    );
    expect(editor.textContent).not.toContain("时间与资料不一致");

    vi.useRealTimers();
    await clickButton("发送 →");
    await flushMicrotasks(5);
    const send = sendMessageCommands(stream)[0];
    expect(send?.kind).toBe("sendMessage");
    if (send?.kind !== "sendMessage") throw new Error("sendMessage not found");
    expect(send.data.text).toContain("帮我把这段润色一下");
    expect(send.data.text).toContain("改为五月发布");
    expect(send.data.text).toContain("原因:时间与资料不一致");
    expect(send.data.richText).toContain("{{chip:0}}");
    expect(send.data.chips).toEqual([expect.objectContaining({
      kind: { kind: "text" },
      label: "批注·事实有误",
      text: "按批注修改:「甲组」——改为五月发布（批注:事实有误；原因:时间与资料不一致）\n",
    })]);
  });

  it("e2e-loop-0704 P1 回归:2 处候选采纳第 1 处后放弃全部,已采纳 batch 保留提交且反馈计数如实", async () => {
    // 修复前:handleRejectAll 把 batch-a(已采纳)也塞进 rejectReviewBatchIds,
    // server 强制覆盖 verdict → 已采纳改动回滚丢失;outcome 全计 rejected → 卡片误报全拒。
    const stream = await renderWorkspaceWithReview([
      textReviewToolCall("p-1", "batch-a", 0),
      textReviewToolCall("p-2", "batch-b", 1),
    ]);
    const pendingCommit = mockPendingCommit(stream);

    // 服务端回帧确认第 1 处已 accepted,覆盖半采纳后再放弃剩余的状态机。
    await emitFrames(stream, [toolCallUpdatedFrame(reviewToolCall(
      "p-1",
      "batch-a",
      "accepted",
      { blockId: "block-p-1", before: "旧句子1", after: "新句子1", index: 0, groupMode: "independent" },
    ))]);

    // 放弃全部:只拒未采纳的 batch-b,已采纳的 batch-a 进 accept 列表保留提交
    await clickButton("放弃全部");
    await clickButton("确认放弃全部");

    expect(stream.commitReviewGroups).toHaveBeenCalledTimes(1);
    expect(stream.commitReviewGroups).toHaveBeenCalledWith("s-1", {
      acceptReviewBatchIds: ["batch-a"],
      rejectReviewBatchIds: ["batch-b"],
    });

    // commit 返回后回流的审核结果:采纳 1 处 · 拒绝 1 处,而不是全拒
    await act(async () => {
      pendingCommit.resolve([docStateFrame("editing")]);
      await pendingCommit.promise;
    });
    await flushMicrotasks(5);

    const outcomeCommands = stream.sendCommand.mock.calls
      .map(([command]) => command as Command)
      .filter((command): command is Extract<Command, { kind: "submitReviewOutcome" }> =>
        command.kind === "submitReviewOutcome");
    expect(outcomeCommands).toHaveLength(1);
    const outcome = outcomeCommands[0]!.data.outcome;
    expect(outcome.acceptedCount).toBe(1);
    expect(outcome.rejectedCount).toBe(1);
    expect(outcome.hunks.map((h) => h.verdict)).toEqual(["accepted", "rejected"]);
  });

  // e2e-loop-0704 R1/R12 回归:审核回流追问(内联 askUser 问卷)提交后弹层滞留,
  // 输入/导出持续被禁,需手动点"关闭"才恢复。修复=内联提交走 BigPlan 同源乐观收口
  // (置 done → reducer 清 askUser overlay),不等服务端 resume 回帧。
  it("e2e-loop-0704 R12 回归:内联问卷提交后立即收起弹层并恢复输入/导出", async () => {
    const stream = await renderWorkspaceWithInlineAskUser();

    // 修复前形态:弹层在场,输入与导出都被禁
    expect(host?.querySelector('[data-wf="AskUserOverlay"]')).not.toBeNull();
    expect(getChatEditor().getAttribute("contenteditable")).toBe("false");
    expect(exportButton().getAttribute("aria-disabled")).toBe("true");
    // 导出禁用文案按原因分流:问卷态直说"完成问卷",不再是笼统的双原因混排
    expect(exportButton().getAttribute("title")).toBe("请先完成问卷，再导出");

    await act(async () => {
      const radio = host!.querySelector<HTMLInputElement>(
        '.askuser-overlay input[type="radio"]',
      );
      expect(radio).not.toBeNull();
      radio!.click();
    });
    await clickButton("提交");
    await flushMicrotasks(5);

    // resumeAskUser 已发出
    const resumes = stream.sendCommand.mock.calls
      .map(([command]) => command as Command)
      .filter((command): command is Extract<Command, { kind: "resumeAskUser" }> =>
        command.kind === "resumeAskUser");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.data.toolCallId).toBe("ask-1");

    // 核心断言:提交后不需要再点"关闭"——弹层立即收起,输入/导出恢复可用
    expect(host?.querySelector('[data-wf="AskUserOverlay"]')).toBeNull();
    expect(getChatEditor().getAttribute("contenteditable")).toBe("true");
    expect(exportButton().getAttribute("aria-disabled")).toBeNull();
  });

  it("e2e-loop-0704 R12 回归:内联问卷提交失败时回滚,弹层与锁态恢复可重试", async () => {
    const stream = await renderWorkspaceWithInlineAskUser();
    // 模拟真实网络失败时序:拒绝发生在乐观态渲染落地之后,而非同步微任务里。
    let rejectSend: (error: unknown) => void = () => undefined;
    stream.sendCommand.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectSend = reject;
      }),
    );

    await act(async () => {
      host!
        .querySelector<HTMLInputElement>('.askuser-overlay input[type="radio"]')!
        .click();
    });
    await clickButton("提交");
    await flushMicrotasks(5);
    // 乐观收口先生效:弹层已收起
    expect(host?.querySelector('[data-wf="AskUserOverlay"]')).toBeNull();

    await act(async () => {
      rejectSend(new Error("network down"));
    });
    await flushMicrotasks(5);

    // 发送失败 → restoreAskUser 回滚:弹层回来,输入仍锁,可重新提交
    expect(host?.querySelector('[data-wf="AskUserOverlay"]')).not.toBeNull();
    expect(getChatEditor().getAttribute("contenteditable")).toBe("false");
  });

  it("#25 回归:编辑锁提示 portal 到 body 顶层 fixed,不再留在 .ws-right 滚动流内", async () => {
    const { WorkspacePage } = await import("./WorkspacePage");
    await render(<WorkspacePage />);
    const stream = latestServerStream();

    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "编辑锁提示" } },
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(pmDoc([pmParagraph("p-lock", "正文内容")]), 1) },
      },
      {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: true },
      },
    ]);

    const portal = Array.from(document.body.children).find((child) =>
      child.classList.contains("ws-edit-lock"),
    ) as HTMLElement | undefined;
    expect(portal).not.toBeUndefined();
    expect(portal?.parentElement).toBe(document.body);
    expect(portal?.textContent).toContain("请等待青简完成编辑后再做修改");
    expect(host?.querySelector(".ws-right .ws-edit-lock")).toBeNull();

    const inkSkinCss = readFileSync(
      resolve(process.cwd(), "src/pages/workspace/workspace-ink-skin.css"),
      "utf8",
    );
    expect(inkSkinCss).toMatch(/body > \.ws-edit-lock\s*\{[^}]*position:\s*fixed/s);
    // 水平居中于文档纸(--doc-left/--doc-right 中点 + translateX(-50%)),不再钉视口右下角
    expect(inkSkinCss).toMatch(/body > \.ws-edit-lock\s*\{[^}]*left:\s*calc\(\(var\(--doc-left, 0px\) \+ var\(--doc-right, 100vw\)\) \/ 2\)/s);
    expect(inkSkinCss).toMatch(/body > \.ws-edit-lock\s*\{[^}]*justify-content:\s*center/s);
    expect(inkSkinCss).toMatch(/body > \.ws-edit-lock\s*\{[^}]*bottom:\s*max\(28px, env\(safe-area-inset-bottom\)\)/s);
  });

  it("空文档且无衍生稿时隐藏整条 Tab 带，存在衍生稿后恢复", async () => {
    const { WorkspacePage } = await import("./WorkspacePage");
    await render(<WorkspacePage />);
    const stream = latestServerStream();

    expect(host?.querySelector('[role="tablist"]')).toBeNull();
    expect(host?.textContent).not.toContain("主文档");
    expect(host?.querySelector('[aria-label="新建稿件"]')).toBeNull();

    stream.listDerivatives.mockResolvedValueOnce([{
      docId: "deriv-empty-main",
      dtype: "gzh",
      templateId: "gzh-deep",
      templateName: "深度长文",
      privatePrompt: "",
      sourceVersion: null,
      currentSourceVersion: 0,
      generatedAt: null,
      stale: false,
    }]);
    await emitFrames(stream, [{ kind: "sessionMeta", data: { sessionId: "s-with-derivative", title: "主文档" } }]);
    await flushMicrotasks(5);

    expect(host?.querySelector('[role="tablist"]')).not.toBeNull();
    expect(host?.textContent).toContain("主文档");
    expect(host?.textContent).toContain("公众号文章");
  });

  it("#29 回归:整篇改写 busy 发光层独立覆盖编辑视口,不被审阅条或编辑锁条接管", async () => {
    const { WorkspacePage } = await import("./WorkspacePage");
    await render(<WorkspacePage />);
    const stream = latestServerStream();
    const baseDoc = pmDoc([pmParagraph("rewrite-base", "旧文")]);
    const editedDoc = pmDoc([
      pmHeading("rewrite-title", "新版标题"),
      pmParagraph("rewrite-p-1", "这是完全改写后的第一段,用于触发整篇审阅。"),
      pmParagraph("rewrite-p-2", "这是完全改写后的第二段,长度明显超过旧文。"),
    ]);
    const spec = reviewToolCall("rewrite-hunk", "batch-rewrite", "reviewing", {
      blockId: "rewrite-base",
      before: "旧文",
      after: "新版标题\n这是完全改写后的第一段,用于触发整篇审阅。\n这是完全改写后的第二段,长度明显超过旧文。",
    });
    const suggestion = docSuggestionFromToolCall(spec);

    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "整篇改写 busy 发光" } },
      { kind: "documentSnapshotWritten", data: { doc: wireSnapshotFromPmDoc(baseDoc, 1) } },
      {
        kind: "docDiffReady",
        data: {
          baseVersion: 1,
          suggestions: [suggestion],
          previewDoc: baseDoc,
          editedDoc,
        },
      },
      {
        kind: "docStateChanged",
        data: { state: { kind: "pendingReview" }, activeOverlay: null, agentBusy: true },
      },
    ]);

    const wsRight = host!.querySelector<HTMLElement>(".ws-right");
    const glow = host!.querySelector<HTMLElement>('[data-wf="WorkspaceEditorGlow"]');
    const reviewNav = host!.querySelector<HTMLElement>('[data-wf="WholeDocReviewNav"]');
    const paperSurface = host!.querySelector<HTMLElement>('[data-wf="WorkspacePaperSurface"]');
    const editLock = Array.from(document.body.children).find((child) =>
      child.classList.contains("ws-edit-lock"),
    ) as HTMLElement | undefined;

    expect(document.body.dataset.tool).toBe("agentBusy");
    expect(document.body.dataset.content).toBe("pendingReview");
    expect(wsRight).not.toBeNull();
    expect(glow).not.toBeNull();
    expect(reviewNav).not.toBeNull();
    expect(paperSurface).not.toBeNull();
    expect(editLock).not.toBeUndefined();
    expect(glow!.parentElement).toBe(paperSurface);
    expect(wsRight!.firstElementChild).not.toBe(glow);
    expect(paperSurface!.contains(glow)).toBe(true);
    expect(reviewNav!.contains(glow)).toBe(false);
    expect(editLock!.contains(glow)).toBe(false);
    expect(host!.querySelector(".ws-paper-surface > .ws-editor-glow")).toBe(glow);
    expect(host!.querySelector(".patch-nav .ws-editor-glow")).toBeNull();

    const workspace = host!.querySelector<HTMLElement>("#view-workspace")!;
    const wsBody = host!.querySelector<HTMLElement>(".ws-body")!;
    const rect = (left: number): DOMRect => ({
      left,
      right: left + 800,
      top: 52,
      bottom: 652,
      x: left,
      y: 52,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    }) as DOMRect;
    wsRight!.getBoundingClientRect = () => rect(124);
    act(() => {
      wsBody.dispatchEvent(new Event("scroll"));
    });
    expect(workspace.style.getPropertyValue("--doc-left")).toBe("124px");
    expect(workspace.style.getPropertyValue("--doc-right")).toBe("924px");

    wsRight!.getBoundingClientRect = () => rect(-220);
    act(() => {
      wsBody.dispatchEvent(new Event("scroll"));
    });
    expect(workspace.style.getPropertyValue("--doc-left")).toBe("-220px");
    expect(workspace.style.getPropertyValue("--doc-right")).toBe("580px");
  });

  it("e2e-loop-0704 R15 回归:#/new 携带的首条消息在建会话完成前就渲染乐观气泡(消除首发空窗)", async () => {
    // R15 形态:新建页 Ctrl+Enter 跳进工作区后,建会话/传文件在途的头 1-2 秒工作区
    // 完全空白、用户消息无影,自动化用例把这个空窗当成"首提丢失需重输"(服务端实锤消息
    // 已在跑)。修法:乐观气泡在任何 await 之前先落地。
    sessionStorage.setItem(
      "qingagent:pending-message",
      "请写一篇短篇小说，题目《雨夜的最后一班公交》，约2000字。",
    );
    let resolveStart: ((sessionId: string) => void) | null = null;
    serverStreamMock.startSessionImpl = () =>
      new Promise<string>((resolve) => {
        resolveStart = resolve;
      });
    try {
      const { WorkspacePage } = await import("./WorkspacePage");
      await render(<WorkspacePage />);
      const stream = latestServerStream();

      // 建会话尚未完成(promise 挂起):用户消息气泡必须已在场,且命令尚未发出。
      expect(host?.textContent).toContain("雨夜的最后一班公交");
      expect(sendMessageCommands(stream)).toHaveLength(0);

      // 会话就绪后,同一条消息按原文发出(气泡与服务端 user 帧靠 clientMessageId 去重)。
      await act(async () => {
        resolveStart?.("s-9");
      });
      await flushMicrotasks(5);
      const sends = sendMessageCommands(stream);
      expect(sends).toHaveLength(1);
      const send = sends[0] as Extract<Command, { kind: "sendMessage" }>;
      expect(send.data.text).toContain("雨夜的最后一班公交");
      expect(send.data.sessionId).toBe("s-9");
      expect(send.data.clientMessageId).toBeTruthy();
    } finally {
      serverStreamMock.startSessionImpl = null;
    }
  });

  it("流错误帧渲染为底部常驻 error toast,含动作且不再渲染旧 banner", async () => {
    const { WorkspacePage } = await import("./WorkspacePage");
    await render(<WorkspacePage />);
    const stream = latestServerStream();

    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "测试流错误" } },
      {
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: {
            streamId: "s-main",
            reason: "模型余额或调用额度不足，请检查模型设置或账户余额。",
            retriable: false,
            statusCode: 402,
            category: "quota",
            userMessage: "模型余额或调用额度不足，请检查模型设置或账户余额。",
            action: "check_balance",
          },
        },
      },
    ]);

    const toast = host!.querySelector<HTMLElement>('[data-wf="GlobalToast"][data-toast-key="workspace-stream-error"]');
    expect(toast).not.toBeNull();
    expect(toast!.className).toContain("qa-toast");
    expect(toast!.className).toContain("sticky");
    expect(toast!.className).toContain("error");
    expect(toast!.getAttribute("role")).toBe("alert");
    expect(toast!.textContent).toContain("余额/配额不足");
    expect(toast!.textContent).toContain("检查模型设置/余额");
    expect(toast!.querySelectorAll(".qa-toast-act")).toHaveLength(1);
    expect(host!.querySelector(".stream-error-banner")).toBeNull();
  });

  it("重复流错误帧不刷屏,关闭后清理当前错误且不重现旧 banner", async () => {
    const { WorkspacePage } = await import("./WorkspacePage");
    await render(<WorkspacePage />);
    const stream = latestServerStream();
    const failedFrame = {
      kind: "stream" as const,
      data: {
        kind: "draftingFailed" as const,
        data: {
          streamId: "s-main",
          reason: "timeout",
          retriable: true,
          action: "retry" as const,
        },
      },
    };

    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "测试流错误" } },
      failedFrame,
      failedFrame,
      failedFrame,
    ]);

    expect(host!.querySelectorAll('[data-toast-key="workspace-stream-error"]')).toHaveLength(1);
    expect(host!.querySelectorAll(".qa-toast")).toHaveLength(1);
    expect(host!.querySelector(".stream-error-banner")).toBeNull();

    await clickElement(host!.querySelector<HTMLButtonElement>(".qa-toast-x")!);

    expect(host!.querySelector('[data-toast-key="workspace-stream-error"]')).toBeNull();
    expect(host!.querySelector(".stream-error-banner")).toBeNull();
  });

  it("cancelled 流错误是用户主动停止,走瞬时 warn status", async () => {
    const { WorkspacePage } = await import("./WorkspacePage");
    await render(<WorkspacePage />);
    const stream = latestServerStream();

    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "测试取消" } },
      {
        kind: "stream",
        data: {
          kind: "end",
          data: { streamId: "s-main", reason: { kind: "cancelled" } },
        },
      },
    ]);

    const toast = host!.querySelector<HTMLElement>('[data-toast-key="workspace-stream-error"]');
    expect(toast).not.toBeNull();
    expect(toast!.className).toContain("warn");
    expect(toast!.className).not.toContain("sticky");
    expect(toast!.getAttribute("role")).toBe("status");
    expect(toast!.querySelector(".qa-toast-x")).toBeNull();
    expect(host!.querySelector(".stream-error-banner")).toBeNull();
  });

  it("移除上传素材使用产品确认弹窗，确认后发送 removeMaterial", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => true);
    const stream = await renderWorkspaceWithUploadedMaterial();

    await clickElement(linkedFilesBar());
    const deleteButton = buttonByTextIn(rowByText("合同.pdf"), "删除");
    expect(deleteButton.disabled).toBe(false);
    await clickElement(deleteButton);

    const modal = removeUploadedCopyDialog();
    expect(modal.textContent).toContain("移除「合同.pdf」？");
    expect(modal.textContent).toContain("移除已上传到项目里的副本");
    expect(modal.textContent).toContain("原始文件不受影响");
    expect(modal.textContent).not.toContain("将同时删除原始文件");
    expect(confirmSpy).not.toHaveBeenCalled();

    await clickElement(buttonByTextIn(modal, "移除副本"));

    expect(removeMaterialCommands(stream)).toEqual([
      {
        kind: "removeMaterial",
        data: { sessionId: "s-1", materialId: "mat-1" },
      },
    ]);
  });

  it("移除上传素材确认弹窗取消时不发送 removeMaterial", async () => {
    const stream = await renderWorkspaceWithUploadedMaterial();

    await clickElement(linkedFilesBar());
    await clickElement(buttonByTextIn(rowByText("合同.pdf"), "删除"));
    await clickElement(buttonByTextIn(removeUploadedCopyDialog(), "取消"));

    expect(removeMaterialCommands(stream)).toHaveLength(0);
  });

  it("移除上传素材确认期间切换会话后不再发送旧会话 removeMaterial", async () => {
    const stream = await renderWorkspaceWithUploadedMaterial();

    await clickElement(linkedFilesBar());
    await clickElement(buttonByTextIn(rowByText("合同.pdf"), "删除"));
    const modal = removeUploadedCopyDialog();
    await act(async () => {
      window.location.hash = "#/workspace?session=s-2";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await flushMicrotasks();
    expect(latestServerStream()).not.toBe(stream);

    await clickElement(buttonByTextIn(modal, "移除副本"));

    expect(removeMaterialCommands(stream)).toHaveLength(0);
  });

  it("旧稿 ack 后队列定时器执行前切会话，排队正文只会发往旧会话", async () => {
    window.location.hash = "#/workspace?session=s-1";
    const { useWorkspacePageController } = await import("./WorkspacePage");
    const captured: {
      current: ReturnType<typeof useWorkspacePageController> | null;
    } = { current: null };
    function ControllerHarness() {
      captured.current = useWorkspacePageController();
      return null;
    }
    await render(<ControllerHarness />);
    const oldStream = latestServerStream();
    await emitFrames(oldStream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "旧会话" } },
      {
        kind: "documentSnapshotWritten",
        data: {
          doc: wireSnapshotFromPmDoc(
            pmDoc([pmParagraph("p-queue", "初始正文")]),
            1,
          ),
        },
      },
      {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
      },
    ]);

    let resolveFirstSend: () => void = () => undefined;
    oldStream.sendCommand.mockImplementation(async (command: Command) => {
      if (command.kind !== "updateDoc") return;
      const text = JSON.stringify(command.data.doc);
      if (text.includes("排队正文 B")) {
        oldStream.emit({
          kind: "docWriteResult",
          data: {
            ok: true,
            clientMutationId: command.data.clientMutationId,
            docVersion: 3,
          },
        });
        return;
      }
      await new Promise<void>((resolve) => {
        resolveFirstSend = resolve;
      });
    });

    const firstSave = captured.current!.handleEditorChange(
      pmDoc([pmParagraph("p-queue", "在途正文 A")]),
    );
    await flushMicrotasks();
    const queuedSave = captured.current!.handleEditorChange(
      pmDoc([pmParagraph("p-queue", "排队正文 B")]),
    );
    expect(updateDocCommands(oldStream)).toHaveLength(1);

    vi.useFakeTimers();
    const firstCommand = updateDocCommands(oldStream)[0]!;
    act(() => {
      oldStream.emit({
        kind: "docWriteResult",
        data: {
          ok: true,
          clientMutationId: firstCommand.data.clientMutationId,
          docVersion: 2,
        },
      });
      resolveFirstSend();
      window.location.hash = "#/workspace?session=s-2";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await expect(Promise.all([firstSave, queuedSave])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await flushMicrotasks(5);

    const nextStream = latestServerStream();
    expect(nextStream).not.toBe(oldStream);
    expect(updateDocCommands(oldStream)).toHaveLength(2);
    expect(updateDocCommands(oldStream).map((command) => command.data.sessionId)).toEqual([
      "s-1",
      "s-1",
    ]);
    expect(JSON.stringify(updateDocCommands(oldStream)[1]?.data.doc)).toContain(
      "排队正文 B",
    );
    expect(updateDocCommands(nextStream)).toHaveLength(0);
  }, 15_000);

  it("e2e-loop-0704 P1 回归:半采纳放弃后的反馈卡文案是`采纳 1 处 · 拒绝 1 处`而非全拒", async () => {
    const { buildReviewOutcome } = await import("./WorkspacePage");
    const { ReviewOutcomeCard } = await import("./components/ReviewOutcomeCard");
    const outcome = buildReviewOutcome(
      [
        reviewToolCall("p-1", "batch-a", "accepted"),
        reviewToolCall("p-2", "batch-b", "reviewing"),
      ],
      { rejectUndecided: true },
    );

    await render(<ReviewOutcomeCard data={outcome} />);
    expect(host?.textContent).toContain("采纳 1 处 · 拒绝 1 处");
    expect(host?.textContent).not.toContain("放弃本轮全部");
  });

  it("A3 工具栏不再逐条采纳,提交会保留全部剩余候选", async () => {
    const first = textReviewToolCall("p-1", "batch-a", 0);
    const second = textReviewToolCall("p-2", "batch-b", 1);
    const stream = await renderWorkspaceWithReview([first, second]);

    expect(host?.textContent).toContain("剩余 · 2 处");
    expect(host?.textContent).not.toContain("采纳此处");
    expect(host?.textContent).not.toContain("拒绝此处");

    await clickButton("提交 ↵");

    expect(patchVerdictCommands(stream)).toHaveLength(0);
    expect(stream.commitReviewGroups).toHaveBeenCalledWith("s-1", {
      acceptReviewBatchIds: ["batch-a", "batch-b"],
      rejectReviewBatchIds: [],
    });
  });

  it("A3 单处候选点击提交后整体提交一次并解锁输入", async () => {
    const stream = await renderWorkspaceWithReview([
      textReviewToolCall("p-1", "batch-a", 0),
    ]);
    mockCommitWithFrames(stream, [docStateFrame("editing")]);

    await clickButton("提交 ↵");
    await flushMicrotasks(5);

    expect(stream.commitReviewGroups).toHaveBeenCalledTimes(1);
    expect(stream.commitReviewGroups).toHaveBeenCalledWith("s-1", {
      acceptReviewBatchIds: ["batch-a"],
      rejectReviewBatchIds: [],
    });
    expect(getChatEditor().getAttribute("contenteditable")).toBe("true");
  });

  it("A3 旧 atomic 数据内联撤销一处后不再整组移出 pending 队列", async () => {
    const first = textReviewToolCall("p-1", "batch-atomic", 0, "reviewing", "atomic");
    const second = textReviewToolCall("p-2", "batch-atomic", 1, "reviewing", "atomic");
    const stream = await renderWorkspaceWithReview([first, second]);

    act(() => {
      host!.querySelector("[data-patch-id='p-1']")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    await clickButton("撤销");
    expect(patchVerdictCommands(stream).map((command) => command.data.id)).toEqual(["p-1"]);
    await emitFrames(stream, [toolCallUpdatedFrame(reviewToolCall(
      "p-1",
      "batch-atomic",
      "rejected",
      { blockId: "block-p-1", before: "旧句子1", after: "新句子1", index: 0, groupMode: "atomic" },
    ))]);
    await flushMicrotasks(5);

    expect(host?.querySelector('[data-wf="PatchNav"]')).not.toBeNull();
    expect(host?.textContent).toContain("剩余 · 1 处");
    expect(stream.commitReviewGroups).not.toHaveBeenCalled();
  });

  it("内容和格式同处修改时 hover popup 收敛为替换态与格式态", async () => {
    const { RightPane } = await import("./WorkspacePage");
    const doc = mixedContentMarkDoc();
    const reviewData = mixedContentMarkReviewData();
    await render(
      <section id="view-workspace">
        <RightPane
          {...rightPaneProps({
            doc,
            patchMeta: mixedContentMarkPatchMeta(),
            reviewSuggestions: reviewData.suggestions,
            reviewAppliedPatches: reviewData.applied,
            remainingCount: 1,
            visiblePatchCount: 1,
          })}
        />
      </section>,
    );

    act(() => {
      host!.querySelector(".wf-patch-replace-wrap")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    let replacePopup = host!.querySelector(".patch-hover-popup");
    expect(replacePopup).not.toBeNull();
    expect(replacePopup!.querySelector(".patch-popup-change")).toBeNull();
    expect(replacePopup!.textContent).toContain("替换");
    expect(replacePopup!.textContent).toContain("原文");
    expect(replacePopup!.textContent).toContain("旧文");
    expect(replacePopup!.textContent).not.toContain("内容:");

    act(() => {
      host!.querySelector(".wf-patch-replace-wrap")!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: host }));
      host!.querySelector(".wf-patch-mark-wrap")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    const formatPopup = host!.querySelector(".patch-hover-popup");
    expect(formatPopup).not.toBeNull();
    expect(formatPopup!.textContent).toContain("新增格式");
    expect(formatPopup!.textContent).toContain("加粗/高亮");
  });

  it("多组 pendingReview 无可见 patch 时仍显示无法定位提示", async () => {
    const { RightPane } = await import("./WorkspacePage");
    await render(
      <section id="view-workspace">
        <RightPane
          {...rightPaneProps({
            effectiveReview: false,
            visiblePatchCount: 0,
            remainingCount: 0,
            unrenderablePatchCount: 7,
            patchMeta: new Map(),
          })}
        />
      </section>,
    );

    expect(host?.querySelector('[data-wf="PatchUnrenderableHint"]')?.textContent).toContain(
      "另有 7 处改动无法在正文定位",
    );
  });

  it("R2-02 整篇审提交若没有状态回帧，底部条会超时复位并提示重试", async () => {
    vi.useFakeTimers();
    const { RightPane } = await import("./WorkspacePage");
    const onAcceptAll = vi.fn();
    const onToast = vi.fn();
    await render(
      <section id="view-workspace">
        <RightPane
          {...rightPaneProps({
            wholeDocReview: true,
            editedNewDoc: multiGroupDoc(1),
            onAcceptAll,
            onToast,
          })}
        />
      </section>,
    );

    const apply = [...host!.querySelectorAll("button")].find(
      (button) => button.textContent === "应用新版",
    ) as HTMLButtonElement | undefined;
    expect(apply).toBeTruthy();

    await act(async () => {
      apply!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAcceptAll).toHaveBeenCalledTimes(1);
    expect(apply!.disabled).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(8000);
    });

    expect(apply!.disabled).toBe(false);
    expect(onToast).toHaveBeenCalledWith("操作仍未完成，请重试");
    // 用 fakeTimers 但测试体含真实 await(React 异步更新),慢 CI runner 下
    // 默认 5s 会超时;照本文件姊妹用例(第 583 行)补 per-test 超时。
  }, 30000);

  it("R2-02 提交返回帧没有离开 pendingReview 时会触发前端逃生", async () => {
    const { reviewCommitFramesLeavePendingReview } = await import("./WorkspacePage");
    const stillReview: BridgeFrame[] = [{
      kind: "docStateChanged",
      data: { state: { kind: "pendingReview" }, activeOverlay: null, agentBusy: false },
    }];
    const leftReview: BridgeFrame[] = [{
      kind: "docStateChanged",
      data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
    }];

    expect(reviewCommitFramesLeavePendingReview(stillReview)).toBe(false);
    expect(reviewCommitFramesLeavePendingReview(leftReview)).toBe(true);
  });
});

describe("WorkspacePage material parse retry", () => {
  it("素材重试命令适配器会把 /commands 返回帧继续交给 tracker", async () => {
    const { sendMaterialParseCommandWithStream } = await import("./WorkspacePage");
    const busyFrame: BridgeFrame = {
      kind: "stream",
      data: {
        kind: "draftingFailed",
        data: {
          streamId: "active-stream",
          reason: "生成中，请稍后再试",
          retriable: false,
        },
      },
    };
    const command: Command = {
      kind: "reparseMaterial",
      data: {
        sessionId: "s-1",
        fileId: "33333333-3333-4333-8333-333333333333",
      },
    };
    const stream = {
      sendCommand: vi.fn(async () => [busyFrame]),
    };

    await expect(sendMaterialParseCommandWithStream(stream, command)).resolves.toEqual([busyFrame]);
    expect(stream.sendCommand).toHaveBeenCalledWith(command);
    await expect(sendMaterialParseCommandWithStream(null, command)).rejects.toThrow("连接未就绪");
  });
});

describe("WorkspacePage optimistic send rollback", () => {
  it("上传失败后撤回刚插入的用户气泡并恢复输入快照", async () => {
    const { rollbackOptimisticChatSend } = await import("./WorkspacePage");
    const file = new File(["bad"], "bad.md", { type: "text/markdown" });
    const snapshot: ChatInputSnapshot = {
      text: "请分析附件",
      chips: [{ kind: "attach", label: "bad.md" }],
      files: [file],
      richText: "请分析附件 {{chip:0}}",
      skills: [],
    };
    let state = workspaceReducer(initialWorkspaceState, {
      kind: "chatMessageAdded",
      data: {
        message: {
          id: "m-user-failed",
          role: { kind: "user" },
          ts: "2026-06-16T00:00:00.000Z",
          parts: [{ kind: "text", data: { body: snapshot.richText } }],
          chips: [],
        },
      },
    });
    const restore = vi.fn();
    const setSendPending = vi.fn();
    const showToast = vi.fn();

    rollbackOptimisticChatSend({
      dispatch: (action) => {
        state = workspaceReducer(state, action);
      },
      chatInput: { restore },
      snapshot,
      keepMessageCount: 0,
      setSendPending,
      showToast,
      error: new Error("filename must not contain path separators or '..'"),
    });

    expect(state.messages).toEqual([]);
    expect(restore).toHaveBeenCalledWith(snapshot);
    expect(setSendPending).toHaveBeenCalledWith(false);
    expect(showToast).toHaveBeenCalledWith(
      "发送失败，请重试",
    );
  });
});

describe("WorkspacePage existing session restore retry", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("R4-006 existing startSession 500 会自动重试后成功", async () => {
    const { restoreExistingSessionWithRetry } = await import("./WorkspacePage");
    const startSession = vi.fn()
      .mockRejectedValueOnce(new Error("Stream request failed: 500"))
      .mockResolvedValueOnce("s-restored");
    const dispatch = vi.fn();
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(restoreExistingSessionWithRetry({
      sessionId: "s-existing",
      startSession,
      startSessionPromiseRef: { current: null },
      dispatch,
      delay,
    })).resolves.toBe("s-restored");

    expect(startSession).toHaveBeenCalledTimes(2);
    expect(startSession).toHaveBeenCalledWith({
      mode: { kind: "existing", data: { id: "s-existing" } },
    });
    expect(delay).toHaveBeenCalledWith(500);
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "streamErrorSet" }));
  });

  it("R4-006 restore 进行中会复用 startSessionPromiseRef,避免重复发起", async () => {
    const { restoreExistingSessionWithRetry } = await import("./WorkspacePage");
    let resolveStart: (value: string) => void = () => undefined;
    const startSession = vi.fn(() => new Promise<string>((resolve) => {
      resolveStart = resolve;
    }));
    const ref = { current: null as Promise<string> | null };
    const dispatch = vi.fn();

    const first = restoreExistingSessionWithRetry({
      sessionId: "s-existing",
      startSession,
      startSessionPromiseRef: ref,
      dispatch,
      delay: vi.fn().mockResolvedValue(undefined),
    });
    const second = restoreExistingSessionWithRetry({
      sessionId: "s-existing",
      startSession,
      startSessionPromiseRef: ref,
      dispatch,
      delay: vi.fn().mockResolvedValue(undefined),
    });
    resolveStart("s-existing");

    await expect(Promise.all([first, second])).resolves.toEqual(["s-existing", "s-existing"]);
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it("R4-006 restore 重试耗尽后派发持久可重试错误", async () => {
    const { restoreExistingSessionWithRetry } = await import("./WorkspacePage");
    const startSession = vi.fn().mockRejectedValue(new Error("Stream request failed: 503"));
    const dispatch = vi.fn();
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(restoreExistingSessionWithRetry({
      sessionId: "s-existing",
      startSession,
      startSessionPromiseRef: { current: null },
      dispatch,
      delay,
    })).rejects.toThrow("Stream request failed: 503");

    expect(startSession).toHaveBeenCalledTimes(4);
    expect(delay).toHaveBeenCalledTimes(3);
    expect(dispatch).toHaveBeenCalledWith({
      kind: "streamErrorSet",
      error: {
        kind: "failed",
        reason: "恢复会话失败，请重试",
        retriable: true,
      },
    });
  });

  it("R4-006 restore 失败且无文档时 RightPane 不再显示无限 loader", async () => {
    const { RightPane } = await import("./WorkspacePage");
    await render(
      <section id="view-workspace">
        <RightPane
          {...rightPaneProps({
            doc: null,
            streamError: { kind: "failed", reason: "恢复会话失败，请重试", retriable: true },
          })}
        />
      </section>,
    );

    expect(host?.textContent).toContain("恢复失败");
    expect(host?.querySelector(".doc-empty-loader")).toBeNull();
  });
});

describe("WorkspacePage history chat lock", () => {
  it("历史模式下拦截 chatInputBus.send 入口,不预填也不提交", async () => {
    const { submitImmediateChatInputSend } = await import("./WorkspacePage");
    const clear = vi.fn();
    const insertText = vi.fn();
    const submit = vi.fn();
    const showToast = vi.fn();

    submitImmediateChatInputSend({
      chatInput: { clear, insertText },
      text: "继续写",
      viewingHistory: true,
      submit,
      showToast,
      schedule: (callback) => callback(),
    });

    expect(clear).not.toHaveBeenCalled();
    expect(insertText).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      "正在看历史版本，回到当前版本后可继续对话",
      3500,
    );
  });
});

describe("WorkspacePage pending doc save guard", () => {
  it("发送前先 flush updateDoc ack，再启动 agent 发送流程", async () => {
    const { runAfterPendingDocSave } = await import("./WorkspacePage");
    const order: string[] = [];

    await runAfterPendingDocSave({
      flushPendingDocSave: async () => {
        order.push("updateDoc:start");
        await Promise.resolve();
        order.push("updateDoc:ack");
      },
      run: async () => {
        order.push("sendMessage:startAgent");
      },
    });

    expect(order).toEqual([
      "updateDoc:start",
      "updateDoc:ack",
      "sendMessage:startAgent",
    ]);
  });

  it("flush 冲突时不发送并提示", async () => {
    const {
      PendingDocSaveError,
      docSaveFailureToastMessage,
      runAfterPendingDocSave,
    } = await import("./WorkspacePage");
    const send = vi.fn(async () => {});
    const showToast = vi.fn();
    const conflict = new PendingDocSaveError(
      "文档保存冲突，请刷新后继续编辑。",
      {
        ok: false,
        clientMutationId: "mutation-conflict",
        conflict: {
          expectedDocumentSnapshot: 1,
          actualDocumentSnapshot: 2,
        },
      },
    );

    await expect(
      runAfterPendingDocSave({
        flushPendingDocSave: async () => {
          throw conflict;
        },
        run: send,
        onFlushFailure: (error) => {
          showToast(docSaveFailureToastMessage(error));
        },
      }),
    ).rejects.toBe(conflict);

    expect(send).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith("文档保存冲突，请刷新后继续编辑。");
  });
});

describe("WorkspacePage page-exit doc save", () => {
  it("只在有未保存文档时构造带乐观锁的 updateDoc 命令", async () => {
    const {
      buildPageExitDocSaveCommand,
      shouldFlushDocSaveOnPageExit,
    } = await import("./WorkspacePage");
    const baseline = pmDoc([pmParagraph("p-1", "旧正文")]);
    const edited = pmDoc([pmParagraph("p-1", "新正文")]);

    expect(shouldFlushDocSaveOnPageExit({
      pmDoc: baseline,
      baselineDoc: baseline,
      hasPendingDocSave: false,
    })).toBe(false);
    expect(shouldFlushDocSaveOnPageExit({
      pmDoc: baseline,
      baselineDoc: baseline,
      hasPendingDocSave: true,
    })).toBe(true);

    expect(buildPageExitDocSaveCommand({
      sessionId: "session-1",
      expectedDocumentSnapshot: 7,
      pmDoc: baseline,
      baselineDoc: baseline,
      hasPendingDocSave: false,
      createMutationId: () => "exit-skip",
    })).toBeNull();

    const command = buildPageExitDocSaveCommand({
      sessionId: "session-1",
      expectedDocumentSnapshot: 7,
      pmDoc: edited,
      baselineDoc: baseline,
      hasPendingDocSave: false,
      createMutationId: () => "exit-1",
    });

    expect(command).toMatchObject({
      kind: "updateDoc",
      data: {
        sessionId: "session-1",
        expectedDocumentSnapshot: 7,
        clientMutationId: "exit-1",
        legacySections: [{ kind: "p", data: { text: "新正文" } }],
      },
    });
  });

  it("page-exit flush 优先 sendBeacon,失败时回退 keepalive fetch", async () => {
    const { flushDocSaveOnPageExit } = await import("./WorkspacePage");
    const baseline = pmDoc([pmParagraph("p-1", "旧正文")]);
    const edited = pmDoc([pmParagraph("p-1", "新正文")]);
    const sendBeacon = vi.fn((_url: string, _data?: BodyInit | null) => true);

    expect(flushDocSaveOnPageExit({
      sessionId: "session-1",
      expectedDocumentSnapshot: 7,
      pmDoc: edited,
      baselineDoc: baseline,
      hasPendingDocSave: false,
      createMutationId: () => "exit-beacon",
      sendBeacon,
      url: "/api/v1/stream",
    })).toBe("beacon");

    expect(sendBeacon).toHaveBeenCalledWith("/api/v1/stream", expect.any(Blob));
    const beaconBody = JSON.parse(await blobText(sendBeacon.mock.calls[0]?.[1] as Blob));
    expect(beaconBody).toMatchObject({
      kind: "updateDoc",
      data: {
        sessionId: "session-1",
        expectedDocumentSnapshot: 7,
        clientMutationId: "exit-beacon",
      },
    });

    const fetchKeepalive = vi.fn(async (_url: string, _init: RequestInit) => new Response(""));
    expect(flushDocSaveOnPageExit({
      sessionId: "session-1",
      expectedDocumentSnapshot: 8,
      pmDoc: edited,
      baselineDoc: baseline,
      hasPendingDocSave: false,
      createMutationId: () => "exit-fetch",
      sendBeacon: () => false,
      fetchKeepalive,
    })).toBe("keepalive");

    expect(fetchKeepalive).toHaveBeenCalledWith("/api/v1/stream", expect.objectContaining({
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
    }));
    const fetchInit = fetchKeepalive.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(fetchInit.body as string)).toMatchObject({
      kind: "updateDoc",
      data: {
        sessionId: "session-1",
        expectedDocumentSnapshot: 8,
        clientMutationId: "exit-fetch",
      },
    });
  });
});

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function installWorkspaceDomMocks(): () => void {
  const originalMatchMedia = window.matchMedia;
  const originalWindowRaf = window.requestAnimationFrame;
  const originalWindowCancelRaf = window.cancelAnimationFrame;
  const originalGlobalRaf = globalThis.requestAnimationFrame;
  const originalGlobalCancelRaf = globalThis.cancelAnimationFrame;
  const originalWindowFetch = window.fetch;
  const originalGlobalFetch = globalThis.fetch;
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  const originalScrollTo = Element.prototype.scrollTo;
  const originalInnerText = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText");

  const raf = (callback: FrameRequestCallback): number =>
    window.setTimeout(() => callback(performance.now()), 0);
  const cancelRaf = (id: number): void => window.clearTimeout(id);
  const matchMedia = (query: string): MediaQueryList => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/api/v1/settings/model")) {
      return new Response(JSON.stringify({ apiKeyConfigured: true }), { status: 200 });
    }
    if (url.endsWith("/api/v1/capabilities")) {
      return new Response(JSON.stringify({
        folderSources: {
          desktopLocal: { enabled: false },
          browserFsAccess: { enabled: false },
        },
      }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });

  Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });
  Object.defineProperty(window, "requestAnimationFrame", { configurable: true, value: raf });
  Object.defineProperty(window, "cancelAnimationFrame", { configurable: true, value: cancelRaf });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: raf });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: cancelRaf });
  Object.defineProperty(window, "fetch", { configurable: true, value: fetchMock });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent ?? "";
    },
    set(value: string) {
      this.textContent = value;
    },
  });

  return () => {
    restoreProperty(window, "matchMedia", originalMatchMedia);
    restoreProperty(window, "requestAnimationFrame", originalWindowRaf);
    restoreProperty(window, "cancelAnimationFrame", originalWindowCancelRaf);
    restoreProperty(globalThis, "requestAnimationFrame", originalGlobalRaf);
    restoreProperty(globalThis, "cancelAnimationFrame", originalGlobalCancelRaf);
    restoreProperty(window, "fetch", originalWindowFetch);
    restoreProperty(globalThis, "fetch", originalGlobalFetch);
    restoreProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
    restoreProperty(Element.prototype, "scrollTo", originalScrollTo);
    restoreDescriptor(HTMLElement.prototype, "innerText", originalInnerText);
  };
}

function restoreProperty(target: object, key: string, value: unknown): void {
  if (value === undefined) {
    delete (target as Record<string, unknown>)[key];
    return;
  }
  Object.defineProperty(target, key, { configurable: true, value });
}

function restoreDescriptor(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (!descriptor) {
    delete (target as Record<string, unknown>)[key];
    return;
  }
  Object.defineProperty(target, key, descriptor);
}

function latestServerStream(): MockServerStreamInstance {
  const stream = serverStreamMock.instances.at(-1);
  if (!stream) throw new Error("ServerStream mock instance not found");
  return stream;
}

async function flushMicrotasks(times = 3): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  });
}

async function emitFrames(stream: MockServerStreamInstance, frames: BridgeFrame[]): Promise<void> {
  await act(async () => {
    for (const frame of frames) stream.emit(frame);
  });
  await flushMicrotasks();
}

function textReviewToolCall(
  id: string,
  reviewBatchId: string,
  index: number,
  status: "reviewing" | "accepted" | "rejected" = "reviewing",
  groupMode: "atomic" | "independent" = "independent",
): ToolCallSpec {
  return reviewToolCall(id, reviewBatchId, status, {
    blockId: `block-${id}`,
    before: `旧句子${index + 1}`,
    after: `新句子${index + 1}`,
    index,
    groupMode,
  });
}

function docSuggestionFromToolCall(spec: ToolCallSpec): DocSuggestion {
  if (spec.body.kind !== "docSuggestion" || spec.body.data.kind !== "suggestion") {
    throw new Error("fixture must be a docSuggestion");
  }
  return spec.body.data.data;
}

function baseDocForReviewSpecs(specs: ToolCallSpec[]): PmDoc {
  return pmDoc(
    specs.map((spec) => {
      const suggestion = docSuggestionFromToolCall(spec);
      const blockId = suggestion.anchor.blockId ?? suggestion.id;
      return pmParagraph(blockId, suggestion.preview.deleteText);
    }),
  );
}

async function renderWorkspaceWithReview(specs: ToolCallSpec[]): Promise<MockServerStreamInstance> {
  const { WorkspacePage } = await import("./WorkspacePage");
  await render(<WorkspacePage />);
  const stream = latestServerStream();
  await emitFrames(stream, [
    { kind: "sessionMeta", data: { sessionId: "s-1", title: "测试审阅" } },
    { kind: "documentSnapshotWritten", data: { doc: wireSnapshotFromPmDoc(baseDocForReviewSpecs(specs), 1) } },
    { kind: "docStateChanged", data: { state: { kind: "pendingReview" }, activeOverlay: null, agentBusy: false } },
    ...specs.map((spec) => ({
      kind: "toolCallUpdated" as const,
      data: { messageId: "m-review", toolCallId: spec.id, spec },
    })),
  ]);
  return stream;
}

async function renderWorkspaceWithAnnotations(
  status: AnnotationGroup["status"] = "reviewing",
  setup?: (stream: MockServerStreamInstance) => void,
): Promise<MockServerStreamInstance> {
  const { WorkspacePage } = await import("./WorkspacePage");
  await render(<WorkspacePage />);
  const stream = latestServerStream();
  setup?.(stream);
  const annotation: AnnotationGroup = {
    id: "annotation-1",
    summary: "事实有误",
    note: "时间与资料不一致",
    origin: "source-check",
    suggestion: "改为四月发布",
    status,
    anchors: [{ blockId: "p-1", pmFrom: 1, pmTo: 3, quote: "甲组", textHash: "hash-annotation-1" }],
  };
  await emitFrames(stream, [
    { kind: "sessionMeta", data: { sessionId: "s-1", title: "测试批注" } },
    { kind: "documentSnapshotWritten", data: { doc: wireSnapshotFromPmDoc(pmDoc([pmParagraph("p-1", "甲组正文")]), 1) } },
    { kind: "docStateChanged", data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false } },
    { kind: "annotationGroupsReady", data: { groups: [annotation] } },
  ]);
  return stream;
}

/** 内联(overlay 形态)askUser 反问卡 fixture:审核回流追问后模型问拒绝原因的形态。 */
function inlineAskUserToolCall(id: string): ToolCallSpec {
  return {
    id,
    name: "askUser",
    render: { kind: "rightOverlay" },
    status: { kind: "pending" },
    body: {
      kind: "askUser",
      data: {
        id,
        mode: { kind: "overlay" },
        purpose: null,
        source: null,
        rationale: null,
        questions: [
          {
            id: "q-reject-reason",
            label: "为什么放弃这些修改？",
            kind: { kind: "single" },
            options: [
              { value: "tone", label: "语气不合适", description: null, preview: null },
              { value: "scope", label: "改动范围过大", description: null, preview: null },
            ],
            placeholder: null,
          },
        ],
      },
    },
    result: null,
  };
}

/** 挂起态工作区:有正文 + 内联 askUser 问卷开着(activeOverlay=askUser),输入/导出被锁。 */
async function renderWorkspaceWithInlineAskUser(): Promise<MockServerStreamInstance> {
  const { WorkspacePage } = await import("./WorkspacePage");
  await render(<WorkspacePage />);
  const stream = latestServerStream();
  await emitFrames(stream, [
    { kind: "sessionMeta", data: { sessionId: "s-1", title: "测试内联问卷" } },
    {
      kind: "documentSnapshotWritten",
      data: { doc: wireSnapshotFromPmDoc(pmDoc([pmParagraph("p-1", "正文内容")]), 1) },
    },
    {
      kind: "toolCallUpdated",
      data: { messageId: "m-ask", toolCallId: "ask-1", spec: inlineAskUserToolCall("ask-1") },
    },
    {
      kind: "docStateChanged",
      data: { state: { kind: "editing" }, activeOverlay: "askUser", agentBusy: false },
    },
  ]);
  return stream;
}

async function renderWorkspaceWithUploadedMaterial(): Promise<MockServerStreamInstance> {
  const { WorkspacePage } = await import("./WorkspacePage");
  await render(<WorkspacePage />);
  const stream = latestServerStream();
  await emitFrames(stream, [
    { kind: "sessionMeta", data: { sessionId: "s-1", title: "测试素材删除" } },
    { kind: "resourceUpserted", data: { resource: uploadedMaterialResource() } },
  ]);
  return stream;
}

function uploadedMaterialResource(): Resource {
  return {
    resourceRef: { id: "mat-1", domain: { kind: "file" } },
    displayName: "合同.pdf",
    summary: "合同摘要",
    mime: "application/pdf",
    byteLen: 2048,
    createdAt: "2026-07-04T00:00:00.000Z",
    metadata: { fileId: "file-mat-1" },
  };
}

function exportButton(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>(".ws-export-anchor .ws-doc-btn");
  if (!button) throw new Error("export button not found");
  return button;
}

function getChatEditor(): HTMLDivElement {
  const editor = host?.querySelector<HTMLDivElement>('[data-wf="ChatInput"]');
  if (!editor) throw new Error("ChatInput editor not found");
  return editor;
}

function bindInnerText(element: HTMLElement): void {
  Object.defineProperty(element, "innerText", {
    configurable: true,
    get: () => element.textContent ?? "",
    set: (value: string) => {
      element.textContent = value;
    },
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...host!.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

async function clickButton(text: string): Promise<void> {
  await act(async () => {
    buttonByText(text).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushMicrotasks();
}

async function clickElement(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushMicrotasks();
}

function linkedFilesBar(): HTMLElement {
  const bar = host?.querySelector<HTMLElement>('[data-wf="LinkedFilesBar"]');
  if (!bar) throw new Error("LinkedFilesBar not found");
  return bar;
}

function rowByText(text: string): HTMLElement {
  const row = Array.from(host?.querySelectorAll<HTMLElement>(".lf-row") ?? []).find((item) =>
    item.textContent?.includes(text),
  );
  if (!row) throw new Error(`row not found: ${text}`);
  return row;
}

function buttonByTextIn(rootEl: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(rootEl.querySelectorAll<HTMLButtonElement>("button")).find((item) =>
    item.textContent?.includes(text),
  );
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

function removeUploadedCopyDialog(): HTMLElement {
  const dialog = host?.querySelector<HTMLElement>('[data-wf="GlobalConfirm"]');
  if (!dialog) throw new Error("GlobalConfirm not found");
  return dialog;
}

function sendMessageCommands(stream: MockServerStreamInstance): Command[] {
  return stream.sendCommand.mock.calls
    .map(([command]) => command as Command)
    .filter((command) => command.kind === "sendMessage");
}

function removeMaterialCommands(stream: MockServerStreamInstance): Command[] {
  return stream.sendCommand.mock.calls
    .map(([command]) => command as Command)
    .filter((command) => command.kind === "removeMaterial");
}

function updateDocCommands(
  stream: MockServerStreamInstance,
): Array<Extract<Command, { kind: "updateDoc" }>> {
  return stream.sendCommand.mock.calls
    .map(([command]) => command as Command)
    .filter((command): command is Extract<Command, { kind: "updateDoc" }> =>
      command.kind === "updateDoc");
}

function patchVerdictCommands(
  stream: MockServerStreamInstance,
): Array<Extract<Command, { kind: "acceptPatch" | "rejectPatch" }>> {
  return stream.sendCommand.mock.calls
    .map(([command]) => command as Command)
    .filter((
      command,
    ): command is Extract<Command, { kind: "acceptPatch" | "rejectPatch" }> =>
      command.kind === "acceptPatch" || command.kind === "rejectPatch",
    );
}

function docStateFrame(kind: "pendingReview" | "editing"): BridgeFrame {
  return {
    kind: "docStateChanged",
    data: { state: { kind }, activeOverlay: null, agentBusy: false },
  };
}

function toolCallUpdatedFrame(spec: ToolCallSpec): BridgeFrame {
  return {
    kind: "toolCallUpdated",
    data: { messageId: "m-review", toolCallId: spec.id, spec },
  };
}

function mockCommitWithFrames(
  stream: MockServerStreamInstance,
  frames: BridgeFrame[],
): void {
  stream.commitReviewGroups.mockImplementation(async () => {
    for (const frame of frames) stream.emit(frame);
    return frames;
  });
}

function mockPendingCommit(stream: MockServerStreamInstance): {
  promise: Promise<BridgeFrame[]>;
  resolve: (frames: BridgeFrame[]) => void;
} {
  let resolve: (frames: BridgeFrame[]) => void = () => undefined;
  const promise = new Promise<BridgeFrame[]>((res) => {
    resolve = res;
  });
  stream.commitReviewGroups.mockReturnValueOnce(promise);
  return { promise, resolve };
}

async function render(element: ReactNode): Promise<void> {
  const [{ ConfirmProvider }, { ToastProvider }] = await Promise.all([
    import("../../system/ConfirmProvider"),
    import("../../system/ToastProvider"),
  ]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ToastProvider>
        <ConfirmProvider>{element}</ConfirmProvider>
      </ToastProvider>,
    );
  });
}

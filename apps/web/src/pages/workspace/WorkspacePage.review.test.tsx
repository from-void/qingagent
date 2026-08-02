// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AnnotationGroup, BridgeFrame, Command, DiffHunk, DocSuggestion, DocumentSnapshot, Resource, ToolCallSpec } from "@qingagent/contract-ts";
import { getPmContentHash, normalizePmDoc, type PmBlockNode, type PmDoc } from "@qingagent/pm-schema";
import type { ChatInputSnapshot } from "./data/chatInputTypes";
import type { DocDimensions } from "./data/docDimensions";
import type { DerivativeItem } from "./components/derivatives/types";
import {
  derivePatchPresentation,
  pmDocToViewDocumentSnapshot,
  suggestionToBlockPatchInput,
  suggestionToPatchOverlay,
  type AppliedPatch,
  type ChatMessage,
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

function clearPageExitOutboxStorage(): void {
  const prefix = "qingagent.page_exit_doc_save_outbox.v1";
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key === prefix || key?.startsWith(`${prefix}:`)) {
      localStorage.removeItem(key);
    }
  }
}

type MockServerStreamInstance = {
  listeners: Set<(frame: BridgeFrame) => void>;
  sendCommand: ReturnType<typeof vi.fn>;
  startSession: ReturnType<typeof vi.fn>;
  listDerivatives: ReturnType<typeof vi.fn>;
  createDerivative: ReturnType<typeof vi.fn>;
  getDerivativeDoc: ReturnType<typeof vi.fn>;
  renameSession: ReturnType<typeof vi.fn>;
  commitReviewGroups: ReturnType<typeof vi.fn>;
  ignoreAnnotationGroups: ReturnType<typeof vi.fn>;
  updateMaterialSummary: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  emit: (frame: BridgeFrame) => void;
};

const serverStreamMock = vi.hoisted(() => ({
  instances: [] as MockServerStreamInstance[],
  // 可控 startSession(e2e-loop-0704 R15 回归用):置非 null 时替代默认的立即 resolve,
  // 用于模拟"建会话在途"窗口。用完的测试负责在 finally 里清回 null。
  startSessionImpl: null as ((
    stream: MockServerStreamInstance,
    data: Extract<Command, { kind: "startSession" }>["data"],
  ) => Promise<string>) | null,
  listDerivativesImpl: null as
    | ((sessionId: string) => Promise<unknown[]>)
    | null,
  createDerivativeImpl: null as
    | ((targetLang?: string) => Promise<DerivativeItem>)
    | null,
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
    startSession = vi.fn(async (
      data: Extract<Command, { kind: "startSession" }>["data"],
    ) =>
      serverStreamMock.startSessionImpl
        ? serverStreamMock.startSessionImpl(this, data)
        : "s-1",
    );
    listDerivatives = vi.fn(async (sessionId: string) =>
      serverStreamMock.listDerivativesImpl
        ? serverStreamMock.listDerivativesImpl(sessionId)
        : [],
    );
    createDerivative = vi.fn(async (
      _sessionId: string,
      _dtype: string,
      _templateId: string,
      _privatePrompt: string,
      _writingStyleId?: string,
      _layoutStyleId?: string | null,
      targetLang?: string,
    ) => {
      if (!serverStreamMock.createDerivativeImpl) {
        throw new Error("createDerivative mock is not configured");
      }
      return serverStreamMock.createDerivativeImpl(targetLang);
    });
    getDerivativeDoc = vi.fn(async () => null);
    renameSession = vi.fn(async () => undefined);
    commitReviewGroups = vi.fn(async () => []);
    ignoreAnnotationGroups = vi.fn(async () => undefined);
    updateMaterialSummary = vi.fn(
      async (_sessionId: string, materialId: string, summary: string) => {
        this.emit({
          kind: "resourceUpdated",
          data: {
            resourceRef: { id: materialId, domain: { kind: "file" } },
            summary,
            metadata: { fileId: `file-${materialId}` },
          },
        });
      },
    );
    cancel = vi.fn(async () => {
      this.dispatchLocal?.({ kind: "streamTerminated", reason: "stop" });
    });
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

  return {
    ServerStream,
    loggedFrameObservabilityOf: () => null,
  };
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

function pmTable(blockId: string, rows: readonly (readonly string[])[]): PmBlockNode {
  return {
    type: "table",
    attrs: { blockId },
    content: rows.map((row, rowIndex) => ({
      type: "tableRow",
      content: row.map((text, cellIndex) => ({
        type: rowIndex === 0 ? "tableHeader" : "tableCell",
        content: [pmParagraph(`${blockId}-r${rowIndex}-c${cellIndex}`, text)],
      })),
    })),
  } as PmBlockNode;
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
    reviewResolutionAvailable: true,
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
    serverStreamMock.listDerivativesImpl = null;
    serverStreamMock.createDerivativeImpl = null;
    window.location.hash = "";
    sessionStorage.clear();
    clearPageExitOutboxStorage();
    localStorage.setItem("qingagent.deepseek_api_key", "test-key");
    restoreWorkspaceDomMocks = installWorkspaceDomMocks();
  });

  afterEach(() => {
    restoreWorkspaceDomMocks?.();
    restoreWorkspaceDomMocks = null;
    localStorage.removeItem("qingagent.deepseek_api_key");
    clearPageExitOutboxStorage();
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
  }, 60_000);

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
  }, 60_000);

  it("恢复帧残留 empty 但正文已到达时挂载编辑器，并保留审查/导出入口", async () => {
    window.location.hash = "#/workspace?session=s-empty-projection";
    const { WorkspacePage } = await import("./WorkspacePage");
    await render(<WorkspacePage />);
    const stream = latestServerStream();

    await emitFrames(stream, [
      {
        kind: "sessionMeta",
        data: {
          sessionId: "s-empty-projection",
          title: "恢复态文档",
        },
      },
      {
        kind: "docStateChanged",
        data: {
          state: { kind: "empty" },
          activeOverlay: null,
          agentBusy: false,
        },
      },
      {
        kind: "documentSnapshotWritten",
        data: {
          doc: wireSnapshotFromPmDoc(
            pmDoc([pmParagraph("restored-body", "恢复后的可见正文")]),
            7,
          ),
        },
      },
      {
        kind: "sessionRestoreCompleted",
        data: { sessionId: "s-empty-projection" },
      },
    ]);
    await flushMicrotasks(8);

    expect(host?.querySelector(".ProseMirror.wf-doc")).not.toBeNull();
    expect(
      host?.querySelector<HTMLElement>(".ProseMirror.wf-doc")?.getAttribute(
        "contenteditable",
      ),
    ).toBe("true");
    expect(document.body.dataset.content).toBe("editing");
    expect(document.body.dataset.tool).toBe("none");
    expect(
      host?.querySelector<HTMLButtonElement>('.ws-docfns button[title="审查"]'),
    ).not.toBeNull();
    expect(
      host?.querySelector<HTMLButtonElement>('.ws-docfns button[title="导出"]'),
    ).not.toBeNull();
  }, 60_000);

  it("卸载工作区会等待 deferred 文档 flush，StrictMode 演练不重复 flush", async () => {
    let resolveFlush!: () => void;
    const deferredFlush = new Promise<void>((resolve) => {
      resolveFlush = resolve;
    });
    const flushPendingDocSave = vi.fn(() => deferredFlush);
    const fallbackDocSave = vi.fn();
    const preparePageExitDocSave = vi.fn(() => fallbackDocSave);
    vi.doMock("./hooks/useWorkspaceDocumentEditor", () => ({
      useWorkspaceDocumentEditor: () => ({
        flushPendingDocSave,
        getLatestExportPmDoc: () => null,
        handleCreateBlankDoc: vi.fn(),
        handleEditorChange: vi.fn(),
        handleFillTemplate: vi.fn(),
        preparePageExitDocSave,
      }),
    }));

    try {
      const { WorkspacePage } = await import("./WorkspacePage");
      await render(
        <StrictMode>
          <WorkspacePage />
        </StrictMode>,
      );
      const stream = latestServerStream();
      vi.useFakeTimers();

      act(() => vi.advanceTimersByTime(75));
      expect(flushPendingDocSave).not.toHaveBeenCalled();
      expect(stream.dispose).not.toHaveBeenCalled();

      act(() => root?.unmount());
      root = null;
      act(() => vi.advanceTimersByTime(75));
      expect(flushPendingDocSave).toHaveBeenCalledTimes(1);
      expect(stream.dispose).not.toHaveBeenCalled();
      expect(fallbackDocSave).not.toHaveBeenCalled();

      await act(async () => {
        resolveFlush();
        await deferredFlush;
      });
      await flushMicrotasks(2);
      expect(stream.dispose).toHaveBeenCalledTimes(1);
      expect(fallbackDocSave).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("./hooks/useWorkspaceDocumentEditor");
    }
  }, 60_000);

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
    expect(updateDocCommands(stream)[0]?.data.baseContentHash).toBe(
      getPmContentHash(pmDoc([pmParagraph("p-home-save", "初始正文")])),
    );
    expect(JSON.stringify(updateDocCommands(stream)[0]?.data.doc)).toContain(
      "返回首页前的新正文",
    );
    act(() => vi.advanceTimersByTime(260));
    expect(window.location.hash).toBe("#/");
  }, 60_000);

  it("首帧正文出现前返回首页不弹中断确认并直接导航", async () => {
    window.location.hash = "#/workspace?session=s-1";
    const { useWorkspacePageController } = await import("./WorkspacePage");
    const captured: {
      current: ReturnType<typeof useWorkspacePageController> | null;
    } = { current: null };
    function ControllerHarness() {
      const controller = useWorkspacePageController();
      captured.current = controller;
      return <section id="view-workspace" />;
    }
    await render(<ControllerHarness />);
    const stream = latestServerStream();
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "生成中的会话" } },
      {
        kind: "stream",
        data: { kind: "start", data: { streamId: "stream-early-switch" } },
      },
    ]);
    vi.useFakeTimers();

    await act(async () => {
      await captured.current?.handleBackHome();
    });

    const dialog = host?.querySelector<HTMLElement>('[data-wf="GlobalConfirm"]');
    expect(dialog).toBeNull();
    expect(stream.dispose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(260));
    expect(window.location.hash).toBe("#/");
  }, 60_000);

  it("文件上传占位可规范化保存，外部同步期间无报错且完成后原位写回", async () => {
    let resolveUpload!: (value: {
      fileId: string;
      filename: string;
      mimeType: string;
      size: number;
    }) => void;
    const upload = new Promise<{
      fileId: string;
      filename: string;
      mimeType: string;
      size: number;
    }>((resolve) => {
      resolveUpload = resolve;
    });
    vi.doMock("./data/uploadAsset", () => ({
      uploadAssetFile: vi.fn(() => upload),
      uploadedAssetUrl: (asset: { fileId: string; filename: string }) =>
        `/api/v1/files/${asset.fileId}/${asset.filename}`,
    }));

    try {
      window.location.hash = "#/workspace?session=s-1";
      const [
        { useWorkspacePageController },
        { WorkspaceDocumentPane },
        { insertFileAsset },
      ] = await Promise.all([
        import("./WorkspacePage"),
        import("./components/WorkspaceDocumentPane"),
        import("./data/insertUploadedAsset"),
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
        { kind: "sessionMeta", data: { sessionId: "s-1", title: "上传附件" } },
        {
          kind: "documentSnapshotWritten",
          data: {
            doc: wireSnapshotFromPmDoc(
              pmDoc([pmParagraph("upload-base", "上传前正文")]),
              1,
            ),
          },
        },
        {
          kind: "docStateChanged",
          data: {
            state: { kind: "editing" },
            activeOverlay: null,
            agentBusy: false,
          },
        },
      ]);
      const editor = captured.current?.tiptapEditor;
      expect(editor).not.toBeNull();
      vi.spyOn(editor!.view, "coordsAtPos").mockReturnValue({
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
      });
      vi.useFakeTimers();

      let pendingUpload!: Promise<unknown>;
      await act(async () => {
        pendingUpload = insertFileAsset(
          editor!,
          new File(["data"], "report.pdf", { type: "application/pdf" }),
        );
      });
      const pendingDoc = normalizePmDoc(editor!.getJSON());
      expect(
        pendingDoc.content.some((node) => node.type === "fileAttachment"),
      ).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await flushMicrotasks(5);
      const saves = updateDocCommands(stream);
      expect(saves.length).toBeGreaterThan(0);
      expect(
        saves.every(
          (command) =>
            !JSON.stringify(command.data.doc).includes("upload-pending:"),
        ),
      ).toBe(true);

      await emitFrames(stream, [{
        kind: "documentSnapshotWritten",
        data: {
          doc: wireSnapshotFromPmDoc(
            pmDoc([
              pmParagraph("upload-base", "外部同步后的正文"),
              pmParagraph("upload-tail", "外部新增段落"),
            ]),
            3,
          ),
        },
      }]);
      expect(editor!.getText()).toContain("外部同步后的正文");
      expect(
        editor!.getJSON().content?.some(
          (node) => node.type === "fileAttachment",
        ),
      ).toBe(true);
      expect(host?.textContent).not.toContain("暂不支持");

      await act(async () => {
        resolveUpload({
          fileId: "550e8400-e29b-41d4-a716-446655440000",
          filename: "report.pdf",
          mimeType: "application/pdf",
          size: 4,
        });
        await pendingUpload;
      });
      const completed = normalizePmDoc(editor!.getJSON());
      expect(JSON.stringify(completed)).toContain("外部同步后的正文");
      expect(
        completed.content.find((node) => node.type === "fileAttachment"),
      ).toMatchObject({
        attrs: {
          fileId: "550e8400-e29b-41d4-a716-446655440000",
          filename: "report.pdf",
        },
      });
    } finally {
      vi.doUnmock("./data/uploadAsset");
    }
  }, 60_000);

  it("dirty 外标签收到 snapshotWritten 广播时冻结旧版本，下次保存以旧基线触发 conflict", async () => {
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
    const staleDoc = pmDoc([pmParagraph("p-concurrent", "旧正文")]);
    const dirtyDoc = pmDoc([
      pmParagraph("p-concurrent", "旧正文"),
      pmParagraph("p-local", "外标签本地未保存句"),
    ]);
    const remoteDoc = pmDoc([
      pmParagraph("p-concurrent", "先写标签已保存的新正文"),
    ]);
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "并发保存" } },
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(staleDoc, 7) },
      },
      {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
      },
    ]);
    await flushMicrotasks(5);
    const editor = captured.current?.tiptapEditor;
    expect(editor).not.toBeNull();

    stream.sendCommand.mockImplementation(async (command: Command) => {
      if (command.kind !== "updateDoc") return;
      stream.emit({
        kind: "docWriteResult",
        data: {
          ok: false,
          clientMutationId: command.data.clientMutationId,
          conflict: {
            expectedDocumentSnapshot: command.data.expectedDocumentSnapshot,
            actualDocumentSnapshot: 8,
          },
        },
      });
    });
    vi.useFakeTimers();
    act(() => {
      editor!.commands.setContent(dirtyDoc);
    });
    expect(updateDocCommands(stream)).toHaveLength(0);

    await emitFrames(stream, [
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(remoteDoc, 8) },
      },
    ]);

    expect(captured.current?.state.version).toBe(7);
    expect(captured.current?.state.doc?.pmDoc).toEqual(staleDoc);
    expect(JSON.stringify(editor!.getJSON())).toContain("外标签本地未保存句");
    expect(JSON.stringify(editor!.getJSON())).not.toContain("先写标签已保存的新正文");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await flushMicrotasks(5);

    const save = updateDocCommands(stream)[0];
    expect(save?.data.expectedDocumentSnapshot).toBe(7);
    expect(save?.data.baseContentHash).toBe(getPmContentHash(staleDoc));
    expect(JSON.stringify(save?.data.doc)).toContain("外标签本地未保存句");
    expect(captured.current?.state.streamError).toMatchObject({
      kind: "docWriteConflict",
      actualDocumentSnapshot: 8,
    });

    // conflict 已清空防抖/在途标志，但编辑器里的未保存正文仍然是 dirty；后续广播也不能覆盖。
    await emitFrames(stream, [
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(remoteDoc, 8) },
      },
    ]);
    expect(captured.current?.state.version).toBe(7);
    expect(JSON.stringify(editor!.getJSON())).toContain("外标签本地未保存句");
  }, 60_000);

  it("候选首帧早于 pendingReview 时，live 正文等于 previewDoc 不误报服务器新版本", async () => {
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
    const staleCanonical = pmDoc([
      pmParagraph("lyric-line", "陈旧 React 基线"),
    ]);
    const candidateBase = pmDoc([
      pmParagraph("verse-1", "主歌第一行"),
      pmParagraph("verse-2", "主歌第二行"),
      pmParagraph("lyric-line", "副歌旧句"),
      pmParagraph("bridge-1", "桥段第一行"),
      pmParagraph("outro-1", "尾声第一行"),
    ]);
    const editedDoc = pmDoc([
      pmParagraph("verse-1", "主歌第一行"),
      pmParagraph("verse-2", "主歌第二行"),
      pmParagraph("lyric-line", "站台上的名字被晚风吹成歌"),
      pmParagraph("bridge-1", "桥段第一行"),
      pmParagraph("outro-1", "尾声第一行"),
    ]);
    const spec = reviewToolCall(
      "lyric-hunk",
      "batch-lyric",
      "reviewing",
      {
        blockId: "lyric-line",
        before: "副歌旧句",
        after: "站台上的名字被晚风吹成歌",
        index: 2,
      },
    );
    const suggestion = docSuggestionFromToolCall(spec);

    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "候选冲突止血" } },
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(staleCanonical, 1) },
      },
      docStateFrame("editing"),
      {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: true },
      },
    ]);
    await flushMicrotasks(5);
    const editor = captured.current?.tiptapEditor;
    expect(editor).not.toBeNull();
    expect(editor!.isEditable).toBe(false);

    // 模拟 r47 上一帧内部投影已把正确 base 写进 TipTap，但 React canonical
    // 仍滞后；busy-readonly 没有 onEditorChange，不会制造本地保存事务。
    act(() => {
      editor!.commands.setContent(candidateBase);
    });
    expect(updateDocCommands(stream)).toHaveLength(0);

    // 服务端的固定顺序是 docDiffReady 在先，pendingReview 投影在后。
    await emitFrames(stream, [
      {
        kind: "docDiffReady",
        data: {
          baseVersion: 1,
          suggestions: [suggestion],
          previewDoc: candidateBase,
          editedDoc,
        },
      },
    ]);

    expect(captured.current?.state.streamError).toBeNull();
    expect(captured.current?.state.docDiff).not.toBeNull();
    expect(captured.current?.state.doc?.pmDoc).toEqual(candidateBase);

    await emitFrames(stream, [
      toolCallUpdatedFrame(spec),
      docStateFrame("pendingReview"),
    ]);
    expect(document.body.dataset.content).toBe("pendingReview");
    expect(host?.textContent).toContain("剩余 · 1 处");
    expect(document.body.textContent).not.toContain("文档已生成新版本");
  }, 60_000);

  it("含图候选进入 pendingReview 后同基线 canonical 快照迟到，不误报冲突也不清候选", async () => {
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
    const baseDoc = pmDoc([
      pmParagraph("article-title", "夏日散步"),
      pmParagraph("article-body", "沿着河岸慢慢走。"),
    ]);
    const imageBlock: PmBlockNode = {
      type: "image",
      attrs: {
        blockId: "article-image",
        src: "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/summer.svg",
        alt: "河岸夏景",
        caption: "傍晚的河岸",
        width: 800,
        height: 450,
        align: "center",
      },
    };
    const candidateDoc = pmDoc([...baseDoc.content, imageBlock]);
    const hunk: DiffHunk = {
      hunkId: "article-image-hunk",
      reviewBatchId: "batch-article-image",
      groupMode: "atomic",
      op: "insert",
      blockPath: [2],
      anchor: { blockId: "article-body", gravity: "after" },
      before: null,
      after: [imageBlock] as never,
      summary: "插入文章配图",
      afterText: "河岸夏景",
    };
    const suggestion = blockSuggestion("article-image-hunk", hunk);
    const spec: ToolCallSpec = {
      ...reviewToolCall("article-image-hunk", "batch-article-image", "reviewing"),
      body: {
        kind: "docSuggestion",
        data: { kind: "suggestion", data: suggestion },
      },
    };

    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "含图候选" } },
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(baseDoc, 1) },
      },
      docStateFrame("editing"),
      {
        kind: "docDiffReady",
        data: {
          baseVersion: 1,
          suggestions: [suggestion],
          previewDoc: baseDoc,
          editedDoc: candidateDoc,
          wholeDocument: true,
        },
      },
      toolCallUpdatedFrame(spec),
      docStateFrame("pendingReview"),
    ]);
    await flushMicrotasks(5);

    const editor = captured.current?.tiptapEditor;
    expect(editor).not.toBeNull();
    expect(captured.current?.state.docDiff).not.toBeNull();
    expect(selectPatches(captured.current!.state)).toHaveLength(1);

    // 复现 r48：审阅展示已经切到含图候选，随后只读内部投影把 live PM 拉回
    // canonical base。没有任何用户编辑或保存事务，但旧 dirty 规则会把它看成差异。
    act(() => {
      editor!.commands.setContent(baseDoc);
    });
    expect(updateDocCommands(stream)).toHaveLength(0);
    expect(
      captured.current?.docViewRef.current?.hasLocalDocumentChanges(),
    ).toBe(true);
    expect(
      captured.current?.docViewRef.current?.canSafelyApplyIncomingDocument(baseDoc),
    ).toBe(true);

    await emitFrames(stream, [{
      kind: "documentSnapshotWritten",
      data: { doc: wireSnapshotFromPmDoc(baseDoc, 1) },
    }]);

    expect(captured.current?.state.streamError).toBeNull();
    expect(captured.current?.state.docDiff).not.toBeNull();
    expect(selectPatches(captured.current!.state)).toHaveLength(1);
    expect(document.body.dataset.content).toBe("pendingReview");
    expect(document.body.textContent).not.toContain("文档已生成新版本");
  }, 60_000);

  it("含多图整篇候选经 HTML 揭示投影后同基线 canonical 迟到，不误报冲突", async () => {
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
    const imageSrc = (index: number) =>
      `/api/v1/files/550e8400-e29b-41d4-a716-446655440000/commute-${index}.svg`;
    const images = Array.from({ length: 4 }, (_, index): PmBlockNode => ({
      type: "image",
      attrs: {
        blockId: `commute-image-${index}`,
        src: imageSrc(index),
        alt: `城市通勤插图 ${index + 1}`,
        caption: index % 2 === 0 ? `通勤场景 ${index + 1}` : null,
        width: index % 2 === 0 ? 720 : null,
        height: index % 2 === 0 ? 405 : null,
        align: index === 1 ? "left" : index === 3 ? "right" : "center",
      },
    }));
    const baseDoc = pmDoc([
      pmParagraph("commute-title", "城市通勤指南"),
      images[0]!,
      pmParagraph("commute-body-1", "错峰出行能避开拥堵。"),
      images[1]!,
      pmParagraph("commute-body-2", "地铁与骑行可以灵活接驳。"),
      images[2]!,
      pmParagraph("commute-body-3", "提前规划换乘路线。"),
      images[3]!,
    ]);
    const editedDoc = pmDoc([
      pmParagraph("commute-title", "更轻松的城市通勤"),
      ...baseDoc.content.slice(1),
    ]);
    const hunk: DiffHunk = {
      hunkId: "commute-whole-document",
      reviewBatchId: "batch-commute-whole-document",
      groupMode: "atomic",
      op: "replace",
      blockPath: [0],
      anchor: {
        blockId: "commute-title",
        anchorKind: "position",
        gravity: "before",
      },
      before: baseDoc.content as never,
      after: editedDoc.content as never,
      summary: "整篇改写并保留城市通勤插图",
      beforeText: "城市通勤指南",
      afterText: "更轻松的城市通勤",
    };
    const suggestion = blockSuggestion("commute-whole-document", hunk);
    const spec: ToolCallSpec = {
      ...reviewToolCall(
        "commute-whole-document",
        "batch-commute-whole-document",
        "reviewing",
      ),
      body: {
        kind: "docSuggestion",
        data: { kind: "suggestion", data: suggestion },
      },
    };

    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "多图整篇候选" } },
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(baseDoc, 1) },
      },
      docStateFrame("editing"),
      {
        kind: "docDiffReady",
        data: {
          baseVersion: 1,
          suggestions: [suggestion],
          previewDoc: baseDoc,
          editedDoc,
          wholeDocument: true,
        },
      },
      toolCallUpdatedFrame(spec),
      docStateFrame("pendingReview"),
    ]);
    await flushMicrotasks(5);

    const editor = captured.current?.tiptapEditor;
    expect(editor).not.toBeNull();
    expect(captured.current?.state.docDiff).not.toBeNull();
    expect(selectPatches(captured.current!.state)).toHaveLength(1);

    // 整篇揭示走 HTML 中间态；image renderHTML 未透传全局 data-block-id，
    // 因此 live 图片节点只有身份缺失，正文、顺序与持久属性仍和 canonical 一致。
    act(() => {
      editor!.commands.setContent(`
        <p data-block-id="commute-title">城市通勤指南</p>
        <img src="${imageSrc(0)}" alt="城市通勤插图 1" data-caption="通勤场景 1" width="720" height="405" data-align="center" />
        <p data-block-id="commute-body-1">错峰出行能避开拥堵。</p>
        <img src="${imageSrc(1)}" alt="城市通勤插图 2" data-align="left" />
        <p data-block-id="commute-body-2">地铁与骑行可以灵活接驳。</p>
        <img src="${imageSrc(2)}" alt="城市通勤插图 3" data-caption="通勤场景 3" width="720" height="405" data-align="center" />
        <p data-block-id="commute-body-3">提前规划换乘路线。</p>
        <img src="${imageSrc(3)}" alt="城市通勤插图 4" data-align="right" />
      `);
    });
    await flushMicrotasks(5);
    expect(updateDocCommands(stream)).toHaveLength(0);
    expect(captured.current?.docViewRef.current?.hasLocalDocumentChanges()).toBe(true);

    await emitFrames(stream, [{
      kind: "documentSnapshotWritten",
      data: { doc: wireSnapshotFromPmDoc(baseDoc, 1) },
    }]);

    expect(captured.current?.state.streamError).toBeNull();
    expect(captured.current?.state.docDiff).not.toBeNull();
    expect(selectPatches(captured.current!.state)).toHaveLength(1);
    expect(document.body.dataset.content).toBe("pendingReview");
    expect(document.body.textContent).not.toContain("文档已生成新版本");
  }, 60_000);

  it("表格单元格 patch 候选同基线 canonical 静默吸收，真实单元格分叉仍报冲突", async () => {
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
    const baseTable = pmTable("commute-table", [
      ["交通工具", "月成本"],
      ["公交", "约120元"],
    ]);
    const editedTable = pmTable("commute-table", [
      ["交通工具", "月成本"],
      ["公交", "约150元"],
    ]);
    const baseDoc = pmDoc([baseTable]);
    const candidateDoc = pmDoc([editedTable]);
    const hunk: DiffHunk = {
      hunkId: "commute-table-cost",
      reviewBatchId: "batch-commute-table-cost",
      groupMode: "independent",
      op: "replace",
      blockPath: [0],
      anchor: { blockId: "commute-table", anchorKind: "position", gravity: "before" },
      before: [baseTable] as never,
      after: [editedTable] as never,
      summary: "更新公交月成本",
      beforeText: "约120元",
      afterText: "约150元",
    };
    const suggestion = blockSuggestion("commute-table-cost", hunk);
    const spec: ToolCallSpec = {
      ...reviewToolCall("commute-table-cost", "batch-commute-table-cost", "reviewing"),
      body: {
        kind: "docSuggestion",
        data: { kind: "suggestion", data: suggestion },
      },
    };

    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "表格单格候选" } },
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(baseDoc, 1) },
      },
      docStateFrame("editing"),
      {
        kind: "docDiffReady",
        data: {
          baseVersion: 1,
          suggestions: [suggestion],
          previewDoc: baseDoc,
          editedDoc: candidateDoc,
        },
      },
      toolCallUpdatedFrame(spec),
      docStateFrame("pendingReview"),
    ]);
    await flushMicrotasks(5);

    const editor = captured.current?.tiptapEditor;
    expect(editor).not.toBeNull();
    expect(captured.current?.state.docDiff).not.toBeNull();
    expect(selectPatches(captured.current!.state)).toHaveLength(1);
    expect(
      captured.current?.docViewRef.current?.hasLocalDocumentChanges(),
    ).toBe(true);
    // TipTap 会给普通格补 colspan=1/rowspan=1，并在末尾表格后补一个
    // blockId=null 的空段落脚手架；两者都不是 canonical 正文改动。
    expect(
      captured.current?.docViewRef.current?.canSafelyApplyIncomingDocument(baseDoc),
    ).toBe(true);

    await emitFrames(stream, [{
      kind: "documentSnapshotWritten",
      data: { doc: wireSnapshotFromPmDoc(baseDoc, 1) },
    }]);

    expect(captured.current?.state.streamError).toBeNull();
    expect(captured.current?.state.docDiff).not.toBeNull();
    expect(selectPatches(captured.current!.state)).toHaveLength(1);
    expect(document.body.dataset.content).toBe("pendingReview");
    expect(document.body.textContent).not.toContain("文档已生成新版本");

    const locallyEditedDoc = pmDoc([pmTable("commute-table", [
      ["交通工具", "月成本"],
      ["公交", "约130元"],
    ])]);
    const serverNewDoc = pmDoc([pmTable("commute-table", [
      ["交通工具", "月成本"],
      ["公交", "约160元"],
    ])]);
    act(() => {
      editor!.commands.setContent(locallyEditedDoc);
    });
    await flushMicrotasks(5);
    expect(updateDocCommands(stream)).toHaveLength(0);
    expect(
      captured.current?.docViewRef.current?.canSafelyApplyIncomingDocument(serverNewDoc),
    ).toBe(false);

    await emitFrames(stream, [{
      kind: "documentSnapshotWritten",
      data: { doc: wireSnapshotFromPmDoc(serverNewDoc, 2) },
    }]);

    expect(captured.current?.state.streamError).toMatchObject({
      kind: "docWriteConflict",
      actualDocumentSnapshot: 2,
    });
    expect(selectPatches(captured.current!.state)).toHaveLength(1);
    expect(document.body.textContent).toContain("文档已生成新版本");
  }, 60_000);

  it("generation_finished 撞上 400ms 本地 debounce 时先 drain 保存再自动回灌终稿", async () => {
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
    const initialDoc = pmDoc([pmParagraph("p-echo", "旧正文")]);
    const localDebouncedDoc = pmDoc([pmParagraph("p-echo", "本地 debounce 正文")]);
    const finalDoc = pmDoc([pmParagraph("p-echo-final", "Agent 权威终稿")]);
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "终稿回显" } },
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(initialDoc, 7) },
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
      editor!.commands.setContent(localDebouncedDoc);
    });
    expect(updateDocCommands(stream)).toHaveLength(0);

    await emitFrames(stream, [
      {
        kind: "stream",
        data: { kind: "start", data: { streamId: "stream-echo" } },
      },
      {
        kind: "docGenerationEvent",
        data: {
          kind: "generation_finished",
          data: {
            generationId: "gen-echo",
            seq: 2,
            prevSeq: 1,
            doc: finalDoc,
            finalVersion: 9,
            contentHash: getPmContentHash(finalDoc),
          },
        },
      },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushMicrotasks(8);

    // 终稿到达时 debounce 被主动 flush；私有保存先推进到 v8，随后延迟帧
    // 自动重放到 v9，既不覆盖未发送编辑，也不需要路由切换恢复。
    expect(updateDocCommands(stream)).toHaveLength(1);
    expect(JSON.stringify(updateDocCommands(stream)[0]?.data.doc)).toContain(
      "本地 debounce 正文",
    );
    expect(captured.current?.state.version).toBe(9);
    expect(captured.current?.state.doc?.pmDoc).toEqual(finalDoc);
    expect(captured.current?.state.streamError).toBeNull();

    await emitFrames(stream, [{
      kind: "stream",
      data: {
        kind: "end",
        data: {
          streamId: "stream-echo",
          reason: { kind: "done" },
          finalDocument: {
            version: 9,
            contentHash: getPmContentHash(finalDoc),
            doc: finalDoc,
          },
        },
      },
    }]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushMicrotasks(5);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flushMicrotasks(5);
    expect(captured.current?.state.activeStreamIds).toEqual([]);
    expect(captured.current?.state.streamActive).toBe(false);
    expect(captured.current?.state.agentBusy).toBe(false);
    expect(captured.current?.agentActive).toBe(false);
    expect(captured.current?.effectivePresentationRun).toBeNull();
    expect(
      JSON.stringify(captured.current?.tiptapEditor?.getJSON()),
    ).toContain("Agent 权威终稿");
  }, 60_000);

  it("缺失 generation_finished 时 end.finalDocument 仍当场回显并解除发送锁", async () => {
    window.location.hash = "#/workspace?session=s-1";
    const [
      { useWorkspacePageController },
      { WorkspaceDocumentPane },
      { WorkspaceChatPane },
    ] = await Promise.all([
      import("./WorkspacePage"),
      import("./components/WorkspaceDocumentPane"),
      import("./components/WorkspaceChatPane"),
    ]);
    const captured: {
      current: ReturnType<typeof useWorkspacePageController> | null;
    } = { current: null };
    function ControllerHarness() {
      const controller = useWorkspacePageController();
      captured.current = controller;
      return (
        <>
          <WorkspaceDocumentPane controller={controller} />
          <WorkspaceChatPane controller={controller} />
        </>
      );
    }
    await render(<ControllerHarness />);
    const stream = latestServerStream();
    const initialDoc = pmDoc([pmParagraph("p-receipt-old", "旧正文")]);
    const finalDoc = pmDoc([pmParagraph("p-receipt-final", "只从终态收据恢复的正文")]);
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "终态兜底" } },
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(initialDoc, 3) },
      },
      {
        kind: "stream",
        data: { kind: "start", data: { streamId: "stream-receipt-only" } },
      },
      {
        kind: "stream",
        data: {
          kind: "end",
          data: {
            streamId: "stream-receipt-only",
            reason: { kind: "done" },
            finalDocument: {
              version: 4,
              contentHash: getPmContentHash(finalDoc),
              doc: finalDoc,
            },
          },
        },
      },
    ]);
    await flushMicrotasks(8);

    expect(captured.current?.state.version).toBe(4);
    expect(captured.current?.state.doc?.pmDoc).toEqual(finalDoc);
    expect(JSON.stringify(captured.current?.tiptapEditor?.getJSON())).toContain(
      "只从终态收据恢复的正文",
    );
    expect(captured.current?.state.activeStreamIds).toEqual([]);
    expect(captured.current?.state.streamActive).toBe(false);
    expect(captured.current?.state.agentBusy).toBe(false);
    expect(captured.current?.state.docState).toEqual({ kind: "editing" });
    expect(captured.current?.agentActive).toBe(false);
    expect(
      [...(host?.querySelectorAll("button") ?? [])].some(
        (button) => button.textContent?.trim() === "发送",
      ),
    ).toBe(true);
  }, 60_000);

  it("end.finalDocument 与 drain 后的新本地编辑真冲突时保留本地正文但仍结束 stream", async () => {
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
    const initialDoc = pmDoc([pmParagraph("p-conflict-old", "旧正文")]);
    const firstLocalDoc = pmDoc([pmParagraph("p-conflict-old", "第一笔本地编辑")]);
    const secondLocalDoc = pmDoc([pmParagraph("p-conflict-old", "保存冲突后的新本地编辑")]);
    const finalDoc = pmDoc([pmParagraph("p-conflict-final", "服务器 Agent 终稿")]);
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "终稿冲突" } },
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(initialDoc, 5) },
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
    stream.sendCommand.mockImplementation(async (command: Command) => {
      if (command.kind !== "updateDoc") return;
      stream.emit({
        kind: "docWriteResult",
        data: {
          ok: false,
          clientMutationId: command.data.clientMutationId,
          conflict: {
            expectedDocumentSnapshot:
              command.data.expectedDocumentSnapshot,
            actualDocumentSnapshot: 6,
          },
        },
      });
    });

    act(() => {
      editor!.commands.setContent(firstLocalDoc);
    });
    await emitFrames(stream, [
      {
        kind: "stream",
        data: { kind: "start", data: { streamId: "stream-conflict" } },
      },
      {
        kind: "stream",
        data: {
          kind: "end",
          data: {
            streamId: "stream-conflict",
            reason: { kind: "done" },
            finalDocument: {
              version: 7,
              contentHash: getPmContentHash(finalDoc),
              doc: finalDoc,
            },
          },
        },
      },
    ]);
    await flushMicrotasks(8);

    // debounce 被终态帧主动 flush，但服务端确认 canonical 已分叉；保存 drain
    // 明确失败后又发生一笔本地编辑，必须升级为显式冲突，不能覆盖也不能重新 defer。
    act(() => {
      editor!.commands.setContent(secondLocalDoc);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushMicrotasks(8);

    expect(JSON.stringify(editor!.getJSON())).toContain("保存冲突后的新本地编辑");
    expect(JSON.stringify(editor!.getJSON())).not.toContain("服务器 Agent 终稿");
    expect(captured.current?.state.streamError).toMatchObject({
      kind: "docWriteConflict",
      actualDocumentSnapshot: 7,
      action: "reload",
    });
    expect(captured.current?.state.activeStreamIds).toEqual([]);
    expect(captured.current?.state.streamActive).toBe(false);
    expect(captured.current?.state.agentBusy).toBe(false);
    expect(captured.current?.agentActive).toBe(false);
  }, 60_000);

  it("presentation 动画异常不前进时由 65 秒上限 watchdog 强制收口到 final PM", async () => {
    window.location.hash = "#/workspace?session=s-1";
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string): MediaQueryList => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    const [
      { useWorkspacePageController },
      { resetNativePresentationConfigForTest },
    ] = await Promise.all([
      import("./WorkspacePage"),
      import("./data/presentationRuntimeConfig"),
    ]);
    resetNativePresentationConfigForTest({ maxDurationMs: 60_000 }, null);
    const captured: {
      current: ReturnType<typeof useWorkspacePageController> | null;
    } = { current: null };
    function ControllerHarness() {
      const controller = useWorkspacePageController();
      captured.current = controller;
      return <div data-watchdog-harness />;
    }
    await render(<ControllerHarness />);
    const stream = latestServerStream();
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "动画看门狗" } },
      {
        kind: "docStateChanged",
        data: { state: { kind: "drafting" }, activeOverlay: null, agentBusy: true },
      },
      {
        kind: "stream",
        data: { kind: "start", data: { streamId: "stream-watchdog" } },
      },
    ]);
    await flushMicrotasks(5);
    vi.useFakeTimers();
    const finalDoc = pmDoc([
      pmParagraph("p-watchdog-final", "强制收口后必须保留的 final PM".repeat(20_000)),
    ]);
    await emitFrames(stream, [{
      kind: "docGenerationEvent",
      data: {
        kind: "generation_finished",
        data: {
          generationId: "gen-watchdog",
          seq: 2,
          prevSeq: 1,
          doc: finalDoc,
          finalVersion: 11,
          contentHash: getPmContentHash(finalDoc),
        },
      },
    }]);
    await flushMicrotasks(5);

    expect(captured.current?.effectivePresentationRun).not.toBeNull();
    expect(captured.current?.state.doc?.pmDoc).toEqual(finalDoc);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(63_999);
    });
    expect(captured.current?.effectivePresentationRun).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flushMicrotasks(5);
    expect(captured.current?.effectivePresentationRun).toBeNull();
    expect(captured.current?.state.doc?.pmDoc).toEqual(finalDoc);
  }, 60_000);

  it("干净外标签照常同步 snapshotWritten 的版本与正文", async () => {
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
    const initialDoc = pmDoc([pmParagraph("p-clean", "旧正文")]);
    const remoteDoc = pmDoc([pmParagraph("p-clean", "另一标签的新正文")]);
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "干净同步" } },
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(initialDoc, 7) },
      },
      {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
      },
    ]);
    await flushMicrotasks(5);
    const editor = captured.current?.tiptapEditor;
    expect(editor).not.toBeNull();

    await emitFrames(stream, [
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(remoteDoc, 8) },
      },
    ]);
    await flushMicrotasks(5);

    expect(captured.current?.state.version).toBe(8);
    expect(captured.current?.state.doc?.pmDoc).toEqual(remoteDoc);
    expect(JSON.stringify(editor!.getJSON())).toContain("另一标签的新正文");

    const afterSyncDoc = pmDoc([pmParagraph("p-clean", "同步后继续编辑")]);
    await act(async () => {
      await captured.current!.handleEditorChange(afterSyncDoc);
    });
    const saveAfterSync = updateDocCommands(stream)[0];
    expect(saveAfterSync?.data.expectedDocumentSnapshot).toBe(8);
    expect(saveAfterSync?.data.baseContentHash).toBe(getPmContentHash(remoteDoc));
  }, 60_000);

  it("客户端持空稿旧基线推送遇 agent 已写版本时静默 reconcile 到权威正文", async () => {
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
    const staleEmptyDoc = pmDoc([pmParagraph("p-empty-local", "")]);
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "空白会话" } },
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(staleEmptyDoc, 0) },
      },
      {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
      },
    ]);
    await flushMicrotasks(5);
    const editor = captured.current?.tiptapEditor;
    expect(editor).not.toBeNull();

    const agentDoc = pmDoc([
      {
        type: "diagram",
        attrs: {
          blockId: "diagram-agent",
          lang: "mermaid",
          source: "flowchart LR\nA --> B",
          title: "Agent 流程图",
        },
      } as unknown as PmBlockNode,
    ]);
    stream.sendCommand.mockImplementation(async (command: Command) => {
      if (command.kind !== "updateDoc") return;
      stream.emit({
        kind: "docWriteResult",
        data: {
          ok: false,
          clientMutationId: command.data.clientMutationId,
          conflict: {
            expectedDocumentSnapshot: command.data.expectedDocumentSnapshot,
            actualDocumentSnapshot: 1,
          },
        },
      });
    });
    stream.startSession.mockClear();
    stream.startSession.mockImplementation(async () => {
      for (const frame of [
        {
          kind: "restoreReset",
          data: { epoch: 1, snapshotSeq: 10 },
        },
        { kind: "sessionMeta", data: { sessionId: "s-1", title: "空白会话" } },
        {
          kind: "documentSnapshotWritten",
          data: { doc: wireSnapshotFromPmDoc(agentDoc, 1) },
        },
        {
          kind: "docStateChanged",
          data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
        },
        { kind: "sessionRestoreCompleted", data: { sessionId: "s-1" } },
      ] satisfies BridgeFrame[]) {
        stream.emit(frame);
      }
      return "s-1";
    });

    // 模拟 debounce 中保存项产生于版本 0，但真正发包时服务端 agent 已推进到版本 1。
    await act(async () => {
      await captured.current!.handleEditorChange(staleEmptyDoc, {
        expectedDocumentSnapshot: 0,
        baseContentHash: getPmContentHash(staleEmptyDoc),
        baseHasSubstantiveContent: false,
      });
    });
    await flushMicrotasks(5);

    const staleWrite = updateDocCommands(stream)[0];
    expect(staleWrite?.data.expectedDocumentSnapshot).toBe(0);
    expect(staleWrite?.data.baseContentHash).toBe(
      getPmContentHash(staleEmptyDoc),
    );
    expect(captured.current?.state.version).toBe(1);
    expect(captured.current?.state.doc?.pmDoc).toEqual(agentDoc);
    expect(JSON.stringify(editor!.getJSON())).toContain("flowchart LR");
    expect(captured.current?.state.streamError).toBeNull();
    expect(stream.startSession).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("单标签保存仍由本标签 docWriteResult 正常推进版本", async () => {
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
    const stream = latestServerStream();
    const initialDoc = pmDoc([pmParagraph("p-own", "保存前")]);
    const savedDoc = pmDoc([pmParagraph("p-own", "本标签保存后")]);
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "单标签保存" } },
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(initialDoc, 7) },
      },
      {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
      },
    ]);

    await act(async () => {
      await captured.current!.handleEditorChange(savedDoc);
    });
    await flushMicrotasks(3);

    expect(updateDocCommands(stream)[0]?.data.expectedDocumentSnapshot).toBe(7);
    expect(updateDocCommands(stream)[0]?.data.baseContentHash).toBe(
      getPmContentHash(initialDoc),
    );
    expect(captured.current?.state.version).toBe(8);
    expect(captured.current?.state.doc?.pmDoc).toEqual(savedDoc);
  }, 60_000);

  it("断网保存连续失败后，online 会自动重发并推进服务端版本", async () => {
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
    const stream = latestServerStream();
    const initialDoc = pmDoc([pmParagraph("p-offline", "保存前")]);
    const offlineEditedDoc = pmDoc([pmParagraph("p-offline", "断网期间的新正文")]);
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "离线自动重存" } },
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(initialDoc, 1) },
      },
      {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
      },
    ]);

    let sendAttempt = 0;
    stream.sendCommand.mockImplementation(async (command: Command) => {
      if (command.kind !== "updateDoc") return;
      sendAttempt += 1;
      if (sendAttempt <= 3) throw new TypeError("Failed to fetch");
      stream.emit({
        kind: "docWriteResult",
        data: {
          ok: true,
          clientMutationId: command.data.clientMutationId,
          docVersion: 2,
        },
      });
    });

    vi.useFakeTimers();
    const failedSave: Promise<Error | null> = captured.current!
      .handleEditorChange(offlineEditedDoc)
      .then(() => null)
      .catch((error: unknown) =>
        error instanceof Error ? error : new Error(String(error))
      );
    await flushMicrotasks(3);
    expect(updateDocCommands(stream)).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(updateDocCommands(stream)).toHaveLength(2);

    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await failedSave).toBeInstanceOf(Error);
    expect(updateDocCommands(stream)).toHaveLength(3);
    expect(captured.current?.state.version).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushMicrotasks(3);

    const retryCommand = updateDocCommands(stream)[3];
    expect(retryCommand?.data.expectedDocumentSnapshot).toBe(1);
    expect(retryCommand?.data.baseContentHash).toBe(getPmContentHash(initialDoc));
    expect(retryCommand?.data.doc).toEqual(offlineEditedDoc);
    expect(captured.current?.state.version).toBe(2);
    expect(captured.current?.state.doc?.pmDoc).toEqual(offlineEditedDoc);
  }, 60_000);

  it("用户显式将多块长文档改写为短文时仍发送 updateDoc", async () => {
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
    const stream = latestServerStream();
    const baseline = pmDoc([
      pmParagraph("p-1", "季度销量与目标对比的完整说明正文"),
      pmParagraph("p-2", "Q1 到 Q4 的数据表和配图均应保留"),
      pmParagraph("p-3", "修改单元格时绝不能删除其余文档内容"),
    ]);
    const collapsed = pmDoc([pmHeading("damaged-heading", "300")]);
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "全文改写" } },
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(baseline, 7) },
      },
      {
        kind: "docStateChanged",
        data: {
          state: { kind: "editing" },
          activeOverlay: null,
          agentBusy: false,
        },
      },
    ]);

    await act(async () => {
      await captured.current!.handleEditorChange(collapsed);
    });
    await flushMicrotasks(3);

    expect(updateDocCommands(stream)).toHaveLength(1);
    expect(updateDocCommands(stream)[0]?.data.doc).toEqual(collapsed);
    expect(captured.current?.state.version).toBe(8);
    expect(captured.current?.state.doc?.pmDoc).toEqual(collapsed);
  }, 60_000);

  it("no-op 保存回执保持当前版本，下一次真实编辑沿用一致的版本与哈希基线", async () => {
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
    const stream = latestServerStream();
    const initialDoc = pmDoc([pmParagraph("p-noop", "未修改正文")]);
    const changedDoc = pmDoc([pmParagraph("p-noop", "确有修改正文")]);
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "no-op 保存" } },
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(initialDoc, 7) },
      },
      {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
      },
    ]);

    let writeCount = 0;
    stream.sendCommand.mockImplementation(async (command: Command) => {
      if (command.kind !== "updateDoc") return;
      writeCount += 1;
      stream.emit({
        kind: "docWriteResult",
        data: {
          ok: true,
          clientMutationId: command.data.clientMutationId,
          docVersion:
            writeCount === 1
              ? command.data.expectedDocumentSnapshot
              : command.data.expectedDocumentSnapshot + 1,
        },
      });
    });

    await act(async () => {
      await captured.current!.handleEditorChange(initialDoc);
    });
    await flushMicrotasks(3);

    expect(updateDocCommands(stream)[0]?.data.expectedDocumentSnapshot).toBe(7);
    expect(captured.current?.state.version).toBe(7);
    expect(captured.current?.state.doc?.pmDoc).toEqual(initialDoc);

    await act(async () => {
      await captured.current!.handleEditorChange(changedDoc);
    });
    await flushMicrotasks(3);

    const realSave = updateDocCommands(stream)[1];
    expect(realSave?.data.expectedDocumentSnapshot).toBe(7);
    expect(realSave?.data.baseContentHash).toBe(getPmContentHash(initialDoc));
    expect(captured.current?.state.version).toBe(8);
    expect(captured.current?.state.doc?.pmDoc).toEqual(changedDoc);
  }, 60_000);

  it("A1: B 延迟 400ms 时切会话，后台在 B 成功后以 N+1 保存 C", async () => {
    window.location.hash = "#/workspace?session=s-1";
    const [{ useWorkspacePageController }, { WorkspaceDocumentPane }] = await Promise.all([
      import("./WorkspacePage"),
      import("./components/WorkspaceDocumentPane"),
    ]);
    const captured: { current: ReturnType<typeof useWorkspacePageController> | null } = { current: null };
    function ControllerHarness() {
      const controller = useWorkspacePageController();
      captured.current = controller;
      return <WorkspaceDocumentPane controller={controller} />;
    }
    await render(<ControllerHarness />);
    const oldStream = latestServerStream();
    await emitFrames(oldStream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "旧会话" } },
      { kind: "documentSnapshotWritten", data: { doc: wireSnapshotFromPmDoc(pmDoc([pmParagraph("p-switch-save", "旧正文")]), 1) } },
      { kind: "docStateChanged", data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false } },
    ]);
    await flushMicrotasks(5);
    const editor = captured.current?.tiptapEditor;
    expect(editor).not.toBeNull();
    const initialDoc = pmDoc([pmParagraph("p-switch-save", "旧正文")]);
    const pendingDoc = pmDoc([pmParagraph("p-switch-save", "在途正文 B")]);
    const latestDoc = pmDoc([pmParagraph("p-switch-save", "最新正文 C")]);
    oldStream.sendCommand.mockImplementation((command: Command) => {
      if (command.kind !== "updateDoc") return Promise.resolve();
      return new Promise<void>((resolve) => {
        window.setTimeout(() => {
          oldStream.emit({
            kind: "docWriteResult",
            data: {
              ok: true,
              clientMutationId: command.data.clientMutationId,
              docVersion: 2,
            },
          });
          resolve();
        }, 400);
      });
    });
    const sendBeacon = vi.fn((_url: string, _data?: BodyInit | null) => true);
    const originalSendBeacon = navigator.sendBeacon;
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: sendBeacon });
    const backgroundCommands: Array<
      Extract<Command, { kind: "updateDoc" }>
    > = [];
    const backgroundFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as
        | Extract<Command, { kind: "updateDoc" }>
        | { events?: unknown[] };
      if (!("kind" in body) || body.kind !== "updateDoc") {
        return new Response("{}", { status: 200 });
      }
      const command = body;
      backgroundCommands.push(command);
      return new Response(JSON.stringify([{
        kind: "docWriteResult",
        data: {
          ok: true,
          clientMutationId: command.data.clientMutationId,
          docVersion: 3,
        },
      }]), { status: 200 });
    });
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: backgroundFetch,
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: backgroundFetch,
    });
    vi.useFakeTimers();

    try {
      const firstSave = captured.current!.handleEditorChange(pendingDoc);
      await flushMicrotasks(2);
      expect(updateDocCommands(oldStream)).toHaveLength(1);

      act(() => {
        editor!.commands.setContent(latestDoc);
        window.history.replaceState(null, "", "#/workspace?session=s-2");
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      await flushMicrotasks(5);

      expect(sendBeacon).not.toHaveBeenCalled();
      expect(latestServerStream()).not.toBe(oldStream);
      expect(oldStream.dispose).not.toHaveBeenCalled();
      expect(backgroundCommands).toHaveLength(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      await expect(firstSave).resolves.toBeUndefined();
      await flushMicrotasks(5);

      expect(updateDocCommands(oldStream)[0]?.data).toMatchObject({
        sessionId: "s-1",
        expectedDocumentSnapshot: 1,
        baseContentHash: getPmContentHash(initialDoc),
      });
      expect(backgroundCommands).toHaveLength(1);
      expect(backgroundCommands[0]?.data).toMatchObject({
        sessionId: "s-1",
        expectedDocumentSnapshot: 2,
        baseContentHash: getPmContentHash(pendingDoc),
      });
      expect(backgroundCommands[0]?.data.doc).toEqual(latestDoc);
      expect(oldStream.dispose).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: originalSendBeacon });
    }
  }, 60_000);

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

  it("已有正文开始新一轮生成时,空草稿不会在首块到达前遮住正文", async () => {
    const { RightPane } = await import("./WorkspacePage");
    const doc = pmDocToViewDocumentSnapshot(
      pmDoc([pmParagraph("busy-canonical", "生成前已有正文")]),
      8,
      "t-busy-canonical",
    );
    const emptyDraft = pmDocToViewDocumentSnapshot(pmDoc([]), 9, "t-busy-empty-draft");

    await render(
      <section id="view-workspace">
        <RightPane
          {...rightPaneProps({
            dimensions: reviewDimensions({
              content: { kind: "editing" },
              editor: "locked",
              overlay: null,
              agentBusy: true,
            }),
            doc,
            generationDraftDoc: emptyDraft,
            effectiveReview: false,
            remainingCount: 0,
            visiblePatchCount: 0,
          })}
        />
      </section>,
    );

    expect(host?.querySelector('[data-wf="DocumentSnapshotView"]')).not.toBeNull();
    expect(host?.textContent).toContain("生成前已有正文");
  });

  it("终态 editing 即使残留 generationDraft 也挂可编辑 canonical 面并自愈", async () => {
    const { RightPane } = await import("./WorkspacePage");
    const canonicalDoc = pmDocToViewDocumentSnapshot(
      pmDoc([pmParagraph("terminal-canonical", "已经落库的终稿")]),
      12,
      "t-terminal-canonical",
    );
    const staleDraft = pmDocToViewDocumentSnapshot(
      pmDoc([pmParagraph("stale-generation-draft", "不应继续展示的生成草稿")]),
      11,
      "t-stale-generation-draft",
    );

    await render(
      <section id="view-workspace">
        <RightPane
          {...rightPaneProps({
            dimensions: reviewDimensions({
              content: { kind: "editing" },
              editor: "editable",
              overlay: null,
              agentBusy: false,
            }),
            doc: canonicalDoc,
            generationDraftDoc: staleDraft,
            effectiveReview: false,
            remainingCount: 0,
            visiblePatchCount: 0,
          })}
        />
      </section>,
    );

    const editable = host?.querySelector<HTMLElement>(".ProseMirror.wf-doc");
    expect(editable).not.toBeNull();
    expect(editable?.getAttribute("contenteditable")).toBe("true");
    expect(host?.textContent).toContain("已经落库的终稿");
    expect(host?.textContent).not.toContain("不应继续展示的生成草稿");
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

  it("低于 70% 的整篇改写落入逐处审阅:无「全部应用」按钮,提交默认应用全部", async () => {
    const { deriveReviewRenderMode, RightPane } = await import("./WorkspacePage");
    const mode = deriveReviewRenderMode({
      effectiveReview: true,
      editedNewDoc: multiGroupDoc(7),
      changeRatio: 0.69,
      wholeDocReviewThreshold: 0.7,
    });
    const onAcceptAll = vi.fn();
    const onCommit = vi.fn();

    await render(
      <section id="view-workspace">
        <RightPane
          {...rightPaneProps({
            wholeDocReview: mode.wholeDocReview,
            effectiveReview: mode.inlinePatchReview,
            editedNewDoc: multiGroupDoc(7),
            onAcceptAll,
            onCommit,
          })}
        />
      </section>,
    );

    expect(mode.wholeDocReview).toBe(false);
    expect(host?.querySelector('[data-wf="WholeDocReviewNav"]')).toBeNull();
    expect(host?.querySelector('[data-wf="PatchNav"]')).not.toBeNull();

    // 「全部应用」已按用户拍板移除:提交本身默认应用未裁决的全部修改,逃生入口=提交
    expect(host?.textContent).not.toContain("全部应用");
    await clickButton("提交 ↵");

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onAcceptAll).not.toHaveBeenCalled();
  });

  it("后端标记整稿替换时不再受 70% 猜测阈值影响", async () => {
    const { deriveReviewRenderMode, RightPane } = await import("./WorkspacePage");
    const editedDoc = multiGroupDoc(7);
    const mode = deriveReviewRenderMode({
      effectiveReview: true,
      editedNewDoc: editedDoc,
      changeRatio: 0.01,
      wholeDocReviewThreshold: 0.7,
      wholeDocument: true,
    });

    await render(
      <section id="view-workspace">
        <RightPane
          {...rightPaneProps({
            wholeDocReview: mode.wholeDocReview,
            effectiveReview: mode.inlinePatchReview,
            editedNewDoc: editedDoc,
          })}
        />
      </section>,
    );

    expect(mode.wholeDocReview).toBe(true);
    expect(mode.inlinePatchReview).toBe(false);
    expect(host?.querySelector('[data-wf="WholeDocReviewNav"]')).not.toBeNull();
    expect(host?.querySelector('[data-wf="PatchNav"]')).toBeNull();
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

  it("ReviewOutcomeCard 每处修改横排为原文箭头新文，单条目不渲染分隔线", async () => {
    const { ReviewOutcomeCard } = await import("./components/ReviewOutcomeCard");

    await render(
      <ReviewOutcomeCard
        data={{
          acceptedCount: 0,
          rejectedCount: 1,
          hunks: [{
            verdict: "rejected",
            blockSummary: "职业替换",
            beforeText: "人",
            afterText: "司机",
          }],
        }}
      />,
    );
    const header = host!.querySelector<HTMLButtonElement>(".u-card-hd");
    act(() => {
      header!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const row = host!.querySelector<HTMLElement>(".wf-rvo-row");
    expect(row).not.toBeNull();
    expect(row!.querySelector(".wf-rvo-verdict")?.textContent).toBe("已拒绝");
    expect(row!.querySelector(".wf-rvo-before")?.textContent).toBe("人");
    expect(row!.querySelector(".wf-rvo-arrow")?.textContent).toBe("→");
    expect(row!.querySelector(".wf-rvo-after")?.textContent).toBe("司机");
    expect(row!.querySelector(".wf-rvo-before")?.getAttribute("title")).toBe("人");
    expect(row!.querySelector(".wf-rvo-after")?.getAttribute("title")).toBe("司机");
    expect(row!.classList.contains("wf-rvo-row--divided")).toBe(false);
  });

  it("ReviewOutcomeCard 用紧凑占位文案表达纯新增与纯删除", async () => {
    const { ReviewOutcomeCard } = await import("./components/ReviewOutcomeCard");

    await render(
      <ReviewOutcomeCard
        data={{
          acceptedCount: 1,
          rejectedCount: 1,
          hunks: [
            { verdict: "accepted", blockSummary: "补充职业", beforeText: "", afterText: "司机" },
            { verdict: "rejected", blockSummary: "删除称谓", beforeText: "先生", afterText: "" },
          ],
        }}
      />,
    );
    const header = host!.querySelector<HTMLButtonElement>(".u-card-hd");
    act(() => {
      header!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const rows = [...host!.querySelectorAll<HTMLElement>(".wf-rvo-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toBe("已采纳（新增）→司机");
    expect(rows[1]!.textContent).toBe("已拒绝先生→（删除）");
  });

  it("失效 suggestion 的失败终态在聊天中只显示中性短文案", async () => {
    const { ChatMessageList } = await import("./components/ChatMessageList");
    const failedSpec: ToolCallSpec = {
      ...reviewToolCall("p-invalid", "batch-invalid", "reviewing"),
      status: {
        kind: "failed",
        data: {
          retriable: false,
          reason: "目标位置已被前序修改改变,该条已失效,未写入",
        },
      },
    };
    const messages: ChatMessage[] = [{
      id: "m-invalid",
      role: { kind: "agent" },
      ts: "2026-07-19T00:00:00.000Z",
      parts: [{ kind: "toolCall", data: failedSpec }],
      chips: null,
    }];

    await render(<ChatMessageList messages={messages} streamActive={false} />);

    expect(host?.textContent).toContain("修改未完成");
    expect(host?.textContent).not.toContain("目标位置已被前序修改改变");
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

  it("放弃全部在服务端确认前保持锁定，成功后才清理候选并解锁", async () => {
    const stream = await renderWorkspaceWithReview([
      textReviewToolCall("p-1", "batch-a", 0),
    ]);
    const pendingCommit = mockPendingCommit(stream);

    expect(getChatEditor().getAttribute("contenteditable")).toBe("false");

    await clickButton("放弃全部");
    await clickButton("确认放弃全部");

    expect(stream.commitReviewGroups).toHaveBeenCalledTimes(1);
    expect(getChatEditor().getAttribute("contenteditable")).toBe("false");
    expect(host?.querySelector('[data-wf="PatchNav"]')).not.toBeNull();

    await act(async () => {
      pendingCommit.resolve([docStateFrame("editing")]);
      await pendingCommit.promise;
    });
    await flushMicrotasks();

    expect(getChatEditor().getAttribute("contenteditable")).toBe("true");
  });

  it("pendingReview 有候选但正文锚点失配时仍可提交或放弃", async () => {
    const { WorkspacePage } = await import("./WorkspacePage");
    await render(<WorkspacePage />);
    const stream = latestServerStream();
    const patch = textReviewToolCall("p-missing", "batch-missing", 0);
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "测试审阅脱困" } },
      {
        kind: "documentSnapshotWritten",
        data: {
          doc: wireSnapshotFromPmDoc(
            pmDoc([pmParagraph("unrelated-block", "当前正文没有候选锚点")]),
            1,
          ),
        },
      },
      docStateFrame("pendingReview"),
      toolCallUpdatedFrame(patch),
    ]);

    const fallback = host?.querySelector(
      '[data-wf="PatchNav"][data-review-fallback="true"]',
    );
    expect(fallback?.textContent).toContain("修改候选待确认");
    expect(fallback?.textContent).toContain("提交 ↵");
    expect(fallback?.textContent).toContain("放弃全部");
    expect(getChatEditor().getAttribute("contenteditable")).toBe("false");

    await clickButton("提交 ↵");
    expect(stream.commitReviewGroups).toHaveBeenCalledWith("s-1", {
      acceptReviewBatchIds: ["batch-missing"],
      rejectReviewBatchIds: [],
    });
  });

  it("pendingReview 没有候选明细时保留输入重说入口", async () => {
    const { WorkspacePage } = await import("./WorkspacePage");
    await render(<WorkspacePage />);
    const stream = latestServerStream();
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "测试审阅脱困" } },
      {
        kind: "documentSnapshotWritten",
        data: {
          doc: wireSnapshotFromPmDoc(
            pmDoc([pmParagraph("base-p", "候选明细未恢复，但正文仍在")]),
            1,
          ),
        },
      },
      docStateFrame("pendingReview"),
    ]);

    expect(host?.querySelector('[data-wf="PatchNav"]')).toBeNull();
    const editor = getChatEditor();
    expect(editor.getAttribute("contenteditable")).toBe("true");
    bindInnerText(editor);
    await act(async () => {
      editor.innerText = "请重新处理刚才的修改";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickButton("发送");
    await flushMicrotasks(5);

    expect(sendMessageCommands(stream)).toContainEqual(
      expect.objectContaining({
        kind: "sendMessage",
        data: expect.objectContaining({
          sessionId: "s-1",
          text: "请重新处理刚才的修改",
        }),
      }),
    );
  });

  it("B7 放弃全部不终止在途请求，pending 问卷卡保持可作答", async () => {
    const { useWorkspacePageController } = await import("./WorkspacePage");
    const captured: {
      current: ReturnType<typeof useWorkspacePageController> | null;
    } = { current: null };
    function ControllerHarness() {
      captured.current = useWorkspacePageController();
      return null;
    }
    await render(<ControllerHarness />);
    const stream = latestServerStream();
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "测试审阅" } },
      {
        kind: "documentSnapshotWritten",
        data: {
          doc: wireSnapshotFromPmDoc(
            baseDocForReviewSpecs([textReviewToolCall("p-1", "batch-a", 0)]),
            1,
          ),
        },
      },
      docStateFrame("pendingReview"),
      toolCallUpdatedFrame(textReviewToolCall("p-1", "batch-a", 0)),
    ]);
    const pendingCommit = mockPendingCommit(stream);
    await emitFrames(stream, [
      {
        kind: "toolCallUpdated",
        data: {
          messageId: "m-ask",
          toolCallId: "ask-1",
          spec: inlineAskUserToolCall("ask-1"),
        },
      },
      {
        kind: "docStateChanged",
        data: {
          state: { kind: "pendingReview" },
          activeOverlay: "askUser",
          agentBusy: false,
        },
      },
    ]);
    expect(captured.current?.state.toolCalls.get("ask-1")?.status.kind).toBe(
      "pending",
    );

    act(() => {
      void captured.current?.handleRejectAll();
    });
    await flushMicrotasks();

    // stop 会 abort updateDoc/恢复等共享请求，并把 pending 工具卡统一终结为 aborted。
    expect(stream.stop).not.toHaveBeenCalled();
    expect(stream.commitReviewGroups).toHaveBeenCalledTimes(1);
    expect(captured.current?.state.toolCalls.get("ask-1")?.status.kind).toBe(
      "pending",
    );

    await act(async () => {
      pendingCommit.resolve([docStateFrame("editing")]);
      await pendingCommit.promise;
    });
  });

  it("放弃全部只收到 stale pendingReview 时保留候选和重试入口", async () => {
    const stream = await renderWorkspaceWithReview([
      textReviewToolCall("p-1", "batch-a", 0),
    ]);
    const pendingCommit = mockPendingCommit(stream);

    await clickButton("放弃全部");
    await clickButton("确认放弃全部");
    expect(getChatEditor().getAttribute("contenteditable")).toBe("false");

    await emitFrames(stream, [docStateFrame("pendingReview")]);
    expect(getChatEditor().getAttribute("contenteditable")).toBe("false");

    await act(async () => {
      pendingCommit.resolve([docStateFrame("pendingReview")]);
      await pendingCommit.promise;
    });
    await flushMicrotasks();

    expect(getChatEditor().getAttribute("contenteditable")).toBe("false");
    expect(host?.querySelector('[data-wf="PatchNav"]')).not.toBeNull();
    expect(document.body.textContent).toContain("候选已保留，请重试");
  });

  it("放弃全部请求失败后保留原候选，可再次确认并成功结算", async () => {
    const stream = await renderWorkspaceWithReview([
      textReviewToolCall("p-reject-retry", "batch-reject-retry", 0),
    ]);
    stream.commitReviewGroups.mockRejectedValueOnce(new Error("network down"));

    await clickButton("放弃全部");
    await clickButton("确认放弃全部");
    await flushMicrotasks(5);

    expect(document.body.dataset.content).toBe("pendingReview");
    expect(host?.querySelector('[data-wf="PatchNav"]')).not.toBeNull();
    expect(host?.textContent).toContain("剩余 · 1 处");
    expect(getChatEditor().getAttribute("contenteditable")).toBe("false");

    mockCommitWithFrames(stream, [docStateFrame("editing")]);
    await clickButton("放弃全部");
    await clickButton("确认放弃全部");
    await flushMicrotasks(5);

    expect(stream.commitReviewGroups).toHaveBeenCalledTimes(2);
    expect(getChatEditor().getAttribute("contenteditable")).toBe("true");
  });

  it("逐处审阅自动提交失败后显示显式重试入口，重试成功再解锁", async () => {
    const patch = textReviewToolCall(
      "p-auto-retry",
      "batch-auto-retry",
      0,
      "reviewing",
    );
    const stream = await renderWorkspaceWithReview([patch]);
    stream.commitReviewGroups.mockRejectedValueOnce(new Error("network down"));

    await emitFrames(stream, [
      toolCallUpdatedFrame({ ...patch, status: { kind: "accepted" } }),
    ]);
    await flushMicrotasks(5);

    expect(stream.commitReviewGroups).toHaveBeenCalledTimes(1);
    expect(document.body.dataset.content).toBe("pendingReview");
    expect(getChatEditor().getAttribute("contenteditable")).toBe("false");
    expect(host?.querySelector('[data-wf="PatchNav"]')).not.toBeNull();
    expect(host?.textContent).toContain("提交失败，候选待重试");

    mockCommitWithFrames(stream, [
      {
        kind: "docCommitted",
        data: {
          sessionId: "s-1",
          version: 2,
          appliedCount: 1,
          conflictCount: 0,
        },
      },
      docStateFrame("editing"),
    ]);
    await clickButton("提交 ↵");
    await flushMicrotasks(5);

    expect(stream.commitReviewGroups).toHaveBeenCalledTimes(2);
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
      // 服务端已用 docCommitted 明确确认落库，但响应缺少离开 pendingReview 的
      // docStateChanged → 成功提交仍必须触发兜底解锁。
      pendingCommit.resolve([
        {
          kind: "docCommitted",
          data: { sessionId: "s-1", version: 2, appliedCount: 1, conflictCount: 0 },
        },
        docStateFrame("pendingReview"),
      ]);
      await pendingCommit.promise;
    });
    await flushMicrotasks();

    expect(getChatEditor().getAttribute("contenteditable")).toBe("true");
  });

  it("首个提交请求未完成时双击只提交一次", async () => {
    const stream = await renderWorkspaceWithReview([
      textReviewToolCall("p-1", "batch-a", 0),
    ]);
    const pendingCommit = mockPendingCommit(stream);

    const commit = buttonByText("提交 ↵");
    act(() => {
      commit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      commit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await flushMicrotasks();
    expect(stream.commitReviewGroups).toHaveBeenCalledTimes(1);
    expect(commit.disabled).toBe(true);

    await act(async () => {
      pendingCommit.resolve([docStateFrame("editing")]);
      await pendingCommit.promise;
    });
  });

  it("放弃全部成功解锁后可继续追问", async () => {
    const stream = await renderWorkspaceWithReview([
      textReviewToolCall("p-1", "batch-a", 0),
    ]);
    const pendingCommit = mockPendingCommit(stream);

    await clickButton("放弃全部");
    await clickButton("确认放弃全部");

    expect(getChatEditor().getAttribute("contenteditable")).toBe("false");

    await act(async () => {
      pendingCommit.resolve([docStateFrame("editing")]);
      await pendingCommit.promise;
    });
    await flushMicrotasks(5);

    const editor = getChatEditor();
    expect(editor.getAttribute("contenteditable")).toBe("true");
    bindInnerText(editor);
    await act(async () => {
      editor.innerText = "继续追问";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickButton("发送");
    await flushMicrotasks(5);

    const sends = sendMessageCommands(stream);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      kind: "sendMessage",
      data: {
        sessionId: "s-1",
        text: "继续追问",
        activeDocument: { kind: "main" },
      },
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

    await clickButton("发送");
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

    await clickButton("发送");
    await flushMicrotasks(5);
    expect(host?.querySelector('[data-wf="GlobalConfirm"]')).toBeNull();
    expect(sendMessageCommands(stream)).toHaveLength(1);
    expect(stream.ignoreAnnotationGroups).not.toHaveBeenCalled();
    expect(host?.querySelector('[data-annotation-group="annotation-1"]')).not.toBeNull();
  });

  it("会话恢复帧在正文快照后重建全部批注锚点与 hover 卡", async () => {
    const stream = await renderWorkspaceWithAnnotations();
    const restoredGroup: AnnotationGroup = {
      id: "annotation-restored",
      summary: "两处信息需要复核",
      note: "重启后仍应显示两处原文位置。",
      origin: "自定义审查:对外发布",
      suggestion: "改用公开口径",
      severity: "error",
      status: "reviewing",
      anchors: [
        { blockId: "restore-p", pmFrom: 1, pmTo: 3, quote: "甲组", textHash: "restore-a" },
        { blockId: "restore-p", pmFrom: 5, pmTo: 7, quote: "乙组", textHash: "restore-b" },
      ],
    };

    await emitFrames(stream, [
      { kind: "restoreReset", data: { epoch: 2, snapshotSeq: 0 } },
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "恢复批注" } },
      {
        kind: "documentSnapshotWritten",
        data: {
          doc: wireSnapshotFromPmDoc(
            pmDoc([pmParagraph("restore-p", "甲组正文乙组结尾")]),
            1,
          ),
        },
      },
      {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
      },
      { kind: "annotationGroupsReady", data: { groups: [restoredGroup] } },
      { kind: "sessionRestoreCompleted", data: { sessionId: "s-1" } },
    ]);

    const restoredAnchors = host!.querySelectorAll<HTMLElement>(
      '[data-annotation-group="annotation-restored"]',
    );
    expect(restoredAnchors).toHaveLength(2);
    expect(Array.from(restoredAnchors, (anchor) => anchor.textContent)).toEqual(["甲组", "乙组"]);
    expect(Array.from(restoredAnchors, (anchor) => anchor.dataset.annotationSeverity))
      .toEqual(["error", "error"]);

    vi.useFakeTimers();
    await act(async () => {
      restoredAnchors[1]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(80);
    });
    expect(host?.querySelector(".annotation-hover-card")?.textContent)
      .toContain("两处信息需要复核");
    expect(host?.querySelector(".annotation-hover-card")?.textContent)
      .toContain("重启后仍应显示两处原文位置。");
    expect(host?.querySelector(".annotation-hover-card")?.textContent)
      .toContain("改用公开口径");
    vi.useRealTimers();
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

  it("切到衍生稿后发送载荷绑定当前衍生稿而非主稿", async () => {
    const derivative = {
      docId: "deriv-current-target",
      dtype: "gzh",
      templateId: "gzh-story",
      templateName: "故事叙事文",
      privatePrompt: "",
      sourceVersion: 1,
      currentSourceVersion: 1,
      generatedAt: "2026-07-30T00:00:00.000Z",
      stale: false,
    };
    const stream = await renderWorkspaceWithAnnotations("reviewing", (nextStream) => {
      nextStream.listDerivatives.mockResolvedValue([derivative]);
      nextStream.getDerivativeDoc.mockResolvedValue({
        meta: derivative,
        docPm: JSON.stringify(pmDoc([pmParagraph("deriv-target-p", "衍生正文")])),
        docVersion: 1,
        title: "",
      });
    });
    await flushMicrotasks(5);

    const derivativeTab = Array.from(
      host!.querySelectorAll<HTMLElement>('[role="tab"]'),
    ).find((tab) => tab.textContent?.includes("公众号文章"));
    expect(derivativeTab).toBeTruthy();
    await clickElement(derivativeTab!);

    const editor = getChatEditor();
    bindInnerText(editor);
    await act(async () => {
      editor.innerText = "把第二段改短一点";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickButton("发送");
    await flushMicrotasks(5);

    expect(sendMessageCommands(stream)).toContainEqual(
      expect.objectContaining({
        kind: "sendMessage",
        data: expect.objectContaining({
          text: "把第二段改短一点",
          activeDocument: {
            kind: "derivative",
            docId: derivative.docId,
          },
        }),
      }),
    );
  });

  it("单日语译稿内追问绑定当前语种且不暗建英语稿", async () => {
    const japanese = {
      docId: "translation-ja-only",
      dtype: "translate" as const,
      templateId: "translate-native",
      templateName: "母语化改写",
      targetLang: "日语",
      privatePrompt: "",
      sourceVersion: 1,
      currentSourceVersion: 1,
      generatedAt: "2026-08-03T00:00:00.000Z",
      stale: false,
    };
    const stream = await renderWorkspaceWithAnnotations("reviewing", (nextStream) => {
      nextStream.listDerivatives.mockResolvedValue([japanese]);
      nextStream.getDerivativeDoc.mockResolvedValue({
        meta: japanese,
        docPm: JSON.stringify(pmDoc([
          pmParagraph("translation-ja-p", "日本語の訳文"),
        ])),
        docVersion: 1,
        title: "",
      });
    });
    await flushMicrotasks(5);

    const translationTab = Array.from(
      host!.querySelectorAll<HTMLElement>('[role="tab"]'),
    ).find((tab) => tab.textContent?.includes("翻译"));
    expect(translationTab).toBeTruthy();
    await clickElement(translationTab!);

    const editor = getChatEditor();
    bindInnerText(editor);
    await act(async () => {
      editor.innerText = "语气更正式一点";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickButton("发送");
    await flushMicrotasks(5);

    expect(sendMessageCommands(stream)).toContainEqual(
      expect.objectContaining({
        kind: "sendMessage",
        data: expect.objectContaining({
          text: "语气更正式一点",
          activeDocument: {
            kind: "derivative",
            docId: japanese.docId,
          },
        }),
      }),
    );
    expect(stream.createDerivative).not.toHaveBeenCalled();
  });

  it("批注意见编辑后点击生成修改只追加输入框，用户确认后才发送", async () => {
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
    await clickButton("生成修改");
    await flushMicrotasks(5);

    expect(sendMessageCommands(stream)).toHaveLength(0);
    expect(editor.textContent).toContain("帮我把这段润色一下");
    expect(editor.textContent).toContain("按批注修改：事实有误——改为五月发布（原文：『甲组』）");
    expect(editor.querySelectorAll("br")).toHaveLength(4);
    expect(editor.querySelector('.chat-chip[data-kind="annotation"]')).toBeNull();
    expect(host?.querySelector(".annotation-hover-card")).toBeNull();
    expect(host?.querySelector('[data-annotation-group="annotation-1"]')?.classList.contains("annotation-anchor-active")).toBe(true);
    expect(host?.querySelector('[data-annotation-group="annotation-1"]')?.classList.contains("annotation-anchor-accepted")).toBe(false);

    await clickButton("发送");
    await flushMicrotasks(5);
    const send = sendMessageCommands(stream)[0];
    expect(send?.kind).toBe("sendMessage");
    if (send?.kind !== "sendMessage") throw new Error("sendMessage not found");
    expect(send.data.text).toContain("帮我把这段润色一下");
    expect(send.data.text).toContain("\n\n按批注修改：事实有误——改为五月发布（原文：『甲组』）");
    expect(send.data.text).not.toContain("时间与资料不一致");
    expect(send.data.text).not.toContain("p-1");
    expect(send.data.text).not.toMatch(/\bPM\b/u);
    expect(send.data.richText).toBeUndefined();
    expect(send.data.chips ?? []).toEqual([]);
    expect(sendMessageCommands(stream)).toHaveLength(1);
    expect(host?.querySelector('[data-annotation-group="annotation-1"]')?.classList.contains("annotation-anchor-active")).toBe(true);
    expect(host?.querySelector('[data-annotation-group="annotation-1"]')?.classList.contains("annotation-anchor-accepted")).toBe(false);
    vi.useRealTimers();
  });

  it("批注回填后由用户发送，失败时恢复输入内容且锚点仍可再次处理", async () => {
    const stream = await renderWorkspaceWithAnnotations();
    stream.sendCommand.mockRejectedValueOnce(new Error("network down"));

    vi.useFakeTimers();
    await act(async () => {
      host!.querySelector<HTMLElement>('[data-annotation-group="annotation-1"]')!
        .dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(80);
    });
    await clickButton("生成修改");
    expect(sendMessageCommands(stream)).toHaveLength(0);
    await clickButton("发送");
    await flushMicrotasks(8);

    const editor = getChatEditor();
    expect(sendMessageCommands(stream)).toHaveLength(1);
    expect(editor.textContent).toContain("按批注修改：");
    expect(editor.querySelector('.chat-chip[data-kind="annotation"]')).toBeNull();
    expect(host?.querySelector('[data-annotation-group="annotation-1"]')?.classList.contains("annotation-anchor-active")).toBe(true);
    expect(host?.querySelector(".qa-toast")?.textContent).toContain("发送失败，请重试");
    vi.useRealTimers();
  });

  it("批注生成修改经候选提交后正文落稿，重开会话仍读取已提交版本", async () => {
    const stream = await renderWorkspaceWithAnnotations();
    const baseDoc = pmDoc([pmParagraph("p-1", "甲组正文")]);
    const editedDoc = pmDoc([pmParagraph("p-1", "乙组正文")]);
    const suggestion = docSuggestionFromToolCall(reviewToolCall(
      "annotation-fix",
      "batch-annotation-fix",
      "reviewing",
      {
        blockId: "p-1",
        before: "甲组",
        after: "乙组",
        groupMode: "independent",
      },
    ));

    vi.useFakeTimers();
    await act(async () => {
      host!.querySelector<HTMLElement>('[data-annotation-group="annotation-1"]')!
        .dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(80);
    });
    await clickButton("生成修改");
    await flushMicrotasks(5);
    expect(sendMessageCommands(stream)).toHaveLength(0);
    await clickButton("发送");
    await flushMicrotasks(5);
    expect(sendMessageCommands(stream)).toHaveLength(1);
    const send = sendMessageCommands(stream)[0];
    expect(send?.kind).toBe("sendMessage");
    if (send?.kind !== "sendMessage") throw new Error("sendMessage not found");
    expect(send.data.text).toBe("按批注修改：事实有误——改为四月发布（原文：『甲组』）");
    expect(send.data.text).not.toContain("p-1");
    expect(send.data.text).not.toMatch(/\bPM\b/u);
    expect(host?.querySelector('[data-annotation-group="annotation-1"]')).not.toBeNull();

    await emitFrames(stream, [
      {
        kind: "docDiffReady",
        data: {
          baseVersion: 1,
          suggestions: [suggestion],
          previewDoc: baseDoc,
          editedDoc,
        },
      },
      docStateFrame("pendingReview"),
    ]);
    expect(document.body.dataset.content).toBe("pendingReview");
    expect(host?.querySelector('[data-annotation-group="annotation-1"]')).toBeNull();
    expect(host?.textContent).toContain("乙组");

    mockCommitWithFrames(stream, [
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(editedDoc, 2) },
      },
      {
        kind: "docCommitted",
        data: {
          sessionId: "s-1",
          version: 2,
          appliedCount: 1,
          conflictCount: 0,
        },
      },
      {
        kind: "annotationGroupsReady",
        data: { groups: [], replacedOrigins: ["source-check"] },
      },
      docStateFrame("editing"),
    ]);
    await clickButton("提交 ↵");
    await flushMicrotasks(5);

    expect(stream.commitReviewGroups).toHaveBeenCalledWith("s-1", {
      acceptReviewBatchIds: ["batch-annotation-fix"],
      rejectReviewBatchIds: [],
    });
    expect(host?.querySelector<HTMLElement>(".wf-doc.ProseMirror")?.textContent).toContain("乙组正文");
    expect(host?.querySelector<HTMLElement>(".wf-doc.ProseMirror")?.textContent).not.toContain("甲组正文");
    expect(host?.querySelector('[data-annotation-group="annotation-1"]')).toBeNull();

    vi.useRealTimers();
    await act(async () => root?.unmount());
    host?.remove();
    root = null;

    const { WorkspacePage } = await import("./WorkspacePage");
    await render(<WorkspacePage />);
    const reopenedStream = latestServerStream();
    await emitFrames(reopenedStream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "测试批注" } },
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(editedDoc, 2) },
      },
      docStateFrame("editing"),
      { kind: "sessionRestoreCompleted", data: { sessionId: "s-1" } },
    ]);

    expect(host?.querySelector<HTMLElement>(".wf-doc.ProseMirror")?.textContent).toContain("乙组正文");
    expect(host?.querySelector<HTMLElement>(".wf-doc.ProseMirror")?.textContent).not.toContain("甲组正文");
  });

  it("P2-20 回归:忽略批注保存失败后按快照恢复，并重新出现操作入口", async () => {
    const stream = await renderWorkspaceWithAnnotations();
    let rejectIgnore: (error: unknown) => void = () => undefined;
    stream.ignoreAnnotationGroups.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectIgnore = reject;
      }),
    );

    vi.useFakeTimers();
    await act(async () => {
      host!.querySelector<HTMLElement>('[data-annotation-group="annotation-1"]')!
        .dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(80);
    });
    await clickButton("忽略");
    await flushMicrotasks(3);
    expect(stream.ignoreAnnotationGroups).toHaveBeenCalledTimes(1);
    expect(host?.querySelector('[data-annotation-group="annotation-1"]')).toBeNull();

    await act(async () => {
      rejectIgnore(new Error("proxy down"));
    });
    await flushMicrotasks(5);
    vi.useRealTimers();

    expect(host?.querySelector('[data-annotation-group="annotation-1"]')).not.toBeNull();
    expect(host?.querySelector(".qa-toast")?.textContent).toContain("已恢复");
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
      pendingCommit.resolve([
        {
          kind: "docCommitted",
          data: { sessionId: "s-1", version: 2, appliedCount: 1, conflictCount: 0 },
        },
        docStateFrame("editing"),
      ]);
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

  it("W1c 放弃剩余项时已采纳部分整批冲突，不预报保留成功也不回流伪结果", async () => {
    const first = textReviewToolCall("p-reject-conflict-1", "batch-a", 0);
    const second = textReviewToolCall("p-reject-conflict-2", "batch-b", 1);
    const stream = await renderWorkspaceWithReview([first, second]);
    await emitFrames(stream, [toolCallUpdatedFrame({
      ...first,
      status: { kind: "accepted" },
    })]);
    mockCommitWithFrames(stream, [
      toolCallUpdatedFrame({
        ...first,
        status: {
          kind: "failed",
          data: { retriable: false, reason: "文档正文已变化，本次修改未写入。" },
        },
      }),
      docStateFrame("editing"),
    ]);

    await clickButton("放弃全部");
    await clickButton("确认放弃全部");
    await flushMicrotasks();

    const toastText = host?.querySelector<HTMLElement>(".qa-toast")?.textContent ?? "";
    expect(toastText).toContain("本次修改未写入");
    expect(toastText).not.toContain("已保留已采纳");
    const outcomeCommands = stream.sendCommand.mock.calls
      .map(([command]) => command as Command)
      .filter((command) => command.kind === "submitReviewOutcome");
    expect(outcomeCommands).toHaveLength(0);
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
    const derivativeAdd = host?.querySelector<HTMLButtonElement>(
      '[aria-label="新建稿件"]',
    );
    expect(derivativeAdd?.getAttribute("aria-disabled")).toBe("true");
    expect(derivativeAdd?.getAttribute("title")).toBe(
      "请先完成问卷，再新建稿件",
    );

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
    expect(derivativeAdd?.getAttribute("aria-disabled")).toBeNull();
    expect(derivativeAdd?.getAttribute("title")).toBe("新建稿件");
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

  it("P1-11 回归:cancel POST 被代理阻断时恢复完整问卷，不留下服务端挂起死锁", async () => {
    const stream = await renderWorkspaceWithInlineAskUser();
    let rejectCancel: (error: unknown) => void = () => undefined;
    stream.sendCommand.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectCancel = reject;
      }),
    );

    const abandon = buttonByText("手动输入");
    await clickElement(abandon);
    await flushMicrotasks(3);

    const cancels = stream.sendCommand.mock.calls
      .map(([command]) => command as Command)
      .filter((command) => command.kind === "cancelAskUser");
    expect(cancels).toHaveLength(1);
    // 乐观收口期间入口消失，且同一 mutation 不可能重复提交。
    expect(host?.querySelector('[data-wf="AskUserOverlay"]')).toBeNull();

    await act(async () => {
      rejectCancel(new Error("proxy blocked cancel POST"));
    });
    await flushMicrotasks(5);

    expect(host?.querySelector('[data-wf="AskUserOverlay"]')).not.toBeNull();
    expect(getChatEditor().getAttribute("contenteditable")).toBe("false");
    expect(exportButton().getAttribute("aria-disabled")).toBe("true");
    expect(host?.textContent).toContain("为什么放弃这些修改？");
    expect(host?.querySelector(".qa-toast")?.textContent).toContain(
      "问卷已恢复",
    );
  });

  it("P1-11 回归:actor 取消失败虽返回 HTTP 200 错误帧，前端仍回滚并保留作答入口", async () => {
    const stream = await renderWorkspaceWithInlineAskUser();
    let rejectCancel: (error: unknown) => void = () => undefined;
    stream.sendCommand.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectCancel = reject;
      }),
    );

    await clickElement(buttonByText("手动输入"));
    await flushMicrotasks(3);
    expect(host?.querySelector('[data-wf="AskUserOverlay"]')).toBeNull();

    await act(async () => {
      rejectCancel(new Error("cancelAskUser failed: actor error frame"));
    });
    await flushMicrotasks(5);

    expect(host?.querySelector('[data-wf="AskUserOverlay"]')).not.toBeNull();
    expect(getChatEditor().getAttribute("contenteditable")).toBe("false");
    expect(exportButton().getAttribute("aria-disabled")).toBe("true");
    expect(host?.textContent).toContain("为什么放弃这些修改？");
    expect(host?.querySelector(".qa-toast")?.textContent).toContain(
      "问卷已恢复",
    );
  });

  it("P1-11 回归:权威取消成功帧先到，迟到 fetch 失败不得覆盖回问卷锁态", async () => {
    const stream = await renderWorkspaceWithInlineAskUser();
    let rejectCancel: (error: unknown) => void = () => undefined;
    stream.sendCommand.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectCancel = reject;
      }),
    );

    await clickElement(buttonByText("手动输入"));
    await flushMicrotasks(3);

    await emitFrames(stream, [
      {
        kind: "toolCallUpdated",
        data: {
          messageId: "m-ask",
          toolCallId: "ask-1",
          spec: {
            ...inlineAskUserToolCall("ask-1"),
            status: {
              kind: "aborted",
              data: { reason: "user_cancelled" },
            },
          },
        },
      },
      {
        kind: "docStateChanged",
        data: {
          state: { kind: "editing" },
          activeOverlay: null,
          agentBusy: false,
        },
      },
    ]);

    await act(async () => {
      rejectCancel(new Error("response connection reset after authoritative frames"));
    });
    await flushMicrotasks(5);

    expect(host?.querySelector('[data-wf="AskUserOverlay"]')).toBeNull();
    expect(getChatEditor().getAttribute("contenteditable")).toBe("true");
    expect(exportButton().getAttribute("aria-disabled")).toBeNull();
    expect(host?.querySelector(".qa-toast")?.textContent).toContain("已放弃本轮");
    expect(host?.querySelector(".qa-toast")?.textContent).not.toContain(
      "问卷已恢复",
    );
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

  it("已有日语稿后追加英语和韩语，两稿落库并只发一条可见 Agent 指令", async () => {
    const base: DerivativeItem = {
      docId: "translation-placeholder",
      dtype: "translate",
      templateId: "translate-faithful",
      templateName: "忠实精准",
      targetLang: "英语",
      privatePrompt: "保留产品名",
      sourceVersion: null,
      currentSourceVersion: 3,
      generatedAt: null,
      stale: false,
    };
    const japanese: DerivativeItem = {
      ...base,
      docId: "translation-ja-existing",
      targetLang: "日语",
      sourceVersion: 3,
      generatedAt: "2026-08-02T09:00:00.000Z",
    };
    const translationItems: DerivativeItem[] = [japanese];
    serverStreamMock.createDerivativeImpl = async (targetLang) => {
      const next = {
        ...base,
        docId: targetLang === "韩语" ? "translation-ko" : "translation-en",
        targetLang,
      };
      translationItems.push(next);
      return next;
    };
    serverStreamMock.listDerivativesImpl = async () => translationItems;
    window.location.hash = "#/workspace?session=s-translation-agent";
    const { useWorkspacePageController } = await import("./WorkspacePage");
    const captured: {
      current: ReturnType<typeof useWorkspacePageController> | null;
    } = { current: null };
    function TranslationAgentHarness() {
      const controller = useWorkspacePageController();
      captured.current = controller;
      return <output data-testid="translation-agent-turn">
        {controller.state.messages.map((message) => message.role.kind).join(",")}
        :{controller.state.toolCalls.size}
      </output>;
    }

    await render(<TranslationAgentHarness />);
    const stream = latestServerStream();
    await emitFrames(stream, [{
      kind: "sessionMeta",
      data: { sessionId: "s-translation-agent", title: "翻译 Agent 链路" },
    }]);
    await act(async () => captured.current?.setDerivativeCreateDtype("translate"));
    await act(async () => {
      await captured.current?.handleCreateDerivative({
        templateId: "translate-faithful",
        writingStyleId: "translate-faithful",
        layoutStyleId: null,
        targetLanguages: ["英语", "韩语"],
        privatePrompt: "保留产品名",
      });
    });
    await flushMicrotasks(6);

    expect(stream.createDerivative).toHaveBeenCalledTimes(2);
    expect(stream.createDerivative.mock.calls.map((call) => call[6])).toEqual(["英语", "韩语"]);
    expect(translationItems.map((item) => item.targetLang)).toEqual(["日语", "英语", "韩语"]);
    expect(translationItems[0]).toBe(japanese);
    const sends = sendMessageCommands(stream);
    expect(sends).toHaveLength(1);
    const sent = sends[0];
    expect(sent).toMatchObject({
      kind: "sendMessage",
      data: {
        sessionId: "s-translation-agent",
        turnKind: "generateDerivative",
        activeDocument: { kind: "derivative", docId: "translation-en" },
        displayCard: {
          title: "翻译文档",
          lines: [
            { label: "语言", value: "英语、韩语" },
            { label: "风格", value: "忠实精准" },
            { label: "补充", value: "保留产品名" },
          ],
        },
      },
    });
    if (sent?.kind !== "sendMessage") throw new Error("缺少翻译用户指令");
    expect(sent.data.text).toContain("把主文档翻译成英语、韩语");
    expect(sent.data.text).toContain("英语写入衍生稿(doc_id: translation-en)");
    expect(sent.data.text).toContain("韩语写入衍生稿(doc_id: translation-ko)");
    expect(captured.current?.state.messages).toHaveLength(1);
    expect(captured.current?.state.messages[0]?.role.kind).toBe("user");
    expect(captured.current?.state.messages[0]?.parts[0]?.kind).toBe("actionCard");

    const toolSpec: ToolCallSpec = {
      id: "generate-translation-en",
      name: "generate_derivative",
      render: { kind: "chatInline" },
      status: { kind: "running", data: { progressPct: null, etaSec: null } },
      body: { kind: "generic", data: { argsJson: '{"derivativeDocId":"translation-en"}' } },
      result: null,
    };
    await emitFrames(stream, [
      {
        kind: "chatMessageAdded",
        data: {
          message: {
            id: "translation-agent-reply",
            role: { kind: "agent" },
            ts: "2026-08-02T10:00:00.000Z",
            parts: [{ kind: "text", data: { body: "正在逐语种翻译。" } }],
            chips: null,
          },
        },
      },
      {
        kind: "toolCallUpdated",
        data: {
          messageId: "translation-agent-reply",
          toolCallId: toolSpec.id,
          spec: toolSpec,
        },
      },
      {
        kind: "derivativeGenFinished",
        data: {
          docId: "translation-en",
          generatedAt: "2026-08-02T10:00:01.000Z",
          docVersion: 1,
        },
      },
      {
        kind: "derivativeGenFinished",
        data: {
          docId: "translation-ko",
          generatedAt: "2026-08-02T10:00:02.000Z",
          docVersion: 1,
        },
      },
    ]);

    expect(host?.querySelector('[data-testid="translation-agent-turn"]')?.textContent)
      .toBe("user,agent:1");
    expect(captured.current?.activeTranslationDocId).toBe("translation-ko");
  });

  it("非英语单语翻译完成后把子 Tab 切到刚完成的语种", async () => {
    const english: DerivativeItem = {
      docId: "translate-en-empty",
      dtype: "translate" as const,
      templateId: "translate-faithful",
      templateName: "忠实精准",
      targetLang: "英语",
      privatePrompt: "",
      sourceVersion: null,
      currentSourceVersion: 1,
      generatedAt: null,
      stale: false,
    };
    const japanese: DerivativeItem = {
      ...english,
      docId: "translate-ja-new",
      targetLang: "日语",
    };
    let translationItems: DerivativeItem[] = [english, japanese];
    serverStreamMock.listDerivativesImpl = async () => translationItems;
    window.location.hash = "#/workspace?session=s-translate-tab";
    const { useWorkspacePageController } = await import("./WorkspacePage");
    const captured: {
      current: ReturnType<typeof useWorkspacePageController> | null;
    } = { current: null };
    function TranslationTabHarness() {
      const controller = useWorkspacePageController();
      captured.current = controller;
      return (
        <output data-testid="active-translation-tab">
          {controller.activeTab}:{controller.activeTranslationDocId ?? ""}
        </output>
      );
    }

    await render(<TranslationTabHarness />);
    const stream = latestServerStream();
    await emitFrames(stream, [{
      kind: "sessionMeta",
      data: { sessionId: "s-translate-tab", title: "翻译选中态" },
    }]);
    await flushMicrotasks(5);
    expect(captured.current?.activeTranslationDocId).toBe(english.docId);
    await act(async () => captured.current?.setActiveTab("translate"));

    translationItems = [{ ...english }, {
      ...japanese,
      sourceVersion: 1,
      generatedAt: "2026-08-02T08:00:00.000Z",
    }];
    await emitFrames(stream, [{
      kind: "derivativeGenFinished",
      data: {
        docId: japanese.docId,
        generatedAt: "2026-08-02T08:00:00.000Z",
        docVersion: 1,
      },
    }]);
    await flushMicrotasks(5);

    expect(captured.current?.activeTranslationDocId).toBe(japanese.docId);
    expect(host?.querySelector('[data-testid="active-translation-tab"]')?.textContent)
      .toBe(`translate:${japanese.docId}`);
  });

  it("pendingReview 下禁用新建稿件并保留独立标题重命名", async () => {
    const stream = await renderWorkspaceWithReview([
      textReviewToolCall("rename-gating", "batch-rename-gating", 0),
    ]);

    const add = host?.querySelector<HTMLButtonElement>(
      '[aria-label="新建稿件"]',
    );
    expect(add).not.toBeNull();
    expect(add?.classList.contains("is-disabled")).toBe(true);
    expect(add?.getAttribute("aria-disabled")).toBe("true");
    expect(add?.getAttribute("title")).toBe(
      "请先确认或放弃当前修改候选，再新建稿件",
    );
    await clickElement(add!);
    expect(host?.querySelector('[role="menu"]')).toBeNull();

    await clickElement(
      host!.querySelector<HTMLButtonElement>('[aria-label="修改标题"]')!,
    );
    const input = host?.querySelector<HTMLInputElement>(
      '[aria-label="修改文档标题"]',
    );
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "候选期间的新标题");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      input!.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushMicrotasks(3);

    expect(stream.renameSession).toHaveBeenCalledWith(
      "s-1",
      "候选期间的新标题",
    );
    expect(host?.querySelector(".ws-deriv-tab.is-main")?.textContent).toContain(
      "候选期间的新标题",
    );
    expect(document.body.dataset.content).toBe("pendingReview");
    expect(host?.textContent).toContain("剩余 · 1 处");
  });

  it("切到 B 会话后忽略 A 会话迟到的衍生稿列表", async () => {
    serverStreamMock.startSessionImpl = async () => "session-a";
    let resolveA!: (value: unknown[]) => void;
    let resolveB!: (value: unknown[]) => void;
    const listA = new Promise<unknown[]>((resolve) => {
      resolveA = resolve;
    });
    const listB = new Promise<unknown[]>((resolve) => {
      resolveB = resolve;
    });
    serverStreamMock.listDerivativesImpl = (sessionId) => {
      if (sessionId === "session-a") return listA;
      if (sessionId === "session-b") return listB;
      return Promise.resolve([]);
    };
    window.location.hash = "#/workspace?session=session-a";
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
    const streamA = latestServerStream();

    await emitFrames(streamA, [
      { kind: "sessionMeta", data: { sessionId: "session-a", title: "会话 A" } },
    ]);
    serverStreamMock.startSessionImpl = async () => "session-b";
    await act(async () => {
      window.location.hash = "#/workspace?session=session-b";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await flushMicrotasks(5);
    const streamB = latestServerStream();
    expect(streamB).not.toBe(streamA);
    await emitFrames(streamB, [
      { kind: "sessionMeta", data: { sessionId: "session-b", title: "会话 B" } },
    ]);
    expect(streamB.listDerivatives).toHaveBeenCalledWith("session-b");
    expect(captured.current?.state.sessionId).toBe("session-b");

    await act(async () => {
      resolveB([{
        docId: "derivative-b",
        dtype: "xhs",
        templateId: "xhs-note",
        templateName: "小红书笔记",
        privatePrompt: "",
        sourceVersion: null,
        currentSourceVersion: 0,
        generatedAt: null,
        stale: false,
      }]);
      await listB;
    });
    await flushMicrotasks(5);
    expect(captured.current?.derivatives).toHaveLength(1);
    expect(host?.textContent).toContain("小红书");

    await act(async () => {
      resolveA([{
        docId: "derivative-a",
        dtype: "gzh",
        templateId: "gzh-deep",
        templateName: "深度长文",
        privatePrompt: "",
        sourceVersion: null,
        currentSourceVersion: 0,
        generatedAt: null,
        stale: false,
      }]);
      await listA;
    });
    await flushMicrotasks(5);

    expect(host?.textContent).toContain("小红书");
    expect(host?.textContent).not.toContain("公众号文章");
    serverStreamMock.startSessionImpl = null;
    serverStreamMock.listDerivativesImpl = null;
  });

  it("连续重命名中 T1 成功、T2 失败时回滚到即时标题 T1", async () => {
    window.location.hash = "#/workspace?session=s-1";
    const [{ useWorkspacePageController }, { WorkspaceDocumentPane }] =
      await Promise.all([
        import("./WorkspacePage"),
        import("./components/WorkspaceDocumentPane"),
      ]);
    function ControllerHarness() {
      const controller = useWorkspacePageController();
      return <WorkspaceDocumentPane controller={controller} />;
    }
    await render(<ControllerHarness />);
    const stream = latestServerStream();
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "标题 T0" } },
      {
        kind: "documentSnapshotWritten",
        data: {
          doc: wireSnapshotFromPmDoc(
            pmDoc([pmParagraph("rename-title", "正文")]),
            1,
          ),
        },
      },
      {
        kind: "docStateChanged",
        data: {
          state: { kind: "editing" },
          activeOverlay: null,
          agentBusy: false,
        },
      },
    ]);

    let resolveT1!: () => void;
    let rejectT2!: (error: unknown) => void;
    const renameT1 = new Promise<void>((resolve) => {
      resolveT1 = resolve;
    });
    const renameT2 = new Promise<void>((_resolve, reject) => {
      rejectT2 = reject;
    });
    stream.renameSession
      .mockReturnValueOnce(renameT1)
      .mockReturnValueOnce(renameT2);

    const submitTitle = async (nextTitle: string) => {
      await clickElement(
        host!.querySelector<HTMLButtonElement>('[aria-label="修改标题"]')!,
      );
      const input = host!.querySelector<HTMLInputElement>(
        '[aria-label="修改文档标题"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set?.call(input, nextTitle);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }));
      });
      await flushMicrotasks(3);
    };

    await submitTitle("标题 T1");
    await submitTitle("标题 T2");
    expect(stream.renameSession.mock.calls).toEqual([
      ["s-1", "标题 T1"],
      ["s-1", "标题 T2"],
    ]);

    await act(async () => {
      resolveT1();
      await renameT1;
      rejectT2(new Error("rename failed"));
      await renameT2.catch(() => undefined);
    });
    await flushMicrotasks(5);

    expect(
      host!.querySelector(".ws-deriv-tab.is-main")?.textContent,
    ).toContain("标题 T1");
    expect(
      host!.querySelector(".ws-deriv-tab.is-main")?.textContent,
    ).not.toContain("标题 T0");
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

  it("e2e-0723 停止门二轮:建会话中的规划 turn 停止后不再晚发 sendMessage/问卷", async () => {
    let resolveStart: ((sessionId: string) => void) | null = null;
    serverStreamMock.startSessionImpl = () =>
      new Promise<string>((resolve) => {
        resolveStart = resolve;
      });
    try {
      const { WorkspacePage } = await import("./WorkspacePage");
      await render(<WorkspacePage />);
      const stream = latestServerStream();
      const editor = getChatEditor();
      bindInnerText(editor);
      await act(async () => {
        editor.innerText = "帮我写点东西";
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      });

      await clickButton("发送");
      expect(sendMessageCommands(stream)).toHaveLength(0);
      await clickButton("停止");

      await act(async () => {
        resolveStart?.("s-stop-planning");
      });
      await flushMicrotasks(5);

      expect(sendMessageCommands(stream)).toHaveLength(0);
      expect(host?.textContent).not.toContain("确认方向");
      expect(
        Array.from(host?.querySelectorAll("button") ?? []).some(
          (button) => button.textContent === "停止",
        ),
      ).toBe(false);
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

  it("P2-19 回归:素材摘要保存失败回滚完整资源快照", async () => {
    const stream = await renderWorkspaceWithUploadedMaterial();
    let rejectSave: (error: unknown) => void = () => undefined;
    stream.updateMaterialSummary.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectSave = reject;
      }),
    );
    await clickElement(linkedFilesBar());
    await clickElement(rowByText("合同.pdf"));
    const textarea = host!.querySelector<HTMLTextAreaElement>(".fd-rp-sum-ta")!;
    expect(textarea.value).toBe("合同摘要");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "修改后的摘要",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(stream.updateMaterialSummary).toHaveBeenCalledWith(
      "s-1",
      "mat-1",
      "修改后的摘要",
    );
    expect(textarea.value).toBe("修改后的摘要");

    await act(async () => {
      rejectSave(new Error("proxy down"));
    });
    await flushMicrotasks(5);

    const restored = host!.querySelector<HTMLTextAreaElement>(".fd-rp-sum-ta")!;
    expect(restored.value).toBe("合同摘要");
    expect(host?.querySelector(".qa-toast")?.textContent).toContain("已恢复原内容");
  });

  it("移除上传素材确认弹窗取消时不发送 removeMaterial", async () => {
    const stream = await renderWorkspaceWithUploadedMaterial();

    await clickElement(linkedFilesBar());
    await clickElement(buttonByTextIn(rowByText("合同.pdf"), "删除"));
    await clickElement(buttonByTextIn(removeUploadedCopyDialog(), "取消"));

    expect(removeMaterialCommands(stream)).toHaveLength(0);
  });

  it("下游解析失败即使素材栏折叠也显示常驻回执，查看素材后露出重试", async () => {
    const stream = await renderWorkspaceWithUploadedMaterial();
    expect(host?.querySelector('[data-wf="LinkedFilesPanel"]')).toBeNull();

    await emitFrames(stream, [{
      kind: "resourceUpdated",
      data: {
        resourceRef: { id: "mat-1", domain: { kind: "file" } },
        summary: "合同摘要",
        metadata: {
          fileId: "file-mat-1",
          parseState: "error",
          parseError: "pdf parser internal stack trace",
        },
      },
    }]);

    await vi.waitFor(() => {
      expect(host?.querySelector('[data-toast-key="material-parse-failed"]'))
        .not.toBeNull();
    });
    const toast = host!.querySelector<HTMLElement>(
      '[data-toast-key="material-parse-failed"]',
    )!;
    expect(toast.classList.contains("sticky")).toBe(true);
    expect(toast.textContent).toContain("素材解析失败");
    expect(toast.textContent).not.toContain("stack trace");
    await clickElement(buttonByTextIn(toast, "查看素材"));

    await vi.waitFor(() => {
      expect(host?.querySelector('[data-wf="LinkedFilesPanel"]')).not.toBeNull();
    });
    const row = rowByText("合同.pdf");
    expect(row.textContent).toContain("解析失败");
    expect(buttonByTextIn(row, "重试")).not.toBeNull();
    expect(host?.textContent).not.toContain("stack trace");
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

  it("300ms 快速路径：旧稿 ack 后排队正文照常发往旧会话并完整排空", async () => {
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
    expect(firstCommand.data.baseContentHash).toBe(
      getPmContentHash(pmDoc([pmParagraph("p-queue", "初始正文")])),
    );
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
    expect(updateDocCommands(oldStream)[1]?.data.baseContentHash).toBe(
      getPmContentHash(pmDoc([pmParagraph("p-queue", "在途正文 A")])),
    );
    expect(updateDocCommands(nextStream)).toHaveLength(0);
  }, 60_000);

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
    // 「全部应用」已按用户拍板移除:提交本身默认应用未裁决的全部修改
    expect(host?.textContent).not.toContain("全部应用");

    await clickButton("提交 ↵");

    expect(patchVerdictCommands(stream)).toHaveLength(0);
    expect(stream.commitReviewGroups).toHaveBeenCalledWith("s-1", {
      acceptReviewBatchIds: ["batch-a", "batch-b"],
      rejectReviewBatchIds: [],
    });
  });

  it("应用新版成功后保留当前文档与会话，不终止工作区流", async () => {
    window.location.hash = "#/workspace?session=s-1";
    const { WorkspacePage } = await import("./WorkspacePage");
    await render(<WorkspacePage />);
    const stream = latestServerStream();
    const baseDoc = pmDoc([pmParagraph("rewrite-base", "旧文")]);
    const editedDoc = pmDoc([
      pmHeading("rewrite-title", "新版标题"),
      pmParagraph("rewrite-body", "这是彻底改写后并已成功落库的新版正文。"),
    ]);
    const suggestion = docSuggestionFromToolCall(reviewToolCall(
      "rewrite-hunk",
      "batch-rewrite",
      "reviewing",
      {
        blockId: "rewrite-base",
        before: "旧文",
        after: "新版标题\n这是彻底改写后并已成功落库的新版正文。",
      },
    ));
    const commitFrames: BridgeFrame[] = [
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(editedDoc, 2) },
      },
      {
        kind: "docCommitted",
        data: { sessionId: "s-1", version: 2, appliedCount: 1, conflictCount: 0 },
      },
      {
        kind: "docStateChanged",
        data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
      },
    ];
    mockCommitWithFrames(stream, commitFrames);
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "整篇改写收尾" } },
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
        data: { state: { kind: "pendingReview" }, activeOverlay: null, agentBusy: false },
      },
      {
        kind: "sessionRestoreCompleted",
        data: { sessionId: "s-1" },
      },
    ]);

    expect(host?.querySelector('[data-wf="WholeDocReviewNav"]')).not.toBeNull();
    await clickButton("应用新版");
    await flushMicrotasks(5);

    expect(stream.commitReviewGroups).toHaveBeenCalledWith("s-1", {
      acceptReviewBatchIds: ["batch-rewrite"],
    });
    expect(stream.stop).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#/workspace?session=s-1");
    expect(document.body.dataset.content).toBe("editing");
    expect(host?.querySelector('[data-wf="StarterPanel"]')).toBeNull();
    expect(host?.textContent).toContain("已成功落库的新版正文");
  });

  it("提交写入失败时明确提示并保留候选", async () => {
    const stream = await renderWorkspaceWithReview([
      textReviewToolCall("p-keep-1", "batch-keep-1", 0),
      textReviewToolCall("p-keep-2", "batch-keep-2", 1),
    ]);
    stream.commitReviewGroups.mockRejectedValueOnce(new Error("db timeout"));

    await clickButton("提交 ↵");
    await flushMicrotasks(5);

    expect(stream.commitReviewGroups).toHaveBeenCalledWith("s-1", {
      acceptReviewBatchIds: ["batch-keep-1", "batch-keep-2"],
      rejectReviewBatchIds: [],
    });
    expect(document.body.dataset.content).toBe("pendingReview");
    expect(host?.querySelector('[data-wf="PatchNav"]')).not.toBeNull();
    expect(host?.textContent).toContain("剩余 · 2 处");
    expect(document.body.textContent).toContain("提交失败 · 候选已保留，请重试");
  });

  it("W1c 部分成功含单项 failed 时不误报整批未写入", async () => {
    const first = textReviewToolCall("p-partial-1", "batch-partial-1", 0);
    const second = textReviewToolCall("p-partial-2", "batch-partial-2", 1);
    const stream = await renderWorkspaceWithReview([first, second]);
    await emitFrames(stream, [{
      kind: "chatMessageAdded",
      data: {
        message: {
          id: "m-review-partial",
          role: { kind: "agent" },
          ts: "2026-07-17T00:00:00.000Z",
          parts: [{ kind: "patchSummary", data: { count: 2, hunkIds: [first.id, second.id] } }],
          chips: null,
        },
      },
    }]);
    const failedSecond: ToolCallSpec = {
      ...second,
      status: {
        kind: "failed",
        data: { retriable: false, reason: "1 处已写入，1 处因文档变化失效。" },
      },
    };
    mockCommitWithFrames(stream, [
      toolCallUpdatedFrame(failedSecond),
      {
        kind: "docCommitted",
        data: { sessionId: "s-1", version: 2, appliedCount: 1, conflictCount: 1 },
      },
      docStateFrame("editing"),
    ]);

    await clickButton("提交 ↵");
    await flushMicrotasks();

    expect(host?.querySelector<HTMLElement>(".qa-toast")?.textContent ?? "").not.toContain("本次修改未写入");
    const summary = host?.querySelector<HTMLElement>('[data-wf="PatchSummary"]');
    expect(summary?.textContent).toContain("1 处已写入，1 处因文档变化失效");
    expect(summary?.textContent).not.toContain("本轮修改未写入");
  });

  it("异常空快照不会让已有正文坍缩为空编辑器", async () => {
    const { WorkspacePage } = await import("./WorkspacePage");
    await render(<WorkspacePage />);
    const stream = latestServerStream();
    const stableDoc = pmDoc([
      pmParagraph("stable-1", "第一段包含足够多的有效正文内容。"),
      pmParagraph("stable-2", "第二段包含足够多的有效正文内容。"),
      pmParagraph("stable-3", "第三段继续维持完整文章结构。"),
    ]);
    await emitFrames(stream, [
      { kind: "sessionMeta", data: { sessionId: "s-1", title: "完整性门" } },
      { kind: "documentSnapshotWritten", data: { doc: wireSnapshotFromPmDoc(stableDoc, 1) } },
      docStateFrame("editing"),
    ]);

    await emitFrames(stream, [
      {
        kind: "documentSnapshotWritten",
        data: { doc: wireSnapshotFromPmDoc(pmDoc([]), 2) },
      },
    ]);

    expect(host?.textContent).toContain("第一段包含足够多的有效正文内容");
    expect(host?.querySelector('[data-wf="StarterPanel"]')).toBeNull();
    expect(document.body.textContent).toContain("检测到文档异常坍缩，已保留上一版正文");
  });

  it("A3 单处候选点击提交后整体提交一次并解锁输入", async () => {
    const stream = await renderWorkspaceWithReview([
      textReviewToolCall("p-1", "batch-a", 0),
    ]);
    mockCommitWithFrames(stream, [
      {
        kind: "docCommitted",
        data: { sessionId: "s-1", version: 2, appliedCount: 1, conflictCount: 0 },
      },
      docStateFrame("editing"),
    ]);

    await clickButton("提交 ↵");
    await flushMicrotasks(5);

    expect(stream.commitReviewGroups).toHaveBeenCalledTimes(1);
    expect(stream.commitReviewGroups).toHaveBeenCalledWith("s-1", {
      acceptReviewBatchIds: ["batch-a"],
      rejectReviewBatchIds: [],
    });
    expect(getChatEditor().getAttribute("contenteditable")).toBe("true");
  });

  it("提交已由实时帧成功结算而 REST 回执为 no-op 时不误报候选失效", async () => {
    const patch = textReviewToolCall("p-r59", "batch-r59", 0);
    const stream = await renderWorkspaceWithReview([patch]);
    const committedDoc = pmDoc([
      pmParagraph("block-p-r59", "新句子1"),
    ]);
    stream.commitReviewGroups.mockImplementation(async () => {
      // r59 真机时序：同一结算的实时帧先到并确认正文、候选与审阅终态，
      // REST 结果随后只回幂等 no-op。结果判定不能只看最后这组回执。
      for (const frame of [
        {
          kind: "documentSnapshotWritten",
          data: { doc: wireSnapshotFromPmDoc(committedDoc, 2) },
        },
        toolCallUpdatedFrame({ ...patch, status: { kind: "committed" } }),
        {
          kind: "docCommitted",
          data: {
            sessionId: "s-1",
            version: 2,
            appliedCount: 1,
            conflictCount: 0,
          },
        },
        docStateFrame("editing"),
      ] satisfies BridgeFrame[]) {
        stream.emit(frame);
      }
      return [{
        kind: "docStateChanged",
        data: {
          state: { kind: "editing" },
          activeOverlay: null,
          agentBusy: false,
          reviewCompletion: "noop",
        },
      } satisfies BridgeFrame];
    });

    await clickButton("提交 ↵");
    await flushMicrotasks(5);

    expect(document.body.dataset.content).toBe("editing");
    expect(host?.querySelector('[data-wf="PatchNav"]')).toBeNull();
    expect(host?.textContent).toContain("新句子1");
    expect(document.body.textContent).not.toContain("候选已失效");
    expect(document.body.textContent).not.toContain("本次未写入");
    expect(document.body.textContent).not.toContain("当前候选已保留");
  });

  it("CAS 真失效即使同时重放旧 docCommitted 仍保留候选并提示", async () => {
    const stream = await renderWorkspaceWithReview([
      textReviewToolCall("p-stale", "batch-stale", 0),
    ]);
    stream.commitReviewGroups.mockImplementation(async () => {
      // 恢复流可能在请求期间补发旧成功帧；版本没有前进，不能拿它给本次 no-op 背书。
      stream.emit({
        kind: "docCommitted",
        data: { sessionId: "s-1", version: 1, appliedCount: 1, conflictCount: 0 },
      });
      return [{
        kind: "docStateChanged",
        data: {
          state: { kind: "editing" },
          activeOverlay: null,
          agentBusy: false,
          reviewCompletion: "noop",
        },
      } satisfies BridgeFrame];
    });

    await clickButton("提交 ↵");
    await flushMicrotasks(5);

    expect(document.body.dataset.content).toBe("pendingReview");
    expect(host?.querySelector('[data-wf="PatchNav"]')).not.toBeNull();
    expect(document.body.textContent).toContain(
      "候选已失效，本次未写入；当前候选已保留",
    );
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

  it("pendingReview 候选无法在正文定位时仍显示提交与放弃入口", async () => {
    const { RightPane } = await import("./WorkspacePage");
    const onCommit = vi.fn();
    const onRejectAll = vi.fn();
    await render(
      <section id="view-workspace">
        <RightPane
          {...rightPaneProps({
            effectiveReview: false,
            reviewResolutionAvailable: true,
            visiblePatchCount: 0,
            remainingCount: 1,
            unrenderablePatchCount: 1,
            patchMeta: new Map(),
            onCommit,
            onRejectAll,
          })}
        />
      </section>,
    );

    const fallback = host?.querySelector(
      '[data-wf="PatchNav"][data-review-fallback="true"]',
    );
    expect(fallback?.textContent).toContain("修改候选待确认");
    expect(fallback?.textContent).toContain("提交 ↵");
    expect(fallback?.textContent).toContain("放弃全部");

    await clickButton("提交 ↵");
    expect(onCommit).toHaveBeenCalledTimes(1);

    await clickButton("放弃全部");
    await clickButton("确认放弃全部");
    expect(onRejectAll).toHaveBeenCalledTimes(1);
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
    const markAttachmentFailure = vi.fn();
    const setSendPending = vi.fn();
    const showToast = vi.fn();

    rollbackOptimisticChatSend({
      dispatch: (action) => {
        state = workspaceReducer(state, action);
      },
      chatInput: { restore, markAttachmentFailure },
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

  it("网络上传失败回滚后保留附件，并标成可重试的原位失败态", async () => {
    const [{ rollbackOptimisticChatSend }, { UploadAssetError }] = await Promise.all([
      import("./WorkspacePage"),
      import("./data/uploadAsset"),
    ]);
    const file = new File(["retry"], "retry.md", { type: "text/markdown" });
    const snapshot: ChatInputSnapshot = {
      text: "",
      chips: [{ kind: "attach", label: "retry.md" }],
      files: [file],
      richText: "{{chip:0}}",
      skills: [],
    };
    const restore = vi.fn();
    const markAttachmentFailure = vi.fn();
    const showToast = vi.fn();

    rollbackOptimisticChatSend({
      dispatch: vi.fn(),
      chatInput: { restore, markAttachmentFailure },
      snapshot,
      keepMessageCount: 0,
      setSendPending: vi.fn(),
      showToast,
      error: new UploadAssetError(
        "network",
        file,
        "文件上传失败，请重试",
        true,
      ),
    });

    expect(restore).toHaveBeenCalledWith(snapshot);
    expect(markAttachmentFailure).toHaveBeenCalledWith(
      file,
      "文件上传失败，请重试",
      true,
    );
    expect(showToast).toHaveBeenCalledWith("文件上传失败，请重试");
  });
});

describe("WorkspacePage existing session title hydration", () => {
  beforeEach(() => {
    vi.resetModules();
    serverStreamMock.instances.length = 0;
    window.location.hash = "#/workspace?session=s-existing";
    sessionStorage.clear();
    localStorage.setItem("qingagent.deepseek_api_key", "test-key");
    restoreWorkspaceDomMocks = installWorkspaceDomMocks();
  });

  afterEach(() => {
    serverStreamMock.startSessionImpl = null;
    restoreWorkspaceDomMocks?.();
    restoreWorkspaceDomMocks = null;
    localStorage.removeItem("qingagent.deepseek_api_key");
    vi.useRealTimers();
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
  });

  it("URL 带 session 的首次 mount 同批恢复正文、聊天、批注与候选态", async () => {
    const annotation: AnnotationGroup = {
      id: "deeplink-annotation",
      summary: "深链批注已恢复",
      note: "冷启动后仍保留锚点。",
      origin: "自定义审查:深链",
      suggestion: "核对这段正文",
      severity: "error",
      status: "reviewing",
      anchors: [{
        blockId: "deeplink-body",
        pmFrom: 1,
        pmTo: 3,
        quote: "深链",
        textHash: "deeplink-annotation-hash",
      }],
    };
    const candidate = reviewSuggestion({
      id: "deeplink-candidate",
      blockId: "deeplink-body",
      pmFrom: 1,
      pmTo: 3,
      before: "深链",
      after: "冷启动深链",
    });
    serverStreamMock.startSessionImpl = async (stream, data) => {
      expect(data).toEqual({
        mode: { kind: "existing", data: { id: "s-existing" } },
      });
      const frames: BridgeFrame[] = [
        {
          kind: "restoreReset",
          data: { epoch: 1, snapshotSeq: 1 },
        },
        {
          kind: "sessionMeta",
          data: { sessionId: "s-existing", title: "深链恢复会话" },
        },
        {
          kind: "docStateChanged",
          data: {
            state: { kind: "pendingReview" },
            activeOverlay: null,
            agentBusy: false,
          },
        },
        {
          kind: "documentSnapshotWritten",
          data: {
            doc: wireSnapshotFromPmDoc(
              pmDoc([
                pmHeading("deeplink-heading", "深链恢复标题"),
                pmParagraph("deeplink-body", "深链恢复正文"),
              ]),
              9,
            ),
          },
        },
        {
          kind: "chatMessageAdded",
          data: {
            message: {
              id: "deeplink-user",
              role: { kind: "user" },
              ts: "2026-08-03T00:00:00.000Z",
              parts: [{ kind: "text", data: { body: "首轮深链提示" } }],
              chips: null,
            },
            appendSeq: 0,
          },
        },
        {
          kind: "chatMessageAdded",
          data: {
            message: {
              id: "deeplink-agent",
              role: { kind: "agent" },
              ts: "2026-08-03T00:00:01.000Z",
              parts: [{ kind: "text", data: { body: "首轮完成文本" } }],
              chips: null,
            },
            appendSeq: 0,
          },
        },
        {
          kind: "annotationGroupsReady",
          data: { groups: [annotation] },
        },
        {
          kind: "docDiffReady",
          data: { baseVersion: 9, suggestions: [candidate] },
        },
        {
          kind: "sessionRestoreCompleted",
          data: { sessionId: "s-existing" },
        },
      ];
      for (const frame of frames) stream.emit(frame);
      return "s-existing";
    };

    const [
      { useWorkspacePageController },
      { WorkspaceChatPane },
      { WorkspaceDocumentPane },
    ] = await Promise.all([
      import("./WorkspacePage"),
      import("./components/WorkspaceChatPane"),
      import("./components/WorkspaceDocumentPane"),
    ]);
    const captured: {
      current: ReturnType<typeof useWorkspacePageController> | null;
    } = { current: null };
    function DeeplinkMountHarness() {
      const controller = useWorkspacePageController();
      captured.current = controller;
      return (
        <>
          <WorkspaceChatPane controller={controller} />
          <WorkspaceDocumentPane controller={controller} />
        </>
      );
    }
    await render(<DeeplinkMountHarness />);
    await flushMicrotasks(8);

    expect(host?.textContent).toContain("深链恢复标题");
    expect(host?.textContent).toContain("深链恢复正文");
    expect(host?.textContent).toContain("首轮深链提示");
    expect(host?.textContent).toContain("首轮完成文本");
    expect(host?.querySelectorAll('[data-wf="ChatMsg-user"]')).toHaveLength(1);
    expect(host?.querySelectorAll('[data-wf="ChatMsg-agent"]')).toHaveLength(1);
    expect(captured.current?.state.annotationGroups).toEqual([annotation]);
    expect(captured.current?.state.docState).toEqual({ kind: "pendingReview" });
    expect(captured.current ? selectPatches(captured.current.state) : []).toHaveLength(1);
    expect(host?.querySelector('[data-wf="PatchNav"]')).not.toBeNull();
  }, 60_000);

  it("B14 进入已有会话时，恢复完成前不清空 store 标题", async () => {
    const { useSessionStore } = await import("../../stores/sessionStore");
    useSessionStore.setState({
      sessions: [{
        id: "s-existing",
        title: "已有标题",
        created_at: "2026-07-27T00:00:00.000Z",
        summary: "",
        status: { kind: "Active" },
        generating: false,
      }],
      currentSessionId: null,
      currentSessionTitle: null,
    });
    serverStreamMock.startSessionImpl = () => new Promise<string>(() => undefined);

    const { WorkspacePage } = await import("./WorkspacePage");
    await render(<WorkspacePage />);
    await flushMicrotasks(5);

    expect(useSessionStore.getState().sessions[0]?.title).toBe("已有标题");
    expect(useSessionStore.getState().currentSessionTitle).toBe("已有标题");
  });

  it("B14 已有会话恢复失败后，store 标题保持原值", async () => {
    vi.useFakeTimers();
    const { useSessionStore } = await import("../../stores/sessionStore");
    useSessionStore.setState({
      sessions: [{
        id: "s-existing",
        title: "恢复前标题",
        created_at: "2026-07-27T00:00:00.000Z",
        summary: "",
        status: { kind: "Active" },
        generating: false,
      }],
      currentSessionId: null,
      currentSessionTitle: null,
    });
    serverStreamMock.startSessionImpl = async () => {
      throw new Error("Stream request failed: 503");
    };

    const { WorkspacePage } = await import("./WorkspacePage");
    await render(<WorkspacePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500);
    });
    await flushMicrotasks(5);

    expect(latestServerStream().startSession).toHaveBeenCalledTimes(4);
    expect(useSessionStore.getState().sessions[0]?.title).toBe("恢复前标题");
    expect(useSessionStore.getState().currentSessionTitle).toBe("恢复前标题");
    expect(host?.textContent).toContain("恢复失败");
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
    const baseContentHash = getPmContentHash(baseline);

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
      baseContentHash,
      pmDoc: baseline,
      baselineDoc: baseline,
      hasPendingDocSave: false,
      createMutationId: () => "exit-skip",
    })).toBeNull();

    const command = buildPageExitDocSaveCommand({
      sessionId: "session-1",
      expectedDocumentSnapshot: 7,
      baseContentHash,
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
        baseContentHash,
        clientMutationId: "exit-1",
      },
    });
    expect(command?.data.legacySections).toBeUndefined();
  });

  it("page-exit flush 优先 sendBeacon,失败时回退 keepalive fetch", async () => {
    const { flushDocSaveOnPageExit } = await import("./WorkspacePage");
    const baseline = pmDoc([pmParagraph("p-1", "旧正文")]);
    const edited = pmDoc([pmParagraph("p-1", "新正文")]);
    const baseContentHash = getPmContentHash(baseline);
    const sendBeacon = vi.fn((_url: string, _data?: BodyInit | null) => true);

    expect(flushDocSaveOnPageExit({
      sessionId: "session-1",
      expectedDocumentSnapshot: 7,
      baseContentHash,
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
        baseContentHash,
        clientMutationId: "exit-beacon",
      },
    });

    const fetchKeepalive = vi.fn(async (_url: string, _init: RequestInit) => new Response(""));
    expect(flushDocSaveOnPageExit({
      sessionId: "session-1",
      expectedDocumentSnapshot: 8,
      baseContentHash,
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
        baseContentHash,
        clientMutationId: "exit-fetch",
      },
    });
  });

  it("后台兜底等待在途保存结算后，使用 N+1 提交最新正文", async () => {
    const { flushDocSaveInBackground } = await import("./WorkspacePage");
    const baseline = pmDoc([pmParagraph("p-1", "版本 N")]);
    const pendingSaved = pmDoc([pmParagraph("p-1", "在途正文 B")]);
    const latest = pmDoc([pmParagraph("p-1", "最新正文 C")]);
    let resolvePending!: (base: {
      expectedDocumentSnapshot: number;
      baseContentHash: string;
    }) => void;
    const pendingBase = new Promise<{
      expectedDocumentSnapshot: number;
      baseContentHash: string;
    }>((resolve) => {
      resolvePending = resolve;
    });
    const submitted: Array<Extract<Command, { kind: "updateDoc" }>> = [];
    const fetchKeepalive = vi.fn(async (_url: string, init: RequestInit) => {
      const command = JSON.parse(String(init.body)) as Extract<
        Command,
        { kind: "updateDoc" }
      >;
      submitted.push(command);
      return new Response(JSON.stringify([{
        kind: "docWriteResult",
        data: {
          ok: true,
          clientMutationId: command.data.clientMutationId,
          docVersion: command.data.expectedDocumentSnapshot + 1,
        },
      }]), { status: 200 });
    });
    const save = flushDocSaveInBackground({
      sessionId: "session-1",
      fallbackBase: {
        expectedDocumentSnapshot: 7,
        baseContentHash: getPmContentHash(baseline),
      },
      pendingBase,
      pmDoc: latest,
      baselineDoc: baseline,
      hasPendingDocSave: true,
      createMutationId: () => "exit-after-b",
      fetchKeepalive,
    });

    await flushMicrotasks(2);
    expect(fetchKeepalive).not.toHaveBeenCalled();
    resolvePending({
      expectedDocumentSnapshot: 8,
      baseContentHash: getPmContentHash(pendingSaved),
    });
    await expect(save).resolves.toBe("saved");

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.data.expectedDocumentSnapshot).toBe(8);
    expect(submitted[0]?.data.baseContentHash).toBe(
      getPmContentHash(pendingSaved),
    );
    expect(submitted[0]?.data.doc).toEqual(latest);
  });

  it("在途保存永不结算时，后台链 10 秒后仍按最新已知基底尝试一次", async () => {
    const { flushDocSaveInBackground } = await import("./WorkspacePage");
    const baseline = pmDoc([pmParagraph("p-1", "版本 N")]);
    const latest = pmDoc([pmParagraph("p-1", "不能丢的正文 C")]);
    const fetchKeepalive = vi.fn(async (_url: string, init: RequestInit) => {
      const command = JSON.parse(String(init.body)) as Extract<
        Command,
        { kind: "updateDoc" }
      >;
      return new Response(JSON.stringify([{
        kind: "docWriteResult",
        data: {
          ok: true,
          clientMutationId: command.data.clientMutationId,
          docVersion: 8,
        },
      }]), { status: 200 });
    });
    vi.useFakeTimers();
    const save = flushDocSaveInBackground({
      sessionId: "session-1",
      fallbackBase: {
        expectedDocumentSnapshot: 7,
        baseContentHash: getPmContentHash(baseline),
      },
      pendingBase: new Promise(() => undefined),
      pmDoc: latest,
      baselineDoc: baseline,
      hasPendingDocSave: true,
      createMutationId: () => "exit-timeout",
      fetchKeepalive,
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchKeepalive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(save).resolves.toBe("saved");
    const command = JSON.parse(
      String(fetchKeepalive.mock.calls[0]?.[1].body),
    ) as Extract<Command, { kind: "updateDoc" }>;
    expect(command.data.expectedDocumentSnapshot).toBe(7);
    expect(command.data.doc).toEqual(latest);
  });

  it("后台兜底首次 conflict 后读取服务端最新基底并只重试一次", async () => {
    const { flushDocSaveInBackground } = await import("./WorkspacePage");
    const baseline = pmDoc([pmParagraph("p-1", "旧正文")]);
    const latest = pmDoc([pmParagraph("p-1", "冲突后正文")]);
    const submitted: Array<Extract<Command, { kind: "updateDoc" }>> = [];
    const mutationIds = ["exit-conflict", "exit-retry"];
    const fetchKeepalive = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "GET") {
        expect(url).toContain("/api/v1/history?sessionId=session-1");
        return new Response(JSON.stringify({
          entries: [{
            docVersion: 8,
            content_hash: "server-hash-8",
          }],
        }), { status: 200 });
      }
      const command = JSON.parse(String(init.body)) as Extract<
        Command,
        { kind: "updateDoc" }
      >;
      submitted.push(command);
      const first = submitted.length === 1;
      return new Response(JSON.stringify([{
        kind: "docWriteResult",
        data: first
          ? {
              ok: false,
              clientMutationId: command.data.clientMutationId,
              conflict: {
                expectedDocumentSnapshot:
                  command.data.expectedDocumentSnapshot,
                actualDocumentSnapshot: 8,
              },
            }
          : {
              ok: true,
              clientMutationId: command.data.clientMutationId,
              docVersion: 9,
            },
      }]), { status: 200 });
    });

    await expect(flushDocSaveInBackground({
      sessionId: "session-1",
      fallbackBase: {
        expectedDocumentSnapshot: 7,
        baseContentHash: getPmContentHash(baseline),
      },
      pmDoc: latest,
      baselineDoc: baseline,
      hasPendingDocSave: true,
      createMutationId: () => mutationIds.shift() ?? "unexpected-third",
      fetchKeepalive,
    })).resolves.toBe("saved");

    expect(submitted).toHaveLength(2);
    expect(submitted[0]?.data.expectedDocumentSnapshot).toBe(7);
    expect(submitted[1]?.data).toMatchObject({
      expectedDocumentSnapshot: 8,
      baseContentHash: "server-hash-8",
      clientMutationId: "exit-retry",
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
  const originalNavigatorLocks = navigator.locks;
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
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => unknown,
      ) => callback({ name, mode: "exclusive" }),
    },
  });
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
    restoreProperty(navigator, "locks", originalNavigatorLocks);
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
  const [
    { ConfirmProvider },
    { ToastProvider },
    { WorkspaceEditorSelectionProvider },
  ] = await Promise.all([
    import("../../system/ConfirmProvider"),
    import("../../system/ToastProvider"),
    import("../../system/WorkspaceEditorSelectionCache"),
  ]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ToastProvider>
        <ConfirmProvider>
          <WorkspaceEditorSelectionProvider>
            {element}
          </WorkspaceEditorSelectionProvider>
        </ConfirmProvider>
      </ToastProvider>,
    );
  });
}

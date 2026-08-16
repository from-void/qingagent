import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnnotationGroup,
  BridgeFrame,
  DiffHunk,
  DocSuggestion,
} from "@qingagent/contract-ts";
import {
  getPmContentHash,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
} from "@qingagent/pm-schema";
import {
  commitReviewGroups,
  createSession,
  deriveContentState,
  expandReviewIds,
  updatePatchVerdict,
  type SessionState,
} from "../bridge/index.js";
import { buildDraftDiff } from "../doc-engine/proposalDiff.js";
import {
  documentDraftRepo,
  documentRepo,
  getDocumentsClient,
  insertAnnotationGroups,
  listDocumentSuggestionStatuses,
  upsertDocumentSuggestion,
} from "@qingagent/db";
import { findOpByDocumentVersion } from "@qingagent/db";
import {
  documentInput,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";
import { mastra } from "../mastra.js";
import { buildDocVersionAwarenessContent } from "../llm/docVersionAwarenessPrompt.js";

let tempDb: TempDocumentsDb;

function text(value: string): PmInlineNode {
  return { type: "text", text: value };
}

function paragraph(blockId: string, value: string): PmBlockNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: [text(value)],
  };
}

function heading(blockId: string, value: string): PmBlockNode {
  return {
    type: "heading",
    attrs: { blockId, level: 1 },
    content: [text(value)],
  };
}

function bulletList(blockId: string, items: Array<{ blockId: string; text: string }>): PmBlockNode {
  return {
    type: "bulletList",
    attrs: { blockId },
    content: items.map((item) => ({
      type: "listItem",
      attrs: { blockId: item.blockId },
      content: [paragraph(`${item.blockId}-p`, item.text) as Extract<PmBlockNode, { type: "paragraph" }>],
    })),
  };
}

function firstListTexts(pmDoc: PmDoc | undefined): string[] {
  const list = pmDoc?.content[0];
  if (list?.type !== "bulletList") return [];
  return list.content.map((item) => {
    const paragraphNode = item.content[0];
    return paragraphNode?.type === "paragraph"
      ? (paragraphNode.content ?? []).map((node) => node.type === "text" ? node.text : "").join("")
      : "";
  });
}

function diagram(
  blockId: string,
  source: string,
  withUserLayout = false,
): PmBlockNode {
  return {
    type: "diagram",
    attrs: {
      blockId,
      lang: "mermaid",
      source,
      svg: null,
      ...(withUserLayout
        ? {
            overlay: { positions: { A: { x: 110, y: 160 }, B: { x: 361, y: 100 } } },
            width: 654,
            height: 645,
            align: "left" as const,
          }
        : {}),
    },
  };
}

function expectMovedDiagramLayout(pmDoc: PmDoc | null | undefined): void {
  const moved = pmDoc?.content.find((block) => block.type === "diagram");
  expect(moved?.type).toBe("diagram");
  if (moved?.type !== "diagram") throw new Error("expected moved diagram");
  expect(moved.attrs.overlay).toEqual({
    positions: { A: { x: 110, y: 160 }, B: { x: 361, y: 100 } },
  });
  expect(moved.attrs.width).toBe(654);
  expect(moved.attrs.height).toBe(645);
  expect(moved.attrs.align).toBe("left");
}

function doc(content: PmBlockNode[]): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content,
  };
}

function docText(pmDoc: PmDoc | undefined): string {
  return (pmDoc?.content ?? [])
    .map((block) =>
      "content" in block
        ? (block.content ?? []).map((node) => (node.type === "text" ? node.text : "\n")).join("")
        : "",
    )
    .join("\n");
}

function docBlocks(pmDoc: PmDoc | undefined): Array<{ blockId: string | undefined; text: string }> {
  return (pmDoc?.content ?? []).map((block) => ({
    blockId: block.attrs.blockId,
    text: "content" in block
      ? (block.content ?? []).map((node) => (node.type === "text" ? node.text : "\n")).join("")
      : "",
  }));
}

async function collectFrames(gen: AsyncIterable<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function suggestionFromHunk(state: SessionState, hunk: DiffHunk): DocSuggestion {
  const pmFrom = hunk.anchor.pmFrom ?? 0;
  const pmTo = hunk.anchor.pmTo ?? pmFrom;
  const quote = hunk.beforeText || hunk.afterText || hunk.summary || hunk.hunkId;
  return {
    id: hunk.hunkId,
    reviewBatchId: hunk.reviewBatchId,
    groupMode: hunk.groupMode,
    docId: state.docId,
    baseVersion: state.docVersion,
    baseSchemaVersion: state.doc?.attrs.schemaVersion ?? 1,
    status: "reviewing",
    anchor: {
      blockId: hunk.anchor.blockId ?? hunk.hunkId,
      pmFrom,
      pmTo,
      quote,
      textHash: `hash-${hunk.hunkId}`,
    },
    patch: {
      kind: "prosemirror_steps",
      steps: [{ stepType: "replace", from: pmFrom, to: pmTo }],
    },
    preview: {
      deleteText: hunk.beforeText ?? "",
      insertText: hunk.afterText ?? "",
    },
    diffHunk: hunk,
    summary: hunk.summary,
  };
}

async function seedDiffState(state: SessionState, base: PmDoc, draft: PmDoc): Promise<DiffHunk[]> {
  state.doc = base;
  state.docVersion = 1;
  state.docState = { kind: "pendingReview" };
  state.suggestionBaseDoc = base;
  state.suggestionBaseVersion = state.docVersion;
  state.docDraftBaseDoc = base;
  state.docDraftBaseVersion = state.docVersion;
  state.docDraftCandidateDoc = draft;

  const hunks = buildDraftDiff(base, draft, { baseVersion: state.docVersion });
  for (const hunk of hunks) {
    const suggestion = suggestionFromHunk(state, hunk);
    state.suggestions.set(suggestion.id, {
      messageId: "msg-review",
      toolCallId: suggestion.id,
      before: hunk.beforeText ?? "",
      after: hunk.afterText ?? "",
      blockPath: [...hunk.blockPath],
      blockIndex: hunk.blockPath[0] ?? 0,
      suggestion,
      diffHunk: hunk,
    });
    await upsertDocumentSuggestion(suggestion);
  }
  return hunks;
}

async function seedReviewRound(
  state: SessionState,
  base: PmDoc,
  draft: PmDoc,
): Promise<DiffHunk[]> {
  state.doc = base;
  state.docState = { kind: "pendingReview" };
  state.suggestionBaseDoc = base;
  state.suggestionBaseVersion = state.docVersion;
  state.docDraftBaseDoc = base;
  state.docDraftBaseVersion = state.docVersion;
  state.docDraftCandidateDoc = draft;

  const hunks = buildDraftDiff(base, draft, { baseVersion: state.docVersion });
  for (const hunk of hunks) {
    const suggestion = suggestionFromHunk(state, hunk);
    state.suggestions.set(suggestion.id, {
      messageId: `msg-review-v${state.docVersion}`,
      toolCallId: suggestion.id,
      before: hunk.beforeText ?? "",
      after: hunk.afterText ?? "",
      blockPath: [...hunk.blockPath],
      blockIndex: hunk.blockPath[0] ?? 0,
      suggestion,
      diffHunk: hunk,
    });
    await upsertDocumentSuggestion(suggestion);
  }
  return hunks;
}

async function seedHunksState(
  state: SessionState,
  base: PmDoc,
  hunks: readonly DiffHunk[],
): Promise<void> {
  state.doc = base;
  state.docVersion = 1;
  state.docState = { kind: "pendingReview" };
  state.suggestionBaseDoc = base;
  state.suggestionBaseVersion = state.docVersion;
  state.docDraftBaseDoc = base;
  state.docDraftBaseVersion = state.docVersion;
  state.docDraftCandidateDoc = base;

  for (const hunk of hunks) {
    const suggestion = suggestionFromHunk(state, hunk);
    state.suggestions.set(suggestion.id, {
      messageId: "msg-review",
      toolCallId: suggestion.id,
      before: hunk.beforeText ?? "",
      after: hunk.afterText ?? "",
      blockPath: [...hunk.blockPath],
      blockIndex: hunk.blockPath[0] ?? 0,
      suggestion,
      diffHunk: hunk,
    });
    await upsertDocumentSuggestion(suggestion);
  }
}

function inlineReplaceHunk(input: {
  id: string;
  blockId: string;
  from: number;
  to: number;
  before: string;
  after: string;
}): DiffHunk {
  return {
    hunkId: input.id,
    reviewBatchId: input.id,
    groupMode: "independent",
    op: "replace",
    blockPath: [0],
    anchor: {
      blockId: input.blockId,
      quoteBefore: input.before,
      quoteAfter: input.after,
      pmFrom: 1 + input.from,
      pmTo: 1 + input.to,
      anchorKind: "range",
    },
    before: input.before ? [text(input.before)] as never : [],
    after: input.after ? [text(input.after)] as never : [],
    beforeText: input.before,
    afterText: input.after,
    summary: "替换文本",
  };
}

function blockInsertHunk(input: {
  id: string;
  anchorBlockId: string;
  block: PmBlockNode;
  text: string;
}): DiffHunk {
  return {
    hunkId: input.id,
    reviewBatchId: input.id,
    groupMode: "independent",
    op: "insert",
    blockPath: [1],
    anchor: {
      blockId: input.anchorBlockId,
      quoteAfter: input.text,
      anchorKind: "position",
      gravity: "after",
    },
    before: null,
    after: [input.block] as never,
    afterBlock: input.block as never,
    afterText: input.text,
    summary: "插入块",
  };
}

async function seedDocumentRow(state: SessionState): Promise<void> {
  await documentRepo.save(
    documentInput(state.docId, {
      threadId: state.threadId ?? state.sessionId,
      resourceId: state.resourceId,
      docVersion: state.docVersion,
      pmDoc: state.doc!,
    }),
  );
}

beforeEach(() => {
  tempDb = prepareTempDocumentsDb("qingagent-commit-groups-");
});

afterEach(() => {
  vi.restoreAllMocks();
  tempDb.cleanup();
});

describe("commitReviewGroups", () => {
  it("全采纳快路径承接移动图布局并以复数 suggestionIds 拍权威候选", async () => {
    const source = "flowchart TD\n  A[开始] --> B[结束]";
    const state = createSession("diagram-move-whole-candidate");
    const base = doc([
      diagram("diagram-old", source, true),
      paragraph("paragraph-keep", "保留正文"),
    ]);
    const draftWithoutLayout = doc([
      paragraph("paragraph-keep", "保留正文"),
      diagram("diagram-new", source),
    ]);
    const hunks = await seedReviewRound(state, base, draftWithoutLayout);
    await seedDocumentRow(state);

    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: hunks.map((hunk) => hunk.reviewBatchId ?? hunk.hunkId),
    }));

    expect(hunks.map((hunk) => hunk.op).sort()).toEqual(["delete", "insert"]);
    expectMovedDiagramLayout(state.doc);
    const op = await findOpByDocumentVersion(state.docId, state.docVersion);
    expect(op?.steps).toHaveLength(1);
    expect(op?.steps?.[0]?.suggestionIds).toHaveLength(2);
    expect(op?.steps?.[0]?.suggestionId).toBeUndefined();
    expect((op?.steps?.[0]?.slice as { content?: PmBlockNode[] } | undefined)?.content
      ?.find((block) => block.type === "diagram")).toMatchObject({
        attrs: {
          overlay: { positions: { A: { x: 110, y: 160 }, B: { x: 361, y: 100 } } },
          width: 654,
          height: 645,
          align: "left",
        },
      });
    const committedFrame = frames.find((frame) => frame.kind === "docCommitted");
    expect(committedFrame).toMatchObject({
      kind: "docCommitted",
      data: { conflictCount: 0 },
    });
    expect((committedFrame as { data?: { notice?: string } } | undefined)?.data?.notice)
      .toBeUndefined();
  });

  it("部分采纳 hunk 路径承接移动图布局并为每步记录单数 suggestionId", async () => {
    const source = "flowchart TD\n  A[开始] --> B[结束]";
    const state = createSession("diagram-move-partial-hunks");
    const base = doc([
      diagram("diagram-old", source, true),
      paragraph("paragraph-edit", "保留旧文"),
    ]);
    const draftWithoutLayout = doc([
      paragraph("paragraph-edit", "保留新文"),
      diagram("diagram-new", source),
    ]);
    const hunks = await seedReviewRound(state, base, draftWithoutLayout);
    await seedDocumentRow(state);
    const moveHunks = hunks.filter((hunk) => hunk.op === "delete" || hunk.op === "insert");
    const pendingHunk = hunks.find((hunk) => hunk.op === "replace");
    if (moveHunks.length !== 2 || !pendingHunk) throw new Error("fixture missing move hunks");

    await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: moveHunks.map((hunk) => hunk.reviewBatchId ?? hunk.hunkId),
      keepPendingReviewBatchIds: [pendingHunk.reviewBatchId ?? pendingHunk.hunkId],
    }));

    expectMovedDiagramLayout(state.doc);
    const op = await findOpByDocumentVersion(state.docId, state.docVersion);
    expect(op?.steps).toHaveLength(2);
    expect(op?.steps?.every((step) => typeof step.suggestionId === "string")).toBe(true);
    expect(op?.steps?.every((step) => step.suggestionIds === undefined)).toBe(true);
    const insertStep = op?.steps?.find((step) =>
      (step.slice as { content?: PmBlockNode[] } | undefined)?.content?.some(
        (block) => block.type === "diagram",
      )
    );
    expect((insertStep?.slice as { content?: PmBlockNode[] } | undefined)?.content?.[0])
      .toMatchObject({
        attrs: {
          overlay: { positions: { A: { x: 110, y: 160 }, B: { x: 361, y: 100 } } },
          width: 654,
          height: 645,
          align: "left",
        },
      });
  });

  it("内容不同的图不误配布局，并在属性确实丢失时返回非阻断告知", async () => {
    const state = createSession("diagram-move-no-false-match");
    const base = doc([
      diagram("diagram-old", "flowchart TD\n  A[旧图] --> B[结束]", true),
      paragraph("paragraph-keep", "保留正文"),
    ]);
    const draft = doc([
      paragraph("paragraph-keep", "保留正文"),
      diagram("diagram-new", "flowchart TD\n  X[新图] --> Y[结束]"),
    ]);
    const hunks = await seedReviewRound(state, base, draft);
    await seedDocumentRow(state);

    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: hunks.map((hunk) => hunk.reviewBatchId ?? hunk.hunkId),
    }));

    const inserted = state.doc?.content.find((block) => block.type === "diagram");
    expect(inserted?.type).toBe("diagram");
    if (inserted?.type !== "diagram") throw new Error("expected inserted diagram");
    expect(inserted.attrs.overlay).toBeUndefined();
    expect(inserted.attrs.width).toBeUndefined();
    expect(inserted.attrs.height).toBeUndefined();
    expect(inserted.attrs.align).toBeUndefined();
    const committed = frames.find((frame) => frame.kind === "docCommitted");
    expect(committed?.kind === "docCommitted"
      ? (committed.data as { notice?: string }).notice
      : undefined).toContain("手工布局");
  });

  it("提交单处 H1 标题候选会写入正文，titlePinned 元标题保持不变且不报伪缺失", async () => {
    const state = createSession("commit-pinned-h1-title");
    const base = doc([
      heading("title-block", "晚灯书屋速写—r81A席乙"),
      paragraph("body-block", "正文保持不变。"),
    ]);
    const draft = doc([
      heading("title-block", "晚灯书屋"),
      paragraph("body-block", "正文保持不变。"),
    ]);
    state.title = "晚灯书屋速写—r81A席乙";
    state.titlePinned = true;
    state.doc = base;
    state.docVersion = 1;
    state.chatHistory.push({
      id: "msg-review-v1",
      role: { kind: "agent" },
      ts: "2026-08-03T08:00:42.000Z",
      parts: [],
      chips: null,
    });
    await seedDocumentRow(state);
    const hunks = await seedReviewRound(state, base, draft);
    const historyWarning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [hunks[0]!.reviewBatchId ?? hunks[0]!.hunkId],
    }));

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      anchor: { blockId: "title-block" },
      beforeText: "速写—r81A席乙",
      afterText: "",
    });
    expect(frames.some((frame) => frame.kind === "docCommitted")).toBe(true);
    expect(docText(state.doc)).toBe("晚灯书屋\n正文保持不变。");
    expect(state.title).toBe("晚灯书屋速写—r81A席乙");
    expect(docText((await documentRepo.load(state.docId))?.pmDoc)).toBe(
      "晚灯书屋\n正文保持不变。",
    );
    expect(historyWarning).not.toHaveBeenCalledWith(
      "updateToolCallInChatHistory: toolCall part not found",
      expect.anything(),
    );
  });

  it("连续三轮大候选全部应用均基于最新落库版本写入权威候选", async () => {
    const state = createSession("three-large-apply-all-rounds");
    const initial = doc(
      Array.from({ length: 80 }, (_, index) =>
        paragraph(`block-${index}`, `第 ${index + 1} 段初始正文，包含稳定的审阅基线。`),
      ),
    );
    state.doc = initial;
    state.docVersion = 1;
    await seedDocumentRow(state);

    let base = initial;
    for (let round = 1; round <= 3; round += 1) {
      const draft = doc(
        Array.from({ length: 80 }, (_, index) =>
          paragraph(
            `block-${index}`,
            `第 ${index + 1} 段第 ${round} 轮完整改写，必须全部可靠落库。`,
          ),
        ),
      );
      const hunks = await seedReviewRound(state, base, draft);
      expect(hunks.length).toBeGreaterThanOrEqual(70);

      const frames = await collectFrames(commitReviewGroups(state, {
        acceptReviewBatchIds: [
          ...new Set(hunks.map((hunk) => hunk.reviewBatchId ?? hunk.hunkId)),
        ],
      }));

      expect(frames.some((frame) => frame.kind === "docCommitted")).toBe(true);
      expect(state.docVersion).toBe(round + 1);
      expect(state.doc).toEqual(draft);
      expect(state.suggestions.size).toBe(0);
      expect((await documentRepo.load(state.docId))?.pmDoc).toEqual(draft);
      base = draft;
    }
  });

  it("全部应用遇到空候选坍缩时不落库且保留候选", async () => {
    const state = createSession("apply-all-empty-collapse");
    const base = doc([
      paragraph("p-1", "第一段包含足够多的有效正文内容。"),
      paragraph("p-2", "第二段包含足够多的有效正文内容。"),
      paragraph("p-3", "第三段继续维持完整文章结构。"),
    ]);
    state.doc = base;
    state.docVersion = 1;
    await seedDocumentRow(state);
    const hunks = await seedReviewRound(state, base, doc([]));

    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [
        ...new Set(hunks.map((hunk) => hunk.reviewBatchId ?? hunk.hunkId)),
      ],
    }));

    expect(frames.some((frame) => frame.kind === "docCommitted")).toBe(false);
    expect(frames.some((frame) => frame.kind === "documentSnapshotWritten")).toBe(false);
    expect(state.docVersion).toBe(1);
    expect(state.doc).toEqual(base);
    expect(state.suggestions.size).toBe(hunks.length);
    expect(deriveContentState(state)).toEqual({ kind: "pendingReview" });
    expect((await documentRepo.load(state.docId))?.pmDoc).toEqual(base);
  });

  it("acceptPatch 对已解决 reviewBatchId 做成功 no-op 并记录 warn", async () => {
    const state = createSession("noop-verdict");
    const base = doc([paragraph("block-a", "正文")]);
    state.doc = base;
    state.docVersion = 1;
    state.docState = { kind: "pendingReview" };
    const warn = vi.spyOn(mastra.getLogger(), "warn").mockImplementation(() => undefined);

    const frames = await collectFrames(updatePatchVerdict(
      state,
      undefined,
      "accepted",
      "resolved-batch",
    ));

    expect(frames).toEqual([
      {
        kind: "docStateChanged",
        data: {
          state: { kind: "editing" },
          activeOverlay: null,
          agentBusy: false,
          reviewCompletion: "noop",
        },
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      "Skipped unknown or resolved review target",
      expect.objectContaining({
        sessionId: "noop-verdict",
        command: "accept",
        reviewBatchId: "resolved-batch",
        stateSuggestionRecordCount: 0,
        skipped: "patchVerdictTarget",
        remainingValidIdCount: 0,
      }),
    );
  });

  it("commitReviewGroups 对已解决 reviewBatchId 做成功 no-op、返回解锁帧并记录 warn", async () => {
    const state = createSession("noop-commit");
    const base = doc([paragraph("block-a", "正文")]);
    state.doc = base;
    state.docVersion = 1;
    state.docState = { kind: "pendingReview" };
    const warn = vi.spyOn(mastra.getLogger(), "warn").mockImplementation(() => undefined);

    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: ["resolved-accept"],
      rejectReviewBatchIds: ["resolved-reject"],
      keepPendingReviewBatchIds: ["resolved-keep"],
    }));

    expect(frames).toEqual([
      {
        kind: "docStateChanged",
        data: {
          state: { kind: "editing" },
          activeOverlay: null,
          agentBusy: false,
          reviewCompletion: "noop",
        },
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      "Skipped unknown or resolved review target",
      expect.objectContaining({
        sessionId: "noop-commit",
        command: "commit",
        reviewBatchId: "resolved-accept",
        stateSuggestionRecordCount: 0,
        skipped: "acceptReviewBatchId",
        remainingValidIdCount: 0,
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      "Skipped unknown or resolved review target",
      expect.objectContaining({
        sessionId: "noop-commit",
        command: "commit",
        reviewBatchId: "resolved-reject",
        stateSuggestionRecordCount: 0,
        skipped: "rejectReviewBatchId",
        remainingValidIdCount: 0,
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      "Skipped unknown or resolved review target",
      expect.objectContaining({
        sessionId: "noop-commit",
        command: "commit",
        reviewBatchId: "resolved-keep",
        stateSuggestionRecordCount: 0,
        skipped: "keepPendingReviewBatchId",
        remainingValidIdCount: 0,
      }),
    );
  });

  it("跳过未知目标时记录当前真实 suggestion 数量", async () => {
    const state = createSession("noop-commit-with-pending-suggestion");
    const base = doc([paragraph("block-a", "正文")]);
    const draft = doc([paragraph("block-a", "修改后正文")]);
    await seedDiffState(state, base, draft);
    const warn = vi.spyOn(mastra.getLogger(), "warn").mockImplementation(() => undefined);

    await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: ["resolved-accept"],
    }));

    expect(warn).toHaveBeenCalledWith(
      "Skipped unknown or resolved review target",
      expect.objectContaining({
        stateSuggestionRecordCount: 1,
        skipped: "acceptReviewBatchId",
      }),
    );
  });

  it("单 patch id 不再按 groupMode 扩展为整组", async () => {
    const state = createSession("per-hunk-expand");
    const base = doc([paragraph("block-a", "湖边有柳树。他拿着蓝毛巾。")]);
    const draft = doc([paragraph("block-a", "湖边有胡桃树。他拿着黄毛巾。")]);
    const hunks = await seedDiffState(state, base, draft);

    const expanded = expandReviewIds(state, [hunks[0]!.hunkId]);

    expect(expanded).toEqual([hunks[0]!.hunkId]);
  });

  it("显式 reviewBatchId 仍兼容选择同 batch 旧记录", async () => {
    const state = createSession("legacy-batch-expand");
    const base = doc([paragraph("block-a", "湖边有柳树。他拿着蓝毛巾。")]);
    const draft = doc([paragraph("block-a", "湖边有胡桃树。他拿着黄毛巾。")]);
    const hunks = await seedDiffState(state, base, draft);
    for (const hunk of hunks) {
      const record = state.suggestions.get(hunk.hunkId);
      if (!record) throw new Error("fixture missing record");
      record.suggestion = {
        ...record.suggestion,
        reviewBatchId: "legacy-batch",
        groupMode: "atomic",
        diffHunk: record.suggestion.diffHunk
          ? { ...record.suggestion.diffHunk, reviewBatchId: "legacy-batch", groupMode: "atomic" }
          : undefined,
      };
      record.diffHunk = record.diffHunk
        ? { ...record.diffHunk, reviewBatchId: "legacy-batch", groupMode: "atomic" }
        : undefined;
    }

    const expanded = expandReviewIds(state, [], ["legacy-batch"]);

    expect(expanded.sort()).toEqual(hunks.map((hunk) => hunk.hunkId).sort());
  });

  it("acceptPatch 传入单 id 只同步当前 hunk verdict", async () => {
    const state = createSession("per-hunk-verdict");
    const base = doc([paragraph("block-a", "湖边有柳树。他拿着蓝毛巾。")]);
    const draft = doc([paragraph("block-a", "湖边有胡桃树。他拿着黄毛巾。")]);
    const hunks = await seedDiffState(state, base, draft);

    const frames = await collectFrames(updatePatchVerdict(state, hunks[0]!.hunkId, "accepted"));

    expect(frames).toHaveLength(1);
    expect(frames.every((frame) => frame.kind === "toolCallUpdated")).toBe(true);
    expect(
      frames.every((frame) =>
        frame.kind === "toolCallUpdated" &&
        frame.data.spec.name === "docSuggestion" &&
        frame.data.spec.status.kind === "accepted",
      ),
    ).toBe(true);
    expect(state.patchVerdicts.get(hunks[0]!.hunkId)).toBe("accepted");
    expect(state.patchVerdicts.has(hunks[1]!.hunkId)).toBe(false);
    expect(state.suggestions.get(hunks[0]!.hunkId)?.suggestion.status).toBe("accepted");
    expect(state.suggestions.get(hunks[1]!.hunkId)?.suggestion.status).toBe("reviewing");
    await expect(listDocumentSuggestionStatuses(state.docId, 1, [hunks[0]!.hunkId]))
      .resolves.toEqual([{ id: hunks[0]!.hunkId, status: "accepted", conflict: undefined }]);
  });

  it("裁决状态落库失败时只发失败帧并保持 reviewing", async () => {
    const state = createSession("verdict-persist-failure");
    const base = doc([paragraph("block-a", "旧正文")]);
    const draft = doc([paragraph("block-a", "新正文")]);
    const [hunk] = await seedDiffState(state, base, draft);
    if (!hunk) throw new Error("fixture missing hunk");
    await getDocumentsClient().execute("DROP TABLE document_suggestions");

    const frames = await collectFrames(updatePatchVerdict(state, hunk.hunkId, "accepted"));
    const statuses = frames
      .filter((frame) => frame.kind === "toolCallUpdated")
      .map((frame) => frame.kind === "toolCallUpdated" ? frame.data.spec.status : null);

    expect(statuses).toEqual([
      { kind: "failed", data: { retriable: true, reason: "审阅状态保存失败，请重试本项。" } },
    ]);
    expect(statuses).not.toContainEqual({ kind: "accepted" });
    expect(state.patchVerdicts.has(hunk.hunkId)).toBe(false);
    expect(state.suggestions.get(hunk.hunkId)?.suggestion.status).toBe("reviewing");
  });

  it("BLOCKED_ON_S5: 部分提交只写入显式接受组,未决组保留在内存态", async () => {
    const state = createSession("partial-memory");
    const base = doc([
      paragraph("block-a", "A 旧"),
      paragraph("block-b", "B 旧"),
      paragraph("block-c", "C 旧"),
    ]);
    const draft = doc([
      paragraph("block-a", "A 新"),
      paragraph("block-b", "B 新"),
      paragraph("block-c", "C 新"),
    ]);
    const hunks = await seedDiffState(state, base, draft);
    state.modelKnownDocVersion = state.docVersion;
    await seedDocumentRow(state);

    const [hunkA, hunkB, hunkC] = hunks;
    if (!hunkA || !hunkB || !hunkC) throw new Error("fixture missing hunks");
    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [hunkA.reviewBatchId],
      keepPendingReviewBatchIds: [hunkB.reviewBatchId, hunkC.reviewBatchId],
    }));

    const diffFrame = frames.find((frame) => frame.kind === "docDiffReady");
    expect(diffFrame?.kind).toBe("docDiffReady");
    if (diffFrame?.kind !== "docDiffReady") throw new Error("missing docDiffReady");
    expect(docText(diffFrame.data.editedDoc)).toBe("A 新\nB 新\nC 新");
    expect(diffFrame.data.editedDoc).toEqual(state.docDraftCandidateDoc);
    expect(docText(state.doc)).toBe("A 新\nB 旧\nC 旧");
    expect(state.docVersion).toBe(2);
    expect(state.modelKnownDocVersion).toBe(1);
    expect(buildDocVersionAwarenessContent(state)).toContain(
      "正文自你上次读取(v1)后已更新到 v2",
    );
    expect(state.lastContentEditedAt)
      .toBe((await findOpByDocumentVersion(state.docId, state.docVersion))?.createdAt);
    expect(state.suggestions.has(hunkA.hunkId)).toBe(false);
    expect(state.suggestions.has(hunkB.hunkId)).toBe(true);
    expect(state.suggestions.has(hunkC.hunkId)).toBe(true);
    expect(state.patchVerdicts.has(hunkB.hunkId)).toBe(false);
    expect(state.patchVerdicts.has(hunkC.hunkId)).toBe(false);
  });

  it("同一段内 3 处文字改动:只采纳第 2 处后其余 2 处仍待审且候选位置正确", async () => {
    const state = createSession("same-paragraph-accept-middle");
    const base = doc([paragraph("block-a", "一猫，二狗，三鸟。")]);
    const draft = doc([paragraph("block-a", "一虎，二狼，三鹰。")]);
    const hunks = await seedDiffState(state, base, draft);
    await seedDocumentRow(state);

    expect(hunks.map((hunk) => [hunk.beforeText, hunk.afterText])).toEqual([
      ["猫", "虎"],
      ["狗", "狼"],
      ["鸟", "鹰"],
    ]);
    const middle = hunks[1]!;
    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [middle.reviewBatchId],
      keepPendingReviewBatchIds: [hunks[0]!.reviewBatchId, hunks[2]!.reviewBatchId],
    }));

    const diffFrame = frames.find((frame) => frame.kind === "docDiffReady");
    expect(diffFrame?.kind).toBe("docDiffReady");
    if (diffFrame?.kind !== "docDiffReady") throw new Error("missing docDiffReady");
    expect(docText(state.doc)).toBe("一猫，二狼，三鸟。");
    expect(docText(diffFrame.data.editedDoc)).toBe("一虎，二狼，三鹰。");
    expect([...state.suggestions.values()].map((record) => record.diffHunk?.beforeText)).toEqual([
      "猫",
      "鸟",
    ]);
    expect([...state.suggestions.values()].map((record) => record.diffHunk?.groupMode)).toEqual([
      "independent",
      "independent",
    ]);
  });

  it("同段文本与脚注两建议部分采纳成功，脚注语义与候选一致", async () => {
    const state = createSession("footnote-inline-partial-commit");
    const base = doc([
      {
        type: "paragraph",
        attrs: { blockId: "block-target" },
        content: [
          text("前缀旧"),
          { type: "footnoteReference", attrs: { id: "source-old", note: "旧来源" } },
          text("尾文"),
        ],
      },
      paragraph("block-keep", "保留旧"),
    ]);
    const draft = doc([
      {
        type: "paragraph",
        attrs: { blockId: "block-target" },
        content: [
          text("前缀新"),
          { type: "footnoteReference", attrs: { id: "source-new", note: "新来源" } },
          text("尾文"),
        ],
      },
      paragraph("block-keep", "保留新"),
    ]);
    const hunks = await seedDiffState(state, base, draft);
    await seedDocumentRow(state);
    const targetHunks = hunks.filter((hunk) => hunk.anchor.blockId === "block-target");
    const keepHunk = hunks.find((hunk) => hunk.anchor.blockId === "block-keep");
    if (targetHunks.length !== 2 || !keepHunk) throw new Error("fixture missing expected hunks");

    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: targetHunks.map((hunk) => hunk.reviewBatchId),
      keepPendingReviewBatchIds: [keepHunk.reviewBatchId],
    }));

    expect(targetHunks.some((hunk) =>
      Array.isArray(hunk.before) && hunk.before.some((node) => node.type === "footnoteReference")
    )).toBe(true);
    expect(frames.some((frame) => frame.kind === "docCommitted")).toBe(true);
    expect(frames.some((frame) => frame.kind === "documentSnapshotWritten")).toBe(true);
    expect(state.docVersion).toBe(2);
    expect(state.doc).toEqual(doc([draft.content[0]!, base.content[1]!]));
    const committedTarget = state.doc?.content[0];
    expect(committedTarget && "content" in committedTarget ? committedTarget.content?.[1] : undefined).toEqual({
      type: "footnoteReference",
      attrs: { id: "source-new", note: "新来源" },
    });
    expect(state.suggestions.size).toBe(1);
    expect([...state.suggestions.values()][0]?.diffHunk?.anchor.blockId).toBe("block-keep");
  });

  it("仅采纳脚注建议时逐 hunk 提交成功并保留其它段待审", async () => {
    const state = createSession("footnote-only-partial-commit");
    const base = doc([
      {
        type: "paragraph",
        attrs: { blockId: "block-target" },
        content: [
          text("正文"),
          { type: "footnoteReference", attrs: { id: "source-a", note: "旧注" } },
          text("结束"),
        ],
      },
      paragraph("block-keep", "保留旧"),
    ]);
    const draft = doc([
      {
        type: "paragraph",
        attrs: { blockId: "block-target" },
        content: [
          text("正文"),
          { type: "footnoteReference", attrs: { id: "source-b", note: "新注" } },
          text("结束"),
        ],
      },
      paragraph("block-keep", "保留新"),
    ]);
    const hunks = await seedDiffState(state, base, draft);
    await seedDocumentRow(state);
    const footnoteHunk = hunks.find((hunk) => hunk.anchor.blockId === "block-target");
    const keepHunk = hunks.find((hunk) => hunk.anchor.blockId === "block-keep");
    if (!footnoteHunk || !keepHunk) throw new Error("fixture missing expected hunks");

    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [footnoteHunk.reviewBatchId],
      keepPendingReviewBatchIds: [keepHunk.reviewBatchId],
    }));

    expect(footnoteHunk.before).toEqual([{
      type: "footnoteReference",
      attrs: { id: "source-a", note: "旧注" },
    }]);
    expect(frames.some((frame) => frame.kind === "docCommitted")).toBe(true);
    expect(state.docVersion).toBe(2);
    expect(state.doc).toEqual(doc([draft.content[0]!, base.content[1]!]));
    expect(state.suggestions.size).toBe(1);
  });

  it("同段文本与 inlineMath 两建议部分采纳继续成功", async () => {
    const state = createSession("inline-math-partial-commit-control");
    const base = doc([
      {
        type: "paragraph",
        attrs: { blockId: "block-target" },
        content: [
          text("前缀旧"),
          { type: "inlineMath", attrs: { latex: "x" } },
          text("尾文"),
        ],
      },
      paragraph("block-keep", "保留旧"),
    ]);
    const draft = doc([
      {
        type: "paragraph",
        attrs: { blockId: "block-target" },
        content: [
          text("前缀新"),
          { type: "inlineMath", attrs: { latex: "y" } },
          text("尾文"),
        ],
      },
      paragraph("block-keep", "保留新"),
    ]);
    const hunks = await seedDiffState(state, base, draft);
    await seedDocumentRow(state);
    const targetHunks = hunks.filter((hunk) => hunk.anchor.blockId === "block-target");
    const keepHunk = hunks.find((hunk) => hunk.anchor.blockId === "block-keep");
    if (targetHunks.length !== 2 || !keepHunk) throw new Error("fixture missing expected hunks");

    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: targetHunks.map((hunk) => hunk.reviewBatchId),
      keepPendingReviewBatchIds: [keepHunk.reviewBatchId],
    }));

    expect(targetHunks.some((hunk) =>
      Array.isArray(hunk.before) && hunk.before.some((node) => node.type === "inlineMath")
    )).toBe(true);
    expect(frames.some((frame) => frame.kind === "docCommitted")).toBe(true);
    expect(state.docVersion).toBe(2);
    expect(state.doc).toEqual(doc([draft.content[0]!, base.content[1]!]));
    expect(state.suggestions.size).toBe(1);
  });

  it("全选同段文本与脚注仍以权威候选整篇提交", async () => {
    const state = createSession("footnote-whole-candidate-commit");
    const base = doc([{
      type: "paragraph",
      attrs: { blockId: "block-target" },
      content: [
        text("前缀旧"),
        { type: "footnoteReference", attrs: { id: "source-old", note: "旧来源" } },
        text("尾文"),
      ],
    }]);
    const draft = doc([{
      type: "paragraph",
      attrs: { blockId: "block-target" },
      content: [
        text("前缀新"),
        { type: "footnoteReference", attrs: { id: "source-new", note: "新来源" } },
        text("尾文"),
      ],
    }]);
    const hunks = await seedDiffState(state, base, draft);
    await seedDocumentRow(state);

    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: hunks.map((hunk) => hunk.reviewBatchId),
    }));

    expect(frames.some((frame) => frame.kind === "docCommitted")).toBe(true);
    expect(state.docVersion).toBe(2);
    expect(state.doc).toEqual(draft);
    expect(state.suggestions.size).toBe(0);
  });

  it("相邻/重叠 hunk 混合操作:采纳一处、拒绝一处、保留一处", async () => {
    const state = createSession("overlap-mixed-review");
    const base = doc([paragraph("block-a", "ABCDEFGH")]);
    const accept = inlineReplaceHunk({
      id: "h-accept",
      blockId: "block-a",
      from: 1,
      to: 3,
      before: "BC",
      after: "XY",
    });
    const reject = inlineReplaceHunk({
      id: "h-reject",
      blockId: "block-a",
      from: 2,
      to: 4,
      before: "CD",
      after: "ZW",
    });
    const keep = inlineReplaceHunk({
      id: "h-keep",
      blockId: "block-a",
      from: 5,
      to: 7,
      before: "FG",
      after: "UV",
    });
    await seedHunksState(state, base, [accept, reject, keep]);
    await seedDocumentRow(state);

    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [accept.reviewBatchId],
      rejectReviewBatchIds: [reject.reviewBatchId],
      keepPendingReviewBatchIds: [keep.reviewBatchId],
    }));

    const diffFrame = frames.find((frame) => frame.kind === "docDiffReady");
    expect(diffFrame?.kind).toBe("docDiffReady");
    if (diffFrame?.kind !== "docDiffReady") throw new Error("missing docDiffReady");
    expect(docText(state.doc)).toBe("AXYDEFGH");
    expect(docText(diffFrame.data.editedDoc)).toBe("AXYDEUVH");
    expect([...state.suggestions.values()].map((record) => record.diffHunk?.beforeText)).toEqual(["FG"]);
    expect(state.patchVerdicts.size).toBe(0);
  });

  it("接受后剩余建议效果已存在导致 rebase cleared 时统一结算 reviewing 记录", async () => {
    const state = createSession("cleared-rebase-settlement");
    const base = doc([paragraph("block-a", "A")]);
    const inserted = paragraph("block-x", "X");
    const accepted = blockInsertHunk({
      id: "h-insert-accepted",
      anchorBlockId: "block-a",
      block: inserted,
      text: "X",
    });
    const alreadyEffective = blockInsertHunk({
      id: "h-insert-already-effective",
      anchorBlockId: "block-a",
      block: inserted,
      text: "X",
    });
    await seedHunksState(state, base, [accepted, alreadyEffective]);
    await seedDocumentRow(state);

    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [accepted.reviewBatchId],
      keepPendingReviewBatchIds: [alreadyEffective.reviewBatchId],
    }));

    expect(docText(state.doc)).toBe("A\nX");
    expect(state.suggestions.size).toBe(0);
    expect(state.patchVerdicts.size).toBe(0);
    expect(deriveContentState(state)).toEqual({ kind: "editing" });
    await expect(
      listDocumentSuggestionStatuses(
        state.docId,
        1,
        [alreadyEffective.hunkId],
      ),
    ).resolves.toEqual([
      {
        id: alreadyEffective.hunkId,
        status: "committed",
        conflict: undefined,
      },
    ]);
    expect(frames).toContainEqual(
      expect.objectContaining({
        kind: "toolCallUpdated",
        data: expect.objectContaining({
          toolCallId: alreadyEffective.hunkId,
          spec: expect.objectContaining({ status: { kind: "committed" } }),
        }),
      }),
    );
  });

  it("拒绝后剩余建议效果已不存在导致 rebase cleared 时按拒绝语义结算", async () => {
    const state = createSession("cleared-rebase-rejected-settlement");
    const inserted = paragraph("block-x", "X");
    const base = doc([paragraph("block-a", "A"), inserted]);
    const rejected = blockInsertHunk({
      id: "h-insert-rejected",
      anchorBlockId: "block-a",
      block: inserted,
      text: "X",
    });
    const alreadySettled = blockInsertHunk({
      id: "h-insert-already-settled",
      anchorBlockId: "block-a",
      block: inserted,
      text: "X",
    });
    await seedHunksState(state, base, [rejected, alreadySettled]);
    await seedDocumentRow(state);

    await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [],
      rejectReviewBatchIds: [rejected.reviewBatchId],
      keepPendingReviewBatchIds: [alreadySettled.reviewBatchId],
    }));

    expect(docText(state.doc)).toBe("A\nX");
    expect(state.suggestions.size).toBe(0);
    expect(state.patchVerdicts.size).toBe(0);
    expect(deriveContentState(state)).toEqual({ kind: "editing" });
    await expect(
      listDocumentSuggestionStatuses(
        state.docId,
        1,
        [alreadySettled.hunkId],
      ),
    ).resolves.toEqual([
      {
        id: alreadySettled.hunkId,
        status: "rejected",
        conflict: undefined,
      },
    ]);
  });

  it("结构性整块替换仍作为单 hunk 提交", async () => {
    const state = createSession("block-replace-single-hunk");
    const base = doc([{
      type: "callout",
      attrs: { blockId: "callout-a", emoji: "!", tone: "warning" },
      content: [paragraph("callout-a-p", "旧提示") as Extract<PmBlockNode, { type: "paragraph" }>],
    } as PmBlockNode]);
    const draft = doc([{
      type: "callout",
      attrs: { blockId: "callout-a", emoji: "!", tone: "info" },
      content: [paragraph("callout-a-p", "新提示") as Extract<PmBlockNode, { type: "paragraph" }>],
    } as PmBlockNode]);
    const hunks = await seedDiffState(state, base, draft);
    await seedDocumentRow(state);

    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.groupMode).toBe("independent");
    await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [hunks[0]!.reviewBatchId],
    }));

    expect(state.doc).toEqual(draft);
    expect(state.suggestions.size).toBe(0);
    expect(deriveContentState(state)).toEqual({ kind: "editing" });
  });

  it("提交整块重写时重定位三处同引文锚点，权威帧只保留可交互组", async () => {
    const state = createSession("commit-relocates-three-annotation-anchors");
    const oldQuote = "三连 “方面”";
    const newQuote = "三连 「方面」";
    const baseText = `${oldQuote}；${oldQuote}；${oldQuote}；已经删除。`;
    const finalText = `改写后：${newQuote}；${newQuote}；${newQuote}。`;
    const base = doc([paragraph("rewrite-block", baseText)]);
    const draft = doc([paragraph("rewrite-block", finalText)]);
    const quoteOffsets: number[] = [];
    for (let from = baseText.indexOf(oldQuote); from >= 0;) {
      quoteOffsets.push(from);
      from = baseText.indexOf(oldQuote, from + oldQuote.length);
    }
    const deletedOffset = baseText.indexOf("已经删除");
    const annotationGroups: AnnotationGroup[] = [
      {
        id: "g-three-anchors",
        summary: "三连方面",
        note: "同一短语有三处命中",
        origin: "deai",
        status: "reviewing",
        anchors: quoteOffsets.map((offset, index) => ({
          blockId: "rewrite-block",
          pmFrom: offset + 1,
          pmTo: offset + 1 + oldQuote.length,
          quote: oldQuote,
          textHash: `three-${index}`,
        })),
      },
      {
        id: "g-really-gone",
        summary: "真实消失",
        note: "终稿中已不存在",
        origin: "deai",
        status: "reviewing",
        anchors: [{
          blockId: "rewrite-block",
          pmFrom: deletedOffset + 1,
          pmTo: deletedOffset + 1 + "已经删除".length,
          quote: "已经删除",
          textHash: "deleted",
        }],
      },
    ];
    const hunks = await seedDiffState(state, base, draft);
    state.annotationGroups = annotationGroups;
    await seedDocumentRow(state);
    await insertAnnotationGroups(state.docId, state.docVersion, annotationGroups);

    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [
        ...new Set(hunks.map((hunk) => hunk.reviewBatchId ?? hunk.hunkId)),
      ],
    }));
    const annotationFrame = frames.find((frame) =>
      frame.kind === "annotationGroupsReady"
    );
    const finalOffsets: number[] = [];
    for (let from = finalText.indexOf(newQuote); from >= 0;) {
      finalOffsets.push(from);
      from = finalText.indexOf(newQuote, from + newQuote.length);
    }

    expect(annotationFrame).toEqual({
      kind: "annotationGroupsReady",
      data: {
        groups: [expect.objectContaining({
          id: "g-three-anchors",
          anchors: finalOffsets.map((offset) => expect.objectContaining({
            pmFrom: offset + 1,
            pmTo: offset + 1 + newQuote.length,
            quote: newQuote,
          })),
        })],
        replacedOrigins: ["deai"],
        invalidatedAnchorCount: 1,
      },
    });
    expect(state.annotationGroups.map((group) => group.id)).toEqual(["g-three-anchors"]);
    expect(state.annotationGroups[0]?.anchors).toHaveLength(3);
  });

  it("提交前部净增 N 字后，后方批注先重定位再正常结算，不会悬空", async () => {
    const state = createSession("commit-reanchors-later-annotations-after-prefix-insert");
    const insertedPrefix = "ABCDE";
    const base = doc([
      paragraph("before-block", "前文"),
      paragraph("annotated-block", "超过 3 秒后仍有 YYMARK"),
      paragraph("pending-block", "另一处待审原文"),
    ]);
    const draft = doc([
      paragraph("before-block", `${insertedPrefix}前文`),
      paragraph("annotated-block", "超过 4 秒后仍有 DONE"),
      paragraph("pending-block", "另一处待审改文"),
    ]);
    const secondBlockTextStart = "前文".length + 3;
    const yymarkOffset = "超过 3 秒后仍有 ".length;
    const annotationGroups: AnnotationGroup[] = [
      {
        id: "g-later-quote",
        summary: "后方原句",
        note: "hover 应与高亮一致",
        origin: "consistency",
        status: "reviewing",
        anchors: [{
          blockId: "annotated-block",
          pmFrom: secondBlockTextStart,
          pmTo: secondBlockTextStart + "超过 3 秒".length,
          quote: "超过 3 秒",
          textHash: "later-quote",
        }],
      },
      {
        id: "g-tail-marker",
        summary: "尾部标记",
        note: "尾部锚点不能消失",
        origin: "consistency",
        status: "reviewing",
        anchors: [{
          blockId: "annotated-block",
          pmFrom: secondBlockTextStart + yymarkOffset,
          pmTo: secondBlockTextStart + yymarkOffset + "YYMARK".length,
          quote: "YYMARK",
          textHash: "tail-marker",
        }],
      },
    ];
    const hunks = await seedDiffState(state, base, draft);
    state.annotationGroups = annotationGroups;
    await seedDocumentRow(state);
    await insertAnnotationGroups(state.docId, state.docVersion, annotationGroups);

    const prefixHunk = hunks.find((hunk) => hunk.anchor.blockId === "before-block");
    const pendingHunks = hunks.filter((hunk) => hunk !== prefixHunk);
    if (!prefixHunk || pendingHunks.length === 0) throw new Error("fixture missing partial hunks");
    await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [prefixHunk.reviewBatchId ?? prefixHunk.hunkId],
      keepPendingReviewBatchIds: pendingHunks.map((hunk) => hunk.reviewBatchId ?? hunk.hunkId),
    }));

    expect(state.annotationGroups.map((group) => group.anchors[0])).toEqual([
      expect.objectContaining({
        quote: "超过 3 秒",
        pmFrom: secondBlockTextStart + insertedPrefix.length,
        pmTo: secondBlockTextStart + insertedPrefix.length + "超过 3 秒".length,
      }),
      expect.objectContaining({
        quote: "YYMARK",
        pmFrom: secondBlockTextStart + insertedPrefix.length + yymarkOffset,
        pmTo: secondBlockTextStart + insertedPrefix.length + yymarkOffset + "YYMARK".length,
      }),
    ]);
    const persisted = await getDocumentsClient().execute({
      sql: `SELECT anchor_json FROM document_suggestions
        WHERE doc_id = ? AND kind = 'annotation' AND status = 'reviewing'
        ORDER BY id`,
      args: [state.docId],
    });
    expect(persisted.rows.map((row) => JSON.parse(String(row.anchor_json)))).toEqual([
      expect.objectContaining({
        quote: "超过 3 秒",
        pmFrom: secondBlockTextStart + insertedPrefix.length,
        pmTo: secondBlockTextStart + insertedPrefix.length + "超过 3 秒".length,
      }),
      expect.objectContaining({
        quote: "YYMARK",
        pmFrom: secondBlockTextStart + insertedPrefix.length + yymarkOffset,
        pmTo: secondBlockTextStart + insertedPrefix.length + yymarkOffset + "YYMARK".length,
      }),
    ]);

    const reanchoredRecords = [...state.suggestions.values()];
    const annotationRecords = reanchoredRecords.filter((record) =>
      record.diffHunk?.anchor.blockId === "annotated-block"
    );
    const annotationRecordSet = new Set(annotationRecords);
    const stillPendingRecords = reanchoredRecords.filter((record) =>
      !annotationRecordSet.has(record)
    );
    if (annotationRecords.some((record) => !record.diffHunk) ||
      annotationRecords.length === 0 || stillPendingRecords.length === 0) {
      throw new Error("fixture missing reanchored annotation hunk");
    }
    await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: annotationRecords.map((record) =>
        record.diffHunk?.reviewBatchId ?? record.diffHunk?.hunkId ?? record.suggestion.id
      ),
      keepPendingReviewBatchIds: stillPendingRecords.map((record) =>
        record.diffHunk?.reviewBatchId ?? record.diffHunk?.hunkId ?? record.suggestion.id
      ),
    }));

    expect(state.annotationGroups).toEqual([]);
    const annotationStatuses = await getDocumentsClient().execute({
      sql: `SELECT status FROM document_suggestions
        WHERE doc_id = ? AND kind = 'annotation'
        ORDER BY id`,
      args: [state.docId],
    });
    expect(annotationStatuses.rows.map((row) => String(row.status))).toEqual([
      "ignored",
      "ignored",
    ]);
  });

  it("只拒绝部分 review group 后重发 docDiffReady 带 rebase 后 editedDoc", async () => {
    const state = createSession("partial-reject-edited-doc");
    const base = doc([
      paragraph("block-a", "A 旧"),
      paragraph("block-b", "B 旧"),
      paragraph("block-c", "C 旧"),
    ]);
    const draft = doc([
      paragraph("block-a", "A 新"),
      paragraph("block-b", "B 新"),
      paragraph("block-c", "C 新"),
    ]);
    const hunks = await seedDiffState(state, base, draft);
    await seedDocumentRow(state);

    const [hunkA, hunkB, hunkC] = hunks;
    if (!hunkA || !hunkB || !hunkC) throw new Error("fixture missing hunks");
    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [],
      rejectReviewBatchIds: [hunkA.reviewBatchId],
      keepPendingReviewBatchIds: [hunkB.reviewBatchId, hunkC.reviewBatchId],
    }));

    const diffFrame = frames.find((frame) => frame.kind === "docDiffReady");
    expect(diffFrame?.kind).toBe("docDiffReady");
    if (diffFrame?.kind !== "docDiffReady") throw new Error("missing docDiffReady");
    expect(docText(diffFrame.data.editedDoc)).toBe("A 旧\nB 新\nC 新");
    expect(diffFrame.data.editedDoc).toEqual(state.docDraftCandidateDoc);
    expect(docText(state.doc)).toBe("A 旧\nB 旧\nC 旧");
    const hunkBRows = await getDocumentsClient().execute({
      sql: `SELECT batch_id, status FROM document_suggestions
        WHERE doc_id = ? AND base_version = ? AND id = ?`,
      args: [state.docId, state.docVersion, hunkB.hunkId],
    });
    expect(hunkBRows.rows.map((row) => String(row.status)).sort()).toEqual([
      "ignored",
      "reviewing",
    ]);
    expect(new Set(hunkBRows.rows.map((row) => String(row.batch_id))).size).toBe(2);
  });

  it("列表项部分采纳后以 item blockId + 深路径重配对剩余 hunk", async () => {
    const state = createSession("partial-list-item-rebase");
    const base = doc([bulletList("list-commit", [
      { blockId: "item-a", text: "A 旧" },
      { blockId: "item-b", text: "B 旧" },
    ])]);
    const draft = doc([bulletList("list-commit", [
      { blockId: "item-a", text: "A 新" },
      { blockId: "item-b", text: "B 新" },
    ])]);
    const hunks = await seedDiffState(state, base, draft);
    await seedDocumentRow(state);
    expect(hunks.map((hunk) => hunk.blockPath)).toEqual([[0, 0], [0, 1]]);
    const hunkA = hunks.find((hunk) => hunk.anchor.blockId === "item-a");
    const hunkB = hunks.find((hunk) => hunk.anchor.blockId === "item-b");
    if (!hunkA || !hunkB) throw new Error("fixture missing list item hunks");

    await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [hunkA.reviewBatchId],
      keepPendingReviewBatchIds: [hunkB.reviewBatchId],
    }));

    expect(firstListTexts(state.doc)).toEqual(["A 新", "B 旧"]);
    const [remaining] = [...state.suggestions.values()];
    expect(remaining?.blockPath).toEqual([0, 1]);
    expect(remaining?.diffHunk).toMatchObject({
      blockPath: [0, 1],
      anchor: { blockId: "item-b" },
      before: [{ type: "listItem" }],
      after: [{ type: "listItem" }],
    });

    await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [remaining!.diffHunk!.reviewBatchId],
    }));
    expect(firstListTexts(state.doc)).toEqual(["A 新", "B 新"]);
    expect(state.suggestions.size).toBe(0);
  });

  it("先接受一处再撤销全部时会把已接受 batch 也拒绝并回到旧文档", async () => {
    const initialContentTime = "2025-01-01T00:00:00.000Z";
    const state = createSession("accept-then-reject-all", initialContentTime);
    const base = doc([
      paragraph("block-a", "A 旧"),
      paragraph("block-b", "B 旧"),
    ]);
    const draft = doc([
      paragraph("block-a", "A 新"),
      paragraph("block-b", "B 新"),
    ]);
    const hunks = await seedDiffState(state, base, draft);
    await seedDocumentRow(state);
    await documentDraftRepo.savePending({
      docId: state.docId,
      threadId: state.threadId ?? state.sessionId,
      baseVersion: state.docVersion,
      baseHash: getPmContentHash(base),
      draftPmDoc: draft,
    });
    const [hunkA, hunkB] = hunks;
    if (!hunkA || !hunkB) throw new Error("fixture missing hunks");

    await collectFrames(updatePatchVerdict(state, hunkA.hunkId, "accepted"));
    expect(state.patchVerdicts.get(hunkA.hunkId)).toBe("accepted");

    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [],
      rejectReviewBatchIds: hunks.map((hunk) => hunk.reviewBatchId),
    }));

    expect(docText(state.doc)).toBe("A 旧\nB 旧");
    expect(state.suggestions.size).toBe(0);
    expect(state.patchVerdicts.size).toBe(0);
    expect(deriveContentState(state)).toEqual({ kind: "editing" });
    expect(state.lastContentEditedAt).toBe(initialContentTime);
    const terminalStatuses = frames
      .filter((frame) => frame.kind === "toolCallUpdated")
      .map((frame) => frame.kind === "toolCallUpdated" ? frame.data.spec.status.kind : "");
    expect(terminalStatuses).toContain("rejected");
    expect(terminalStatuses).not.toContain("committed");
  });

  it("S5: 同会话连续提交时 remaining hunks 按 blockId rebase,不误写位移后的插入块", async () => {
    const state = createSession("partial-continuous-rebase");
    const base = doc([
      paragraph("block-a", "A"),
      paragraph("block-b", "B 旧"),
      paragraph("block-c", "C 旧"),
    ]);
    const draft = doc([
      paragraph("block-a", "A"),
      paragraph("block-x", "X 插入"),
      paragraph("block-b", "B 新"),
      paragraph("block-c", "C 新"),
    ]);
    const hunks = await seedDiffState(state, base, draft);
    await seedDocumentRow(state);
    const insertHunk = hunks.find((hunk) => hunk.op === "insert");
    const blockBHunk = hunks.find((hunk) => hunk.anchor.blockId === "block-b");
    const blockCHunk = hunks.find((hunk) => hunk.anchor.blockId === "block-c");
    if (!insertHunk || !blockBHunk || !blockCHunk) throw new Error("fixture missing hunks");

    await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [insertHunk.reviewBatchId],
      keepPendingReviewBatchIds: [blockBHunk.reviewBatchId, blockCHunk.reviewBatchId],
    }));

    expect(docText(state.doc)).toBe("A\nX 插入\nB 旧\nC 旧");
    const rebasedBHunk = [...state.suggestions.values()]
      .map((record) => record.diffHunk)
      .find((hunk) => hunk?.anchor.blockId === "block-b");
    expect(rebasedBHunk?.blockPath).toEqual([2]);

    await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [rebasedBHunk!.reviewBatchId],
      keepPendingReviewBatchIds: [
        [...state.suggestions.values()]
          .map((record) => record.diffHunk)
          .find((hunk) => hunk?.anchor.blockId === "block-c")!.reviewBatchId,
      ],
    }));

    expect(docText(state.doc)).toBe("A\nX 插入\nB 新\nC 旧");
    expect([...state.suggestions.values()].map((record) => record.diffHunk?.anchor.blockId)).toEqual(["block-c"]);
  });

  it("提交局部采纳时按 blockId 锚定,避免位移后把被拒 hunk 落成已采纳内容", async () => {
    const state = createSession("partial-commit-anchor-block-id");
    const base = doc([
      paragraph("block-a", "A 原文"),
      paragraph("block-b", "B 原文"),
      paragraph("block-c", "C 原文"),
      paragraph("block-d", "D 原文"),
    ]);
    const draft = doc([
      paragraph("block-a", "A 原文"),
      paragraph("block-b", "B 新文"),
      paragraph("block-c", "C 新文"),
      paragraph("block-d", "D 新文"),
    ]);
    const hunks = await seedDiffState(state, base, draft);
    const shiftedCurrent = doc([
      paragraph("user-block", "用户新增前置段"),
      ...base.content,
    ]);
    state.doc = shiftedCurrent;
    state.docVersion = 2;
    state.docState = { kind: "pendingReview" };
    await seedDocumentRow(state);

    const hunkB = hunks.find((hunk) => hunk.anchor.blockId === "block-b");
    const hunkC = hunks.find((hunk) => hunk.anchor.blockId === "block-c");
    const hunkD = hunks.find((hunk) => hunk.anchor.blockId === "block-d");
    if (!hunkB || !hunkC || !hunkD) throw new Error("fixture missing hunks");
    expect(hunks.map((hunk) => hunk.anchor.blockId)).toEqual(["block-b", "block-c", "block-d"]);

    await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [hunkC.reviewBatchId, hunkD.reviewBatchId],
      rejectReviewBatchIds: [hunkB.reviewBatchId],
    }));

    expect(docBlocks(state.doc)).toEqual([
      { blockId: "user-block", text: "用户新增前置段" },
      { blockId: "block-a", text: "A 原文" },
      { blockId: "block-b", text: "B 原文" },
      { blockId: "block-c", text: "C 新文" },
      { blockId: "block-d", text: "D 新文" },
    ]);
    expect(state.suggestions.size).toBe(0);
    expect(deriveContentState(state)).toEqual({ kind: "editing" });
  });

  it("A2: 接受一个多块 delete review group 会删除该 hunk 覆盖的全部连续块", async () => {
    const state = createSession("multi-delete-group");
    const base = doc([
      paragraph("block-a", "A"),
      paragraph("block-b", "B"),
      paragraph("block-c", "C"),
    ]);
    const draft = doc([paragraph("block-a", "A")]);
    const hunks = await seedDiffState(state, base, draft);
    await seedDocumentRow(state);
    const deleteHunk = hunks.find((hunk) => hunk.op === "delete");
    if (!deleteHunk) throw new Error("fixture missing delete hunk");

    await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [deleteHunk.reviewBatchId],
    }));

    expect(docText(state.doc)).toBe("A");
    expect(state.suggestions.size).toBe(0);
    expect(deriveContentState(state)).toEqual({ kind: "editing" });
  });
});

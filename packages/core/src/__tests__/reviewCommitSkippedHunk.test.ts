import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, DiffHunk, DocSuggestion } from "@qingagent/contract-ts";
import {
  pmToLegacySections,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
} from "@qingagent/pm-schema";
import type { LegacySection } from "@qingagent/contract-ts";
import {
  commitPatches,
  createSession,
  type SessionState,
} from "../bridge/index.js";
import { buildDraftDiff } from "../bridge/proposalDiff.js";
import { documentRepo } from "@qingagent/db";
import { getDocumentsClient } from "@qingagent/db";
import {
  documentInput,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";

// 单①回归:审核提交时,若某 hunk 的目标块已被并发删除(canonical 文档比审阅候选少一块),
// 该 hunk 必须被跳过——不能记进 document_ops.steps(修记假账),对应 suggestion 按"未应用"
// 结算并沿冲突帧把失效原因带给前端;存活块的 hunk 照常提交。

let tempDb: TempDocumentsDb;

function text(value: string): PmInlineNode {
  return { type: "text", text: value };
}

function paragraph(blockId: string, value: string): PmBlockNode {
  return { type: "paragraph", attrs: { blockId }, content: [text(value)] };
}

function table(blockId: string, left: string, right: string): PmBlockNode {
  return {
    type: "table",
    attrs: { blockId },
    content: [{
      type: "tableRow",
      content: [
        {
          type: "tableCell",
          content: [paragraph(`${blockId}-left-p`, left)],
        },
        {
          type: "tableCell",
          content: [paragraph(`${blockId}-right-p`, right)],
        },
      ],
    }],
  };
}

function doc(content: PmBlockNode[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function blockText(block: PmBlockNode | undefined): string {
  return block && "content" in block && Array.isArray(block.content)
    ? block.content.map((node) => (node.type === "text" ? node.text : "")).join("")
    : "";
}

function suggestionFromHunk(state: SessionState, hunk: DiffHunk): DocSuggestion {
  const pmFrom = hunk.anchor.pmFrom ?? 0;
  const pmTo = hunk.anchor.pmTo ?? pmFrom;
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
      quote: hunk.beforeText || hunk.afterText || hunk.summary || hunk.hunkId,
      textHash: `hash-${hunk.hunkId}`,
    },
    patch: {
      kind: "prosemirror_steps",
      steps: [{ stepType: "replace", from: pmFrom, to: pmTo }],
    },
    preview: { deleteText: hunk.beforeText ?? "", insertText: hunk.afterText ?? "" },
    diffHunk: hunk,
    summary: hunk.summary,
  };
}

function seedReviewState(state: SessionState, base: PmDoc, draft: PmDoc): DiffHunk[] {
  state.doc = base;
  state.legacySections = pmToLegacySections(base) as unknown as LegacySection[];
  state.docVersion = 1;
  state.docState = { kind: "pendingReview" };
  state.suggestionBaseDoc = base;
  state.suggestionBaseVersion = state.docVersion;
  state.docDraftBaseDoc = base;
  state.docDraftBaseVersion = state.docVersion;
  state.docDraftCandidateDoc = draft;
  state.docDraftCandidateSections = pmToLegacySections(draft) as unknown as LegacySection[];

  const hunks = buildDraftDiff(base, draft, { baseVersion: state.docVersion });
  for (const hunk of hunks) {
    const suggestion = suggestionFromHunk(state, hunk);
    state.suggestions.set(suggestion.id, {
      messageId: "msg-review",
      toolCallId: suggestion.id,
      before: hunk.beforeText ?? "",
      after: hunk.afterText ?? "",
      blockIndex: hunk.blockPath[0] ?? 0,
      suggestion,
      diffHunk: hunk,
    });
  }
  return hunks;
}

async function seedCanonical(state: SessionState, canonical: PmDoc): Promise<void> {
  await documentRepo.save(
    documentInput(state.docId, {
      threadId: state.threadId ?? state.sessionId,
      docVersion: 1,
      legacySections: pmToLegacySections(canonical) as unknown as LegacySection[],
      pmDoc: canonical,
    }),
  );
}

async function collectFrames(gen: AsyncIterable<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function toolStatusesFor(frames: readonly BridgeFrame[], suggestionId: string): string[] {
  return frames
    .filter((frame) => frame.kind === "toolCallUpdated" && frame.data.toolCallId === suggestionId)
    .map((frame) => (frame.kind === "toolCallUpdated" ? frame.data.spec.status.kind : ""));
}

function failedReasonsFor(frames: readonly BridgeFrame[], suggestionId: string): string[] {
  const reasons: string[] = [];
  for (const frame of frames) {
    if (frame.kind !== "toolCallUpdated" || frame.data.toolCallId !== suggestionId) continue;
    const status = frame.data.spec.status;
    if (status.kind === "failed") reasons.push(status.data.reason);
  }
  return reasons;
}

function firstFrameIndex(frames: readonly BridgeFrame[], kind: BridgeFrame["kind"]): number {
  return frames.findIndex((frame) => frame.kind === kind);
}

async function patchStepCounts(docId: string): Promise<number[]> {
  const client = getDocumentsClient();
  const result = await client.execute({
    sql: "SELECT steps FROM document_ops WHERE doc_id = ? AND op_kind = 'patch_steps' ORDER BY created_at",
    args: [docId],
  });
  return result.rows.map((row) => {
    const raw = row.steps;
    if (typeof raw !== "string") return 0;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  });
}

beforeEach(() => {
  tempDb = prepareTempDocumentsDb("qingagent-skip-hunk-");
});

afterEach(() => {
  vi.restoreAllMocks();
  tempDb.cleanup();
});

describe("审核提交:目标块被并发删除的 hunk 跳过 + 记账 + 提示", () => {
  it("只应用/记账存活块;失效 hunk 不进 steps,suggestion 按未应用结算并带失效提示", async () => {
    const state = createSession("commit-skip-deleted-block");
    const base = doc([paragraph("blk-a", "甲原文"), paragraph("blk-b", "乙原文")]);
    const draft = doc([paragraph("blk-a", "甲新文"), paragraph("blk-b", "乙新文")]);
    const [hunkA, hunkB] = seedReviewState(state, base, draft);
    if (!hunkA || !hunkB) throw new Error("fixture missing hunks");

    // 并发删除 blk-b:canonical 只剩 blk-a(仍是版本 1,CAS 通过)。
    await seedCanonical(state, doc([paragraph("blk-a", "甲原文")]));

    const frames = await collectFrames(
      commitPatches(state, [hunkA.hunkId, hunkB.hunkId]),
    );

    // 1) 文档只应用存活块 blk-a。
    expect(state.doc?.content.map(blockText)).toEqual(["甲新文"]);

    // 2) document_ops.steps 只含 1 条(blk-a),失效的 blk-b 不记假账。
    expect(await patchStepCounts(state.docId)).toEqual([1]);

    // 3) 存活项按已提交结算,失效项按未应用(failed)结算并带失效文案。
    expect(toolStatusesFor(frames, hunkA.hunkId)).not.toContain("failed");
    expect(toolStatusesFor(frames, hunkB.hunkId)).toContain("failed");
    expect(failedReasonsFor(frames, hunkB.hunkId).join("")).toContain("失效");

    // 4) 两项都已结算收尾,回到 editing。
    expect(state.suggestions.size).toBe(0);
    expect(state.docState).toEqual({ kind: "editing" });
  });

  it("同 blockId 正文已漂移时整批 fail-closed，并回发当前 canonical 快照", async () => {
    const state = createSession("commit-fail-closed-changed-block");
    const base = doc([paragraph("blk-a", "用户原文")]);
    const draft = doc([paragraph("blk-a", "AI 修改")]);
    const [hunk] = seedReviewState(state, base, draft);
    if (!hunk) throw new Error("fixture missing hunk");

    const userEdited = doc([paragraph("blk-a", "用户提交前又手动修改")]);
    await seedCanonical(state, userEdited);

    const frames = await collectFrames(commitPatches(state, [hunk.hunkId]));
    const stored = await documentRepo.load(state.docId);

    expect(stored?.pmDoc?.content.map(blockText)).toEqual(["用户提交前又手动修改"]);
    expect(state.doc?.content.map(blockText)).toEqual(["用户提交前又手动修改"]);
    expect(await patchStepCounts(state.docId)).toEqual([]);
    expect(toolStatusesFor(frames, hunk.hunkId)).toContain("failed");
    expect(failedReasonsFor(frames, hunk.hunkId).join("")).toContain("正文已变化");
    expect(firstFrameIndex(frames, "documentSnapshotWritten")).toBeGreaterThanOrEqual(0);
    expect(firstFrameIndex(frames, "documentSnapshotWritten")).toBeLessThan(
      firstFrameIndex(frames, "toolCallUpdated"),
    );
  });

  it("表格整块 hunk 的 canonical 已被用户改动时 fail-closed，不覆盖未选中单元格", async () => {
    const state = createSession("commit-fail-closed-changed-table");
    const base = doc([table("table-a", "用户原文", "待修改")]);
    const draft = doc([table("table-a", "用户原文", "AI 修改")]);
    const [hunk] = seedReviewState(state, base, draft);
    if (!hunk) throw new Error("fixture missing table hunk");

    const userEdited = doc([table("table-a", "用户提交前手改", "待修改")]);
    await seedCanonical(state, userEdited);

    const frames = await collectFrames(commitPatches(state, [hunk.hunkId]));
    const stored = await documentRepo.load(state.docId);

    expect(stored?.pmDoc).toEqual(userEdited);
    expect(state.doc).toEqual(userEdited);
    expect(await patchStepCounts(state.docId)).toEqual([]);
    expect(toolStatusesFor(frames, hunk.hunkId)).toContain("failed");
    expect(failedReasonsFor(frames, hunk.hunkId).join("")).toContain("正文已变化");
    expect(firstFrameIndex(frames, "documentSnapshotWritten")).toBeLessThan(
      firstFrameIndex(frames, "toolCallUpdated"),
    );
  });

  it("全部 hunk 的目标均已删除时不写空 patch 版本，并按冲突收尾", async () => {
    const state = createSession("commit-all-targets-deleted");
    const survivor = paragraph("blk-survivor", "未涉及正文");
    const base = doc([paragraph("blk-a", "原文"), survivor]);
    const draft = doc([paragraph("blk-a", "AI 修改"), survivor]);
    const [hunk] = seedReviewState(state, base, draft);
    if (!hunk) throw new Error("fixture missing hunk");

    const canonical = doc([survivor]);
    await seedCanonical(state, canonical);
    const frames = await collectFrames(commitPatches(state, [hunk.hunkId]));
    const stored = await documentRepo.load(state.docId);

    expect(stored?.docVersion).toBe(1);
    expect(stored?.pmDoc).toEqual(canonical);
    expect(await patchStepCounts(state.docId)).toEqual([]);
    expect(toolStatusesFor(frames, hunk.hunkId)).toContain("failed");
    expect(firstFrameIndex(frames, "documentSnapshotWritten")).toBeLessThan(
      firstFrameIndex(frames, "toolCallUpdated"),
    );
  });

  it("损坏的空 insert hunk 不写空 patch 版本", async () => {
    const state = createSession("commit-empty-insert-hunk");
    const base = doc([paragraph("blk-a", "原文")]);
    const draft = doc([paragraph("blk-a", "原文"), paragraph("blk-new", "AI 新增")]);
    const [hunk] = seedReviewState(state, base, draft);
    if (!hunk) throw new Error("fixture missing insert hunk");
    hunk.after = null;
    if (state.suggestions.get(hunk.hunkId)?.suggestion.diffHunk) {
      state.suggestions.get(hunk.hunkId)!.suggestion.diffHunk!.after = null;
    }
    await seedCanonical(state, base);

    const frames = await collectFrames(commitPatches(state, [hunk.hunkId]));
    const stored = await documentRepo.load(state.docId);

    expect(stored?.docVersion).toBe(1);
    expect(stored?.pmDoc).toEqual(base);
    expect(await patchStepCounts(state.docId)).toEqual([]);
    expect(toolStatusesFor(frames, hunk.hunkId)).toContain("failed");
  });
});

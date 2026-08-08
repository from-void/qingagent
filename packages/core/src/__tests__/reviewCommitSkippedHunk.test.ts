import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, ChatMessage, DiffHunk, DocSuggestion } from "@qingagent/contract-ts";
import {
  getPmContentHash,
  pmToLegacySections,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
} from "@qingagent/pm-schema";
import type { LegacySection } from "@qingagent/contract-ts";
import {
  commitPatches,
  createSession,
  rehydratePendingDraft,
  type SessionState,
} from "../bridge/index.js";
import { buildDraftDiff } from "../doc-engine/proposalDiff.js";
import {
  documentDraftRepo,
  documentRepo,
  insertVersion,
  upsertDocumentSuggestion,
} from "@qingagent/db";
import { getDocumentsClient } from "@qingagent/db";
import {
  documentInput,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";
import { buildSuggestionToolCallSpec } from "../agent-run/toolCards.js";

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

async function seedReviewState(
  state: SessionState,
  base: PmDoc,
  draft: PmDoc,
): Promise<DiffHunk[]> {
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
      blockIndex: hunk.blockPath[0] ?? 0,
      suggestion,
      diffHunk: hunk,
    });
    await upsertDocumentSuggestion(suggestion);
  }
  const reviewMessage: ChatMessage = {
    id: "msg-review",
    role: { kind: "agent" },
    ts: "2026-07-17T00:00:00.000Z",
    parts: [
      ...[...state.suggestions.values()].map((record) => ({
        kind: "toolCall" as const,
        data: buildSuggestionToolCallSpec(record.suggestion, { kind: "reviewing" }),
      })),
      {
        kind: "patchSummary" as const,
        data: { count: hunks.length, hunkIds: hunks.map((hunk) => hunk.hunkId) },
      },
    ],
    chips: null,
  };
  state.chatHistory.push(reviewMessage);
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

describe("审核提交：部分采纳重放与整批候选事务门", () => {
  it("RF3: canonical 已提交但 rebase 批次写库失败后，冷恢复可重放保留项", async () => {
    const sessionId = "commit-rebase-recovery";
    const state = createSession(sessionId);
    const base = doc([paragraph("blk-a", "甲原文"), paragraph("blk-b", "乙原文")]);
    const draft = doc([paragraph("blk-a", "甲新文"), paragraph("blk-b", "乙新文")]);
    const [hunkA, hunkB] = await seedReviewState(state, base, draft);
    if (!hunkA || !hunkB) throw new Error("fixture missing hunks");
    await seedCanonical(state, base);
    await insertVersion({
      versionId: `${sessionId}:v1`,
      docId: sessionId,
      docVersion: 1,
      contentHash: getPmContentHash(base),
      schemaVersion: 1,
      actorType: "agent",
      summary: "测试基线",
      snapshotPm: base,
      parentVersion: 0,
      createdAt: "2026-07-21T00:00:00.000Z",
    });
    await documentDraftRepo.savePending({
      docId: state.docId,
      threadId: state.threadId ?? state.sessionId,
      baseVersion: 1,
      baseHash: getPmContentHash(base),
      draftPmDoc: draft,
    });

    await getDocumentsClient().execute(`CREATE TRIGGER fail_rf3_rebased_suggestion
      BEFORE INSERT ON document_suggestions
      WHEN NEW.doc_id = '${sessionId}' AND NEW.base_version = 2
      BEGIN
        SELECT RAISE(ABORT, 'injected RF3 rebase persistence failure');
      END`);

    await expect(collectFrames(commitPatches(state, [hunkA.hunkId])))
      .rejects.toThrow("injected RF3 rebase persistence failure");
    await getDocumentsClient().execute("DROP TRIGGER fail_rf3_rebased_suggestion");

    const canonical = await documentRepo.load(sessionId);
    expect(canonical?.docVersion).toBe(2);
    expect(canonical?.pmDoc?.content.map(blockText)).toEqual(["甲新文", "乙原文"]);
    expect((await documentDraftRepo.load(sessionId))?.baseVersion).toBe(1);

    const restarted = createSession(sessionId);
    restarted.doc = canonical!.pmDoc!;
    restarted.docVersion = canonical!.docVersion;
    const restored = await rehydratePendingDraft(restarted);

    expect(restored.kind).toBe("restored");
    expect(restarted.docState).toEqual({ kind: "pendingReview" });
    expect([...restarted.suggestions.values()]).toHaveLength(1);
    expect([...restarted.suggestions.values()][0]?.diffHunk?.anchor.blockId).toBe("blk-b");
    expect(restarted.docDraftCandidateDoc?.content.map(blockText)).toEqual(["甲新文", "乙新文"]);
    expect((await documentDraftRepo.load(sessionId))?.baseVersion).toBe(2);
  });

  it("rebase 失锚的剩余 suggestion 落 conflict 并发 failed 终态帧", async () => {
    const state = createSession("commit-rebase-dropped-hunk");
    const base = doc([paragraph("blk-a", "甲原文"), paragraph("blk-b", "乙原文")]);
    const draft = doc([paragraph("blk-a", "甲新文"), paragraph("blk-b", "乙新文")]);
    const [rejectedHunk, droppedHunk] = await seedReviewState(state, base, draft);
    if (!rejectedHunk || !droppedHunk) throw new Error("fixture missing hunks");
    state.patchVerdicts.set(rejectedHunk.hunkId, "rejected");

    const canonical = doc([paragraph("blk-a", "甲原文")]);
    state.doc = canonical;
    await seedCanonical(state, canonical);

    const frames = await collectFrames(commitPatches(state, [rejectedHunk.hunkId]));
    const stored = await getDocumentsClient().execute({
      sql: "SELECT status, conflict_json FROM document_suggestions WHERE id = ?",
      args: [droppedHunk.hunkId],
    });

    expect(toolStatusesFor(frames, droppedHunk.hunkId)).toContain("failed");
    expect(failedReasonsFor(frames, droppedHunk.hunkId)).toContain(
      "目标位置已被前序修改改变,该条已失效,未写入",
    );
    expect(stored.rows[0]?.status).toBe("conflict");
    expect(JSON.parse(String(stored.rows[0]?.conflict_json))).toMatchObject({
      kind: "block_removed",
      message: "目标位置已被前序修改改变,该条已失效,未写入",
      suggestionId: droppedHunk.hunkId,
    });
    expect(state.suggestions.size).toBe(0);
  });

  it("恢复记录仅 suggestion.diffHunk 时仍如实结算被跳过的 hunk", async () => {
    const state = createSession("commit-partial-skip-deleted-block");
    const base = doc([paragraph("blk-a", "甲原文"), paragraph("blk-b", "乙原文")]);
    const draft = doc([paragraph("blk-a", "甲新文"), paragraph("blk-b", "乙新文")]);
    const [hunkA, hunkB] = await seedReviewState(state, base, draft);
    if (!hunkA || !hunkB) throw new Error("fixture missing hunks");
    state.docDraftCandidateDoc = null;
    state.suggestions.get(hunkB.hunkId)!.diffHunk = undefined;
    expect(state.suggestions.get(hunkB.hunkId)?.suggestion.diffHunk).toEqual(hunkB);

    await seedCanonical(state, doc([paragraph("blk-a", "甲原文")]));
    const frames = await collectFrames(
      commitPatches(state, [hunkA.hunkId, hunkB.hunkId]),
    );

    expect(state.doc?.content.map(blockText)).toEqual(["甲新文"]);
    expect(await patchStepCounts(state.docId)).toEqual([1]);
    expect(toolStatusesFor(frames, hunkA.hunkId)).not.toContain("failed");
    expect(toolStatusesFor(frames, hunkB.hunkId)).toContain("failed");
    expect(failedReasonsFor(frames, hunkB.hunkId).join("")).toContain("失效");
    expect(failedReasonsFor(frames, hunkB.hunkId).join("")).not.toContain("未写入");

    const summary = state.chatHistory
      .flatMap((message) => message.parts)
      .find((part) => part.kind === "patchSummary");
    expect(summary).toMatchObject({
      kind: "patchSummary",
      data: {
        reviewOutcome: "committed",
        appliedCount: 1,
        conflictCount: 1,
      },
    });
    expect(frames.find((frame) => frame.kind === "docCommitted")).toMatchObject({
      data: { appliedCount: 1, conflictCount: 1 },
    });
    expect(state.suggestions.size).toBe(0);
    expect(state.docState).toEqual({ kind: "editing" });
  });

  it("整批应用遇到同版本基线哈希漂移时不部分落库并保留全部候选", async () => {
    const state = createSession("commit-skip-deleted-block");
    const base = doc([paragraph("blk-a", "甲原文"), paragraph("blk-b", "乙原文")]);
    const draft = doc([paragraph("blk-a", "甲新文"), paragraph("blk-b", "乙新文")]);
    const [hunkA, hunkB] = await seedReviewState(state, base, draft);
    if (!hunkA || !hunkB) throw new Error("fixture missing hunks");

    // 并发删除 blk-b:canonical 只剩 blk-a，版本号未变但内容哈希已漂移。
    const canonical = doc([paragraph("blk-a", "甲原文")]);
    await seedCanonical(state, canonical);

    const frames = await collectFrames(
      commitPatches(state, [hunkA.hunkId, hunkB.hunkId]),
    );

    expect((await documentRepo.load(state.docId))?.pmDoc).toEqual(canonical);
    expect(state.doc?.content.map(blockText)).toEqual(["甲原文", "乙原文"]);
    expect(await patchStepCounts(state.docId)).toEqual([]);
    expect(frames.some((frame) => frame.kind === "docCommitted")).toBe(false);
    expect(toolStatusesFor(frames, hunkA.hunkId)).not.toContain("failed");
    expect(toolStatusesFor(frames, hunkB.hunkId)).not.toContain("failed");
    expect(state.suggestions.size).toBe(2);
    expect(state.docState).toEqual({ kind: "pendingReview" });
  });

  it("同 blockId 正文已漂移时整批 fail-closed，并保留候选供用户处理", async () => {
    const state = createSession("commit-fail-closed-changed-block");
    const base = doc([paragraph("blk-a", "用户原文")]);
    const draft = doc([paragraph("blk-a", "AI 修改")]);
    const [hunk] = await seedReviewState(state, base, draft);
    if (!hunk) throw new Error("fixture missing hunk");

    const userEdited = doc([paragraph("blk-a", "用户提交前又手动修改")]);
    await seedCanonical(state, userEdited);

    const frames = await collectFrames(commitPatches(state, [hunk.hunkId]));
    const stored = await documentRepo.load(state.docId);

    expect(stored?.pmDoc?.content.map(blockText)).toEqual(["用户提交前又手动修改"]);
    expect(state.doc?.content.map(blockText)).toEqual(["用户原文"]);
    expect(await patchStepCounts(state.docId)).toEqual([]);
    expect(toolStatusesFor(frames, hunk.hunkId)).not.toContain("failed");
    expect(frames.some((frame) => frame.kind === "documentSnapshotWritten")).toBe(false);
    expect(frames.some((frame) => frame.kind === "docCommitted")).toBe(false);
    expect(state.suggestions.has(hunk.hunkId)).toBe(true);
    expect(state.docState).toEqual({ kind: "pendingReview" });
  });

  it("表格整块 hunk 的 canonical 已被用户改动时 fail-closed，不覆盖未选中单元格", async () => {
    const state = createSession("commit-fail-closed-changed-table");
    const base = doc([table("table-a", "用户原文", "待修改")]);
    const draft = doc([table("table-a", "用户原文", "AI 修改")]);
    const [hunk] = await seedReviewState(state, base, draft);
    if (!hunk) throw new Error("fixture missing table hunk");

    const userEdited = doc([table("table-a", "用户提交前手改", "待修改")]);
    await seedCanonical(state, userEdited);

    const frames = await collectFrames(commitPatches(state, [hunk.hunkId]));
    const stored = await documentRepo.load(state.docId);

    expect(stored?.pmDoc).toEqual(userEdited);
    expect(state.doc).toEqual(base);
    expect(await patchStepCounts(state.docId)).toEqual([]);
    expect(toolStatusesFor(frames, hunk.hunkId)).not.toContain("failed");
    expect(frames.some((frame) => frame.kind === "documentSnapshotWritten")).toBe(false);
    expect(frames.some((frame) => frame.kind === "docCommitted")).toBe(false);
    expect(state.suggestions.has(hunk.hunkId)).toBe(true);
    expect(state.docState).toEqual({ kind: "pendingReview" });
  });

  it("全部 hunk 的目标均已删除时不写空 patch 版本，并保留候选", async () => {
    const state = createSession("commit-all-targets-deleted");
    const survivor = paragraph("blk-survivor", "未涉及正文");
    const base = doc([paragraph("blk-a", "原文"), survivor]);
    const draft = doc([paragraph("blk-a", "AI 修改"), survivor]);
    const [hunk] = await seedReviewState(state, base, draft);
    if (!hunk) throw new Error("fixture missing hunk");

    const canonical = doc([survivor]);
    await seedCanonical(state, canonical);
    const frames = await collectFrames(commitPatches(state, [hunk.hunkId]));
    const stored = await documentRepo.load(state.docId);

    expect(stored?.docVersion).toBe(1);
    expect(stored?.pmDoc).toEqual(canonical);
    expect(await patchStepCounts(state.docId)).toEqual([]);
    expect(toolStatusesFor(frames, hunk.hunkId)).not.toContain("failed");
    expect(frames.some((frame) => frame.kind === "documentSnapshotWritten")).toBe(false);
    expect(state.suggestions.has(hunk.hunkId)).toBe(true);
    expect(state.docState).toEqual({ kind: "pendingReview" });
  });

  it("hunk 载荷损坏但权威候选完整时仍按候选可靠落库", async () => {
    const state = createSession("commit-empty-insert-hunk");
    const base = doc([paragraph("blk-a", "原文")]);
    const draft = doc([paragraph("blk-a", "原文"), paragraph("blk-new", "AI 新增")]);
    const [hunk] = await seedReviewState(state, base, draft);
    if (!hunk) throw new Error("fixture missing insert hunk");
    hunk.after = null;
    if (state.suggestions.get(hunk.hunkId)?.suggestion.diffHunk) {
      state.suggestions.get(hunk.hunkId)!.suggestion.diffHunk!.after = null;
    }
    await seedCanonical(state, base);

    const frames = await collectFrames(commitPatches(state, [hunk.hunkId]));
    const stored = await documentRepo.load(state.docId);

    expect(stored?.docVersion).toBe(2);
    expect(stored?.pmDoc).toEqual(draft);
    expect(await patchStepCounts(state.docId)).toEqual([1]);
    expect(frames.some((frame) => frame.kind === "docCommitted")).toBe(true);
    expect(toolStatusesFor(frames, hunk.hunkId)).not.toContain("failed");
  });
});

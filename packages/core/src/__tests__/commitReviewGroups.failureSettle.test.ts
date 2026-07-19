import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, DiffHunk, DocSuggestion, PatchConflict } from "@qingagent/contract-ts";
import { pmToLegacySections, type PmBlockNode, type PmDoc, type PmInlineNode } from "@qingagent/pm-schema";
import { commitDocumentOp, type CommitDocumentOpResult } from "../doc-engine/commitDocumentOp.js";
import {
  commitReviewGroups,
  createSession,
  deriveContentState,
  type SessionState,
  type SuggestionRecord,
} from "../bridge/index.js";
import { buildDraftDiff } from "../doc-engine/proposalDiff.js";
import { upsertDocumentSuggestion } from "@qingagent/db";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "@qingagent/db/testing";

vi.mock("../doc-engine/commitDocumentOp.js", () => ({
  commitDocumentOp: vi.fn(),
}));

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

function doc(content: PmBlockNode[]): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content,
  };
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
  state.legacySections = pmToLegacySections(base) as never;
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
  return hunks;
}

async function collectFrames(gen: AsyncIterable<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function toolStatusesFor(frames: readonly BridgeFrame[], suggestionId: string): string[] {
  return frames
    .filter((frame) => frame.kind === "toolCallUpdated" && frame.data.toolCallId === suggestionId)
    .map((frame) => frame.kind === "toolCallUpdated" ? frame.data.spec.status.kind : "");
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

function makePatchConflict(suggestionId: string, blockId: string): PatchConflict {
  return {
    kind: "target_text_changed",
    message: "目标文本内容已变化，未应用修改。",
    suggestionId,
    blockId,
    currentVersion: 2,
  };
}

beforeEach(() => {
  tempDb = prepareTempDocumentsDb("qingagent-commit-failure-settle-");
  vi.mocked(commitDocumentOp).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  tempDb.cleanup();
});

describe("commitReviewGroups 失败 settle", () => {
  it.each([
    [
      "conflict",
      (hunk: DiffHunk): CommitDocumentOpResult => ({
        status: "conflict",
        currentVersion: 2,
        currentHash: "hash-v2",
      }),
      "文档已被更新，本次修改未写入。",
    ],
    [
      "patch_conflict",
      (hunk: DiffHunk): CommitDocumentOpResult => ({
        status: "patch_conflict",
        currentVersion: 1,
        currentHash: "hash-v1",
        conflicts: [makePatchConflict(hunk.hunkId, hunk.anchor.blockId ?? "block-a")],
      }),
      "目标文本内容已变化，未应用修改。",
    ],
    [
      "validation_error",
      (): CommitDocumentOpResult => ({
        status: "validation_error",
        errors: [{ path: ["content", 0], message: "Invalid PM node" }],
      }),
      "修改后的文档格式有问题，未写入。",
    ],
    [
      "not_found",
      (): CommitDocumentOpResult => ({ status: "not_found" }),
      "文档不存在，本次修改未写入。",
    ],
  ])("%s 后本次接受项进入 failed 终态并解锁编辑", async (_name, makeResult, reason) => {
    const state = createSession(`failure-${_name}`);
    const base = doc([paragraph("block-a", "A 旧")]);
    const draft = doc([paragraph("block-a", "A 新")]);
    const [hunk] = await seedDiffState(state, base, draft);
    if (!hunk) throw new Error("fixture missing hunk");
    vi.mocked(commitDocumentOp).mockResolvedValueOnce(makeResult(hunk));

    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [hunk.reviewBatchId ?? hunk.hunkId],
    }));

    expect(state.suggestions.size).toBe(0);
    expect(deriveContentState(state)).toEqual({ kind: "editing" });
    expect(toolStatusesFor(frames, hunk.hunkId)).toContain("failed");
    expect(failedReasonsFor(frames, hunk.hunkId)).toContain(reason);
  });

  it("commitDocumentOp 抛异常后也只 settle 本次 records", async () => {
    const state = createSession("failure-exception");
    const base = doc([paragraph("block-a", "A 旧")]);
    const draft = doc([paragraph("block-a", "A 新")]);
    const [hunk] = await seedDiffState(state, base, draft);
    if (!hunk) throw new Error("fixture missing hunk");
    vi.mocked(commitDocumentOp).mockRejectedValueOnce(new Error("db timeout"));

    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [hunk.reviewBatchId ?? hunk.hunkId],
    }));

    expect(state.suggestions.size).toBe(0);
    expect(deriveContentState(state)).toEqual({ kind: "editing" });
    expect(toolStatusesFor(frames, hunk.hunkId)).toContain("failed");
    expect(failedReasonsFor(frames, hunk.hunkId)).toContain("db timeout");
  });

  it("部分提交失败时保留 keepPending 和提交期间新增的 suggestion", async () => {
    const state = createSession("failure-keep-pending");
    const base = doc([
      paragraph("block-a", "A 旧"),
      paragraph("block-b", "B 旧"),
    ]);
    const draft = doc([
      paragraph("block-a", "A 新"),
      paragraph("block-b", "B 新"),
    ]);
    const hunks = await seedDiffState(state, base, draft);
    const [hunkA, hunkB] = hunks;
    if (!hunkA || !hunkB) throw new Error("fixture missing hunks");
    const keepRecord = state.suggestions.get(hunkB.hunkId);
    if (!keepRecord) throw new Error("fixture missing keep record");

    vi.mocked(commitDocumentOp).mockImplementationOnce(async () => {
      const lateSuggestion: DocSuggestion = {
        ...keepRecord.suggestion,
        id: "late-suggestion",
        reviewBatchId: "late-batch",
        status: "reviewing",
      };
      const lateRecord: SuggestionRecord = {
        ...keepRecord,
        toolCallId: lateSuggestion.id,
        suggestion: lateSuggestion,
      };
      state.suggestions.set(lateSuggestion.id, lateRecord);
      return {
        status: "conflict",
        currentVersion: 2,
        currentHash: "hash-v2",
      };
    });

    const frames = await collectFrames(commitReviewGroups(state, {
      acceptReviewBatchIds: [hunkA.reviewBatchId ?? hunkA.hunkId],
      keepPendingReviewBatchIds: [hunkB.reviewBatchId ?? hunkB.hunkId],
    }));

    expect(state.suggestions.has(hunkA.hunkId)).toBe(false);
    expect(state.suggestions.has(hunkB.hunkId)).toBe(true);
    expect(state.suggestions.has("late-suggestion")).toBe(true);
    expect(deriveContentState(state)).toEqual({ kind: "pendingReview" });
    expect(toolStatusesFor(frames, hunkA.hunkId)).toContain("failed");
  });
});

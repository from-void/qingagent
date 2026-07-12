import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getPmContentHash,
  isGeneratedAiBlockId,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
  type PmMark,
} from "@qingagent/pm-schema";
import { rebaseRemainingPendingDraft } from "../doc-engine/pendingDraftRebase.js";
import { applyDiffHunks, buildDraftDiff } from "../doc-engine/proposalDiff.js";
import type { SuggestionRecord } from "../session/sessionState.js";
import { documentDraftRepo } from "@qingagent/db";
import {
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";

let tempDb: TempDocumentsDb;

function text(value: string, marks?: PmMark[]): PmInlineNode {
  return marks && marks.length > 0
    ? { type: "text", text: value, marks }
    : { type: "text", text: value };
}

function paragraph(blockId: string, value: string | PmInlineNode[]): PmBlockNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: typeof value === "string" ? [text(value)] : value,
  };
}

function doc(blocks: PmBlockNode[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content: blocks };
}

function docText(pmDoc: PmDoc): string {
  return pmDoc.content
    .map((block) =>
      "content" in block && Array.isArray(block.content)
        ? block.content.map((node) => (node.type === "text" ? node.text : "\n")).join("")
        : "",
    )
    .join("\n");
}

function recordsFromDiff(base: PmDoc, draft: PmDoc, baseVersion = 1): SuggestionRecord[] {
  return buildDraftDiff(base, draft, { baseVersion }).map((hunk) => ({
    messageId: "msg-review",
    toolCallId: hunk.hunkId,
    before: hunk.beforeText ?? "",
    after: hunk.afterText ?? "",
    blockIndex: hunk.blockPath[0] ?? 0,
    suggestion: {
      id: hunk.hunkId,
      docId: "doc-rebase",
      baseVersion,
      baseSchemaVersion: 1,
      status: "reviewing",
      anchor: {
        blockId: hunk.anchor.blockId ?? hunk.hunkId,
        pmFrom: hunk.anchor.pmFrom ?? 0,
        pmTo: hunk.anchor.pmTo ?? hunk.anchor.pmFrom ?? 0,
        quote: hunk.beforeText ?? hunk.afterText ?? hunk.summary,
        textHash: `hash-${hunk.hunkId}`,
      },
      patch: { kind: "prosemirror_steps", steps: [] },
      preview: {
        deleteText: hunk.beforeText ?? "",
        insertText: hunk.afterText ?? "",
      },
      reviewBatchId: hunk.reviewBatchId,
      groupMode: hunk.groupMode,
      diffHunk: hunk,
      summary: hunk.summary,
    },
    diffHunk: hunk,
  }));
}

beforeEach(() => {
  tempDb = prepareTempDocumentsDb("qingagent-pending-rebase-");
});

afterEach(() => {
  tempDb.cleanup();
});

describe("rebaseRemainingPendingDraft", () => {
  it("全接受或全拒绝时清理 pending row", async () => {
    const base = doc([paragraph("block-a", "A 旧")]);
    const draft = doc([paragraph("block-a", "A 新")]);
    await documentDraftRepo.savePending({
      docId: "doc-clear",
      threadId: "thread-clear",
      baseVersion: 1,
      baseHash: getPmContentHash(base),
      draftPmDoc: draft,
    });

    const result = await rebaseRemainingPendingDraft({
      docId: "doc-clear",
      threadId: "thread-clear",
      oldBaseDoc: base,
      oldDraftDoc: draft,
      committedDoc: draft,
      committedVersion: 2,
      remainingRecords: [],
    });

    expect(result.status).toBe("cleared");
    await expect(documentDraftRepo.load("doc-clear")).resolves.toBeNull();
  });

  it("部分接受 A 后,B/C 从 committedDoc 克隆并 rebase 到新 base", async () => {
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
    const records = recordsFromDiff(base, draft, 1);
    const committed = applyDiffHunks(base, [records[0]!.diffHunk!]).doc;

    const result = await rebaseRemainingPendingDraft({
      docId: "doc-partial",
      threadId: "thread-partial",
      oldBaseDoc: base,
      oldDraftDoc: draft,
      committedDoc: committed,
      committedVersion: 2,
      remainingRecords: records.slice(1),
    });

    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;
    expect(docText(result.nextDraftDoc)).toBe("A 新\nB 新\nC 新");
    expect(result.baseHash).toBe(getPmContentHash(committed));
    expect(result.hunks.map((hunk) => hunk.anchor.blockId).sort()).toEqual(["block-b", "block-c"]);
    const loaded = await documentDraftRepo.load("doc-partial");
    expect(loaded?.baseVersion).toBe(2);
    expect(loaded?.baseHash).toBe(getPmContentHash(committed));
  });

  it("rebase 后 readDiff 新基线不再包含已接受的 A", async () => {
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
    const records = recordsFromDiff(base, draft, 1);
    const committed = applyDiffHunks(base, [records[0]!.diffHunk!]).doc;

    const result = await rebaseRemainingPendingDraft({
      docId: "doc-read-diff",
      threadId: "thread-read-diff",
      oldBaseDoc: base,
      oldDraftDoc: draft,
      committedDoc: committed,
      committedVersion: 2,
      remainingRecords: records.slice(1),
      persist: false,
    });

    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;
    const nextHunks = buildDraftDiff(committed, result.nextDraftDoc, { baseVersion: 2 });
    expect(nextHunks.map((hunk) => hunk.anchor.blockId).sort()).toEqual(["block-b", "block-c"]);
  });

  it("同段部分采纳后 rebase 剩余 hunk 不因重复文本误定位", async () => {
    const base = doc([paragraph("block-a", "df eeffba  efdefe b ")]);
    const draft = doc([paragraph("block-a", "df eeffbbac ed befee ebff ")]);
    const records = recordsFromDiff(base, draft, 1);
    // 锚点清理后:2 字公共段("ef")保留成拆点,首处覆盖拆成两笔。
    expect(records.map((record) => [record.before, record.after])).toEqual([
      ["a ", "bac"],
      ["fd", "d b"],
      ["", "e"],
      ["b", "ebff"],
    ]);
    // 按内容取纯插入记录,先提交其余处,再 rebase 落这一处。
    const insert = records.find((record) => record.before === "" && record.after === "e");
    if (!insert) throw new Error("fixture missing pure insert record");
    const committed = applyDiffHunks(
      base,
      records.filter((record) => record !== insert).map((record) => record.diffHunk!),
    ).doc;

    const result = await rebaseRemainingPendingDraft({
      docId: "doc-inline-repeat-rebase",
      threadId: "thread-inline-repeat-rebase",
      oldBaseDoc: base,
      oldDraftDoc: draft,
      committedDoc: committed,
      committedVersion: 2,
      remainingRecords: [insert],
      persist: false,
    });

    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;
    expect(docText(result.nextDraftDoc)).toBe("df eeffbbac ed befee ebff ");
  });

  it("insert 按 anchor.blockId + gravity 重新定位", async () => {
    const base = doc([
      paragraph("block-a", "A"),
      paragraph("block-b", "B"),
    ]);
    const inserted = paragraph("block-x", "X");
    const draft = doc([
      paragraph("block-a", "A"),
      inserted,
      paragraph("block-b", "B"),
    ]);
    const [insertRecord] = recordsFromDiff(base, draft, 1);
    const committed = doc([
      paragraph("block-a", "A committed"),
      paragraph("block-b", "B"),
    ]);

    const result = await rebaseRemainingPendingDraft({
      docId: "doc-insert",
      threadId: "thread-insert",
      oldBaseDoc: base,
      oldDraftDoc: draft,
      committedDoc: committed,
      committedVersion: 2,
      remainingRecords: [insertRecord!],
      persist: false,
    });

    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;
    expect(result.nextDraftDoc.content.map((block) => block.attrs.blockId)).toEqual([
      "block-a",
      "block-x",
      "block-b",
    ]);
  });

  it("唯一剩余 hunk 的 anchor 已被同轮决定移除时,丢弃该处并清空 pending(绝不锁死整轮评审)", async () => {
    const base = doc([
      paragraph("block-a", "A"),
      paragraph("block-b", "B"),
    ]);
    const draft = doc([
      paragraph("block-a", "A"),
      paragraph("block-b", "B 新"),
    ]);
    const records = recordsFromDiff(base, draft, 1);
    const committed = doc([paragraph("block-a", "A committed")]);
    await documentDraftRepo.savePending({
      docId: "doc-anchor-miss",
      threadId: "thread-anchor-miss",
      baseVersion: 1,
      baseHash: getPmContentHash(base),
      draftPmDoc: draft,
    });

    const result = await rebaseRemainingPendingDraft({
      docId: "doc-anchor-miss",
      threadId: "thread-anchor-miss",
      oldBaseDoc: base,
      oldDraftDoc: draft,
      committedDoc: committed,
      committedVersion: 2,
      remainingRecords: records,
    });
    const row = await documentDraftRepo.load("doc-anchor-miss");

    // 旧行为会把整轮判 conflict 锁死;新行为丢弃这一处落点失败的改动,剩下没有可应用项 → 清空。
    expect(result.status).toBe("cleared");
    expect(row).toBeNull();
  });

  it("多处剩余 hunk 里只有一处 anchor 失效时,丢弃失效处、其余照常 rebase(评审不被锁死)", async () => {
    // 模拟"一处 AI 改稿拆成多处"评审:committed 已经移除了 block-b(某处决定的结果),
    // 余下两处 hunk 一处指向已消失的 block-b(应丢弃)、一处指向仍在的 block-c(应保留)。
    const base = doc([
      paragraph("block-a", "A"),
      paragraph("block-b", "B"),
      paragraph("block-c", "C"),
    ]);
    const draft = doc([
      paragraph("block-a", "A"),
      paragraph("block-b", "B 新"),
      paragraph("block-c", "C 新"),
    ]);
    const records = recordsFromDiff(base, draft, 1);
    const committed = doc([
      paragraph("block-a", "A committed"),
      paragraph("block-c", "C"),
    ]);
    await documentDraftRepo.savePending({
      docId: "doc-anchor-partial",
      threadId: "thread-anchor-partial",
      baseVersion: 1,
      baseHash: getPmContentHash(base),
      draftPmDoc: draft,
    });

    const result = await rebaseRemainingPendingDraft({
      docId: "doc-anchor-partial",
      threadId: "thread-anchor-partial",
      oldBaseDoc: base,
      oldDraftDoc: draft,
      committedDoc: committed,
      committedVersion: 2,
      remainingRecords: records,
    });

    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;
    // block-b 那处被丢弃,只剩 block-c → C 新 这一处可继续评审。
    expect(docText(result.nextDraftDoc)).toContain("C 新");
    expect(result.nextDraftDoc.content.map((block) => block.attrs.blockId)).not.toContain("block-b");
    const row = await documentDraftRepo.load("doc-anchor-partial");
    expect(row?.status).toBe("pending_review");
  });

  it("anchor blockId 失效时不回退旧 index,避免把同位置后继块误改并复活旧 blockId", async () => {
    const base = doc([
      paragraph("block-a", "A"),
      paragraph("block-b1", "B"),
      paragraph("block-b2", "B"),
    ]);
    const draft = doc([
      paragraph("block-a", "A"),
      paragraph("block-b1", "X"),
      paragraph("block-b2", "B"),
    ]);
    const records = recordsFromDiff(base, draft, 1);
    const committed = doc([
      paragraph("block-a", "A"),
      paragraph("block-b2", "B"),
    ]);

    const result = await rebaseRemainingPendingDraft({
      docId: "doc-anchor-index-fallback",
      threadId: "thread-anchor-index-fallback",
      oldBaseDoc: base,
      oldDraftDoc: draft,
      committedDoc: committed,
      committedVersion: 2,
      remainingRecords: records,
      persist: false,
    });

    expect(result.status).toBe("cleared");
  });

  it("保存 pending 时 baseHash 使用 PmDoc hash,包含 marks-only 变化", async () => {
    const bold: PmMark = { type: "bold" };
    const base = doc([
      paragraph("block-a", [text("A")]),
      paragraph("block-b", [text("B")]),
    ]);
    const draft = doc([
      paragraph("block-a", [text("A")]),
      paragraph("block-b", [text("B 新")]),
    ]);
    const committedMarksOnly = doc([
      paragraph("block-a", [text("A", [bold])]),
      paragraph("block-b", [text("B")]),
    ]);
    const records = recordsFromDiff(base, draft, 1);

    const result = await rebaseRemainingPendingDraft({
      docId: "doc-hash",
      threadId: "thread-hash",
      oldBaseDoc: base,
      oldDraftDoc: draft,
      committedDoc: committedMarksOnly,
      committedVersion: 2,
      remainingRecords: records,
    });
    const row = await documentDraftRepo.load("doc-hash");

    expect(result.status).toBe("pending");
    expect(row?.baseHash).toBe(getPmContentHash(committedMarksOnly));
    expect(row?.baseHash).not.toBe(getPmContentHash(base));
  });

  it("rebase 结果写 candidate 前会 materialize ai-block-*", async () => {
    const base = doc([
      paragraph("block-a", "A"),
      paragraph("block-b", "B"),
    ]);
    const draft = doc([
      paragraph("block-a", "A"),
      paragraph("ai-block-b", "B 新"),
    ]);
    const records = recordsFromDiff(base, draft, 1);

    const result = await rebaseRemainingPendingDraft({
      docId: "doc-materialize",
      threadId: "thread-materialize",
      oldBaseDoc: base,
      oldDraftDoc: draft,
      committedDoc: base,
      committedVersion: 2,
      remainingRecords: records,
    });
    const row = await documentDraftRepo.load("doc-materialize");

    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;
    expect(result.nextDraftDoc.content.some((block) => isGeneratedAiBlockId(block.attrs.blockId))).toBe(false);
    expect(row?.draftPmDoc.content.some((block) => isGeneratedAiBlockId(block.attrs.blockId))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  applyBlockEdits,
  compileAiDocumentToPm,
  isGeneratedAiBlockId,
  materializeDraftBlockIds,
  type PmBlockNode,
  type PmDoc,
} from "@qingagent/pm-schema";
import { buildDraftDiff } from "../proposalDiff.js";

function textNode(text: string) {
  return { type: "text" as const, text };
}

function paragraph(blockId: string, text: string): PmBlockNode {
  return { type: "paragraph", attrs: { blockId }, content: text ? [textNode(text)] : [] };
}

function doc(content: PmBlockNode[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function compileDoc(blocks: readonly unknown[]): PmDoc {
  const result = compileAiDocumentToPm({ blocks });
  expect(result.ok).toBe(true);
  return result.doc!;
}

describe("AI-IR draft diff 对接", () => {
  it("replaceBlock 在真实 block-* id 上只产生单个 replace hunk", () => {
    const base = doc([paragraph("block-a", "第一段"), paragraph("block-b", "第二段")]);
    const edited = applyBlockEdits(base, [
      { action: "replaceBlock", ref: "block-b", block: { type: "paragraph", runs: [{ text: "第二段已改" }] } },
    ]);
    expect(edited.ok).toBe(true);

    const hunks = buildDraftDiff(base, edited.doc!);

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ op: "replace", anchor: { blockId: "block-b" } });
    expect(hunks.map((hunk) => hunk.op)).not.toEqual(expect.arrayContaining(["insert", "delete"]));
  });

  it("混合 ai-block 与真实 id materialize 后改第二块,只产第二块单 hunk", () => {
    const aiDoc = compileDoc([
      { type: "paragraph", runs: [{ text: "第二段" }] },
      { type: "paragraph", runs: [{ text: "第三段" }] },
    ]);
    const base = materializeDraftBlockIds(doc([paragraph("block-a", "第一段"), ...aiDoc.content]));
    const ref = base.content[1]!.attrs.blockId;

    const edited = applyBlockEdits(base, [
      { action: "replaceBlock", ref, block: { type: "paragraph", runs: [{ text: "第二段已改" }] } },
    ]);
    expect(edited.ok).toBe(true);
    const hunks = buildDraftDiff(base, edited.doc!);

    expect(base.content.every((node) => !isGeneratedAiBlockId(node.attrs.blockId))).toBe(true);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ op: "replace", anchor: { blockId: ref }, blockPath: [1] });
  });

  it("重复空块 materialize 后 replace 第二块不会按指纹错配", () => {
    const base = materializeDraftBlockIds(doc([
      { ...paragraph("ai-block-empty-a", "") },
      { ...paragraph("ai-block-empty-a", "") },
    ]));
    const ref = base.content[1]!.attrs.blockId;
    const edited = applyBlockEdits(base, [
      { action: "replaceBlock", ref, block: { type: "paragraph", runs: [{ text: "第二个空块改写" }] } },
    ]);
    expect(edited.ok).toBe(true);

    const hunks = buildDraftDiff(base, edited.doc!);

    expect(new Set(base.content.map((node) => node.attrs.blockId)).size).toBe(2);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ op: "replace", anchor: { blockId: ref }, blockPath: [1] });
  });

  it("重复文本块 materialize 后 replace 第二块仍按 id 对齐", () => {
    const base = materializeDraftBlockIds(doc([
      paragraph("ai-block-repeat-a", "重复标题"),
      paragraph("ai-block-repeat-a", "重复标题"),
    ]));
    const ref = base.content[1]!.attrs.blockId;
    const edited = applyBlockEdits(base, [
      { action: "replaceBlock", ref, block: { type: "paragraph", runs: [{ text: "只改第二个重复标题" }] } },
    ]);
    expect(edited.ok).toBe(true);

    const hunks = buildDraftDiff(base, edited.doc!);

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ op: "replace", anchor: { blockId: ref }, blockPath: [1] });
  });

  it("同一 base/draft 重复 buildDraftDiff 的 hunkId 稳定", () => {
    const base = doc([paragraph("block-a", "柳树"), paragraph("block-b", "蓝毛巾")]);
    const draft = doc([paragraph("block-a", "胡桃树"), paragraph("block-b", "黄毛巾")]);

    const first = buildDraftDiff(base, draft);
    const second = buildDraftDiff(base, draft);

    expect(first.map((hunk) => hunk.hunkId)).toEqual(second.map((hunk) => hunk.hunkId));
  });
});

import { describe, expect, it } from "vitest";
import {
  aiRunMarkToPmMark,
  applyBlockEdits,
  pmToAiIr,
  pmToPlainText,
  type PmBlockNode,
  type PmDoc,
} from "@qingagent/pm-schema";
import { pmDocFromText } from "./pmTestUtils.js";
import { buildDraftDiff } from "../doc-engine/proposalDiff.js";
import {
  collectTopLevelTextBlocks,
  findLiteralMatches,
  markTextRuns,
  replaceTextRuns,
} from "../doc-engine/textEditOps.js";

function makeBaseDoc(): PmDoc {
  return pmDocFromText("A段旧句。", "B段保持不变。", "C段保持不变。");
}

function block(text: string): Record<string, unknown> {
  return { type: "paragraph", runs: [{ text }] };
}

function blockText(node: PmBlockNode): string {
  return pmToPlainText({ type: "doc", attrs: { schemaVersion: 1 }, content: [node] });
}

function firstRef(doc: PmDoc): string {
  const ref = doc.content[0]?.attrs.blockId;
  if (!ref) throw new Error("missing first ref");
  return ref;
}

function secondRef(doc: PmDoc): string {
  const ref = doc.content[1]?.attrs.blockId;
  if (!ref) throw new Error("missing second ref");
  return ref;
}

describe("S7 L1 editDraft 指标 ④⑤⑥", () => {
  it("④ 零幽灵 hunk：只改 A 不应影响 B/C", () => {
    const base = makeBaseDoc();
    const refA = firstRef(base);
    const refB = secondRef(base);
    const result = applyBlockEdits(base, [{ action: "replaceBlock", ref: refA, block: block("A段已更新。") }]);
    expect(result.ok).toBe(true);

    const hunks = buildDraftDiff(base, result.doc!);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.op).toBe("replace");
    expect(hunks[0]?.anchor.blockId).toBe(refA);
    expect(hunks.some((hunk) => hunk.anchor.blockId === refB)).toBe(false);
  });

  it("⑤ markChange 可见：markText 后产生 markAdd 且 marksChanged > 0", () => {
    const base = makeBaseDoc();
    const matches = findLiteralMatches(collectTopLevelTextBlocks(base), "段", true);
    const draft = markTextRuns(base, matches, aiRunMarkToPmMark({ type: "bold" }), "add");
    const hunks = buildDraftDiff(base, draft);
    const markHunks = hunks.filter((hunk) => hunk.op === "markAdd" || hunk.op === "markRemove");

    expect(markHunks.length).toBeGreaterThan(0);
    expect(markHunks.some((hunk) => hunk.op === "markAdd")).toBe(true);
  });

  it("⑥ read-after-write 不盲改：第二轮前读取到第一轮写入值并保留 ref", () => {
    const base = makeBaseDoc();
    const refA = firstRef(base);
    const round1 = applyBlockEdits(base, [{ action: "replaceBlock", ref: refA, block: block("A段第一轮。") }]);
    expect(round1.ok).toBe(true);
    const aiBeforeRound2 = pmToAiIr(round1.doc!);
    expect(JSON.stringify(aiBeforeRound2.blocks[0])).toContain("A段第一轮。");

    const round2 = applyBlockEdits(round1.doc!, [{ action: "replaceBlock", ref: refA, block: block("A段第二轮。") }]);
    expect(round2.ok).toBe(true);
    expect(round2.applied).toEqual([refA]);
    expect(round2.doc?.content[0]?.attrs.blockId).toBe(refA);
    expect(blockText(round2.doc!.content[0]!)).toBe("A段第二轮。");
  });

  it("多轮 fixture：改 A→同处再改→改 B→全文 replaceAll", () => {
    const base = makeBaseDoc();
    const refA = firstRef(base);
    const refB = secondRef(base);
    const round1 = applyBlockEdits(base, [{ action: "replaceBlock", ref: refA, block: block("A段第一轮。") }]);
    const round2 = applyBlockEdits(round1.doc!, [{ action: "replaceBlock", ref: refA, block: block("A段第二轮。") }]);
    const round3 = applyBlockEdits(round2.doc!, [{ action: "replaceBlock", ref: refB, block: block("B段已更新。") }]);
    const matches = findLiteralMatches(collectTopLevelTextBlocks(round3.doc!), "段", true);
    const round4 = replaceTextRuns(round3.doc!, matches, "节");

    expect(round1.ok && round2.ok && round3.ok).toBe(true);
    expect(pmToPlainText(round4)).toContain("A节第二轮。");
    expect(pmToPlainText(round4)).toContain("B节已更新。");
    expect(buildDraftDiff(base, round4).length).toBeGreaterThan(0);
  });
});

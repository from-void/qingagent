import { describe, expect, it } from "vitest";
import {
  aiRunMarkToPmMark,
  applyBlockEdits,
  compileAiDocumentToPm,
  getStablePmJson,
  legacySectionsToPm,
  pmToAiIr,
  pmToPlainText,
  type PmBlockNode,
  type PmDoc,
} from "@qingagent/pm-schema";
import { extractJson } from "../bridge/docGenerator.js";
import { buildDraftDiff } from "../bridge/proposalDiff.js";
import {
  collectTopLevelTextBlocks,
  findLiteralMatches,
  markTextRuns,
  replaceTextRuns,
} from "../bridge/textEditOps.js";
import { parseAiDocumentOrBlockFromText, parseAiDocumentFromText } from "../tools/generateDoc.js";

type RawEditResult = { ok: true; doc: PmDoc; applied: string[] } | { ok: false; error: string };

function p(text: string) {
  return { kind: "p", data: { text } } as const;
}

function makeBaseDoc(): PmDoc {
  return legacySectionsToPm([p("A段旧句。"), p("B段保持不变。"), p("C段保持不变。")]);
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

function replaceRawBlock(doc: PmDoc, ref: string, raw: unknown): RawEditResult {
  try {
    const parsed = parseAiDocumentOrBlockFromText(raw);
    const compiled = compileAiDocumentToPm(parsed);
    if (!compiled.ok || !compiled.doc) {
      return { ok: false, error: compiled.blockErrors.map((e) => e.message).join("; ") };
    }
    const result = applyBlockEdits(doc, [{ action: "replaceBlock", ref, block: parsed.blocks[0] }]);
    if (!result.ok || !result.doc) return { ok: false, error: result.error ?? "apply failed" };
    return { ok: true, doc: result.doc, applied: result.applied };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function expectDirtyBlockApplies(raw: string, expectedText: string): void {
  const base = makeBaseDoc();
  const ref = firstRef(base);
  const untouchedBefore = getStablePmJson(base.content[1]);
  const json = extractJson(raw);
  const parsed = parseAiDocumentOrBlockFromText(raw);
  const compiled = compileAiDocumentToPm(parsed);
  expect(JSON.parse(json)).toBeTruthy();
  expect(compiled.ok).toBe(true);

  const result = applyBlockEdits(base, [{ action: "replaceBlock", ref, block: parsed.blocks[0] }]);
  expect(result.ok).toBe(true);
  expect(result.applied).toEqual([ref]);
  expect(result.doc?.content[0]?.attrs.blockId).toBe(ref);
  expect(blockText(result.doc!.content[0]!)).toBe(expectedText);
  expect(getStablePmJson(result.doc!.content[1])).toBe(untouchedBefore);
}

describe("S7 L1 editDraft 单块脏输出回归", () => {
  it("块前导话会由真实 extractJson 截到首个完整 block", () => {
    expectDirtyBlockApplies(`这是改好的：\n${JSON.stringify(block("A段前导话已清理。"))}`, "A段前导话已清理。");
  });

  it("收尾散文不会进入 runs", () => {
    const raw = `${JSON.stringify(block("A段只保留 JSON。"))}\n\n已替换该段,共 1 块`;
    expectDirtyBlockApplies(raw, "A段只保留 JSON。");
    const parsed = parseAiDocumentOrBlockFromText(raw);
    expect(JSON.stringify(parsed)).not.toContain("已替换该段");
  });

  it("fence、转义引号、正文含 ]} 都走真实平衡截断", () => {
    expectDirtyBlockApplies(
      ["```json", JSON.stringify(block("A段含转义引号 \"quote\" 与括号 ]}。")), "```"].join("\n"),
      "A段含转义引号 \"quote\" 与括号 ]}。",
    );
  });

  it("截断 JSON 不假成功", () => {
    const raw = '{"type":"paragraph","runs":[{"text":"半截';
    expect(() => JSON.parse(extractJson(raw))).toThrow();
    expect(() => parseAiDocumentOrBlockFromText(raw)).toThrow();
  });

  it("askUser 误触会失败且草稿不动", () => {
    const base = makeBaseDoc();
    const before = getStablePmJson(base);
    const result = replaceRawBlock(base, firstRef(base), { askUser: { question: "要不要继续?" } });
    expect(result.ok).toBe(false);
    expect(getStablePmJson(base)).toBe(before);
  });

  it("数组、单块对象、envelope 三种载体都归一到真实 AI-IR envelope", () => {
    const single = parseAiDocumentOrBlockFromText(block("单块对象"));
    const array = parseAiDocumentOrBlockFromText([block("数组单块")]);
    const envelope = parseAiDocumentOrBlockFromText({ title: "标题", blocks: [block("包裹对象")] });
    const fromDocumentParser = parseAiDocumentFromText(JSON.stringify([block("数组文档")]), "文档标题");

    expect(single.blocks).toHaveLength(1);
    expect(array.blocks).toHaveLength(1);
    expect(envelope).toMatchObject({ title: "标题", blocks: [block("包裹对象")] });
    expect(fromDocumentParser).toMatchObject({ title: "文档标题", blocks: [block("数组文档")] });
  });
});

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

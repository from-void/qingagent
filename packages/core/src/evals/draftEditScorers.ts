import { createScorer } from "@mastra/core/evals";
import {
  aiRunMarkToPmMark,
  applyBlockEdits,
  compileAiDocumentToPm,
  legacySectionsToPm,
  pmToAiIr,
  pmToPlainText,
  type PmDoc,
} from "@qingagent/pm-schema";
import { extractJson } from "../bridge/docGenerator.js";
import { buildDraftDiff } from "../bridge/proposalDiff.js";
import {
  collectTopLevelTextBlocks,
  findLiteralMatches,
  markTextRuns,
} from "../bridge/textEditOps.js";
import { parseAiDocumentOrBlockFromText } from "../tools/generateDoc.js";

export interface DraftEditRawBlockOutput {
  raw: unknown;
  expectedText?: string;
}

export interface DraftEditRepairOutput {
  attempts: unknown[];
  expectedText: string;
}

export interface DraftEditMetricOutput {
  scenario: "base-doc-metric456";
}

function p(text: string) {
  return { kind: "p", data: { text } } as const;
}

export function makeDraftEditBaseDoc(): PmDoc {
  return legacySectionsToPm([
    p("A段旧句。"),
    p("B段旧句。"),
    p("C段保持不变。"),
  ]);
}

export function draftEditBlock(text: string): Record<string, unknown> {
  return { type: "paragraph", runs: [{ text }] };
}

export function draftEditRefAt(doc: PmDoc, index: number): string {
  const ref = doc.content[index]?.attrs.blockId;
  if (!ref) throw new Error(`missing ref at ${index}`);
  return ref;
}

export function applyDraftEditRawBlock(
  doc: PmDoc,
  ref: string,
  raw: unknown,
): { ok: true; doc: PmDoc; applied: string[] } | { ok: false; error: string } {
  try {
    const parsed = parseAiDocumentOrBlockFromText(raw);
    const compiled = compileAiDocumentToPm(parsed);
    if (!compiled.ok || !compiled.doc) {
      return { ok: false, error: compiled.blockErrors.map((e) => e.message).join("; ") };
    }
    const block = parsed.blocks[0];
    if (!block) return { ok: false, error: "missing parsed block" };
    const result = applyBlockEdits(doc, [{ action: "replaceBlock", ref, block }]);
    if (!result.ok || !result.doc) return { ok: false, error: result.error ?? "apply failed" };
    return { ok: true, doc: result.doc, applied: result.applied };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function computeDraftEditMetric456(
  base: PmDoc = makeDraftEditBaseDoc(),
): {
  zeroGhostHunkRate: number;
  markChangeVisibleRate: number;
  readAfterWriteRate: number;
} {
  const refA = draftEditRefAt(base, 0);
  const refB = draftEditRefAt(base, 1);
  const round1 = applyBlockEdits(base, [{
    action: "replaceBlock",
    ref: refA,
    block: draftEditBlock("A段第一轮。"),
  }]);
  if (!round1.ok || !round1.doc) throw new Error("round1 failed");
  const hunks = buildDraftDiff(base, round1.doc);
  const zeroGhost =
    hunks.length === 1 &&
    hunks[0]?.anchor.blockId === refA &&
    !hunks.some((hunk) => hunk.anchor.blockId === refB);

  const matches = findLiteralMatches(collectTopLevelTextBlocks(round1.doc), "段", true);
  const marked = markTextRuns(round1.doc, matches, aiRunMarkToPmMark({ type: "bold" }), "add");
  const markHunks = buildDraftDiff(round1.doc, marked)
    .filter((hunk) => hunk.op === "markAdd" || hunk.op === "markRemove");
  const markChangeVisible = markHunks.length > 0 && markHunks.some((hunk) => hunk.op === "markAdd");

  const beforeRound2 = JSON.stringify(pmToAiIr(round1.doc).blocks[0]);
  const round2 = applyBlockEdits(round1.doc, [{
    action: "replaceBlock",
    ref: refA,
    block: draftEditBlock("A段第二轮。"),
  }]);
  const readAfterWrite =
    beforeRound2.includes("A段第一轮。") &&
    round2.ok &&
    round2.applied.includes(refA) &&
    round2.doc?.content[0]?.attrs.blockId === refA;

  return {
    zeroGhostHunkRate: zeroGhost ? 1 : 0,
    markChangeVisibleRate: markChangeVisible ? 1 : 0,
    readAfterWriteRate: readAfterWrite ? 1 : 0,
  };
}

function canParseJson(raw: unknown): boolean {
  if (typeof raw !== "string") return true;
  JSON.parse(extractJson(raw));
  return true;
}

function applyRawBlockScore(output: DraftEditRawBlockOutput): number {
  const base = makeDraftEditBaseDoc();
  const refA = draftEditRefAt(base, 0);
  try {
    canParseJson(output.raw);
  } catch {
    return 0;
  }
  const applied = applyDraftEditRawBlock(base, refA, output.raw);
  if (!applied.ok) return 0;
  if (output.expectedText && !pmToPlainText(applied.doc).includes(output.expectedText)) return 0;
  return 1;
}

export const draftEditFirstLegalScorer = createScorer<undefined, DraftEditRawBlockOutput>({
  id: "draft-edit-first-legal",
  description: "验证 editDraft 单块输出可由真实 extractJson/AI-IR 解析并首发应用。",
})
  .generateScore(({ run }) => applyRawBlockScore(run.output))
  .generateReason(({ score }) => (score === 1 ? "首发输出合法并可应用" : "首发输出未通过真实解析/应用链路"));

export const draftEditRejectBadOutputScorer = createScorer<undefined, DraftEditRawBlockOutput>({
  id: "draft-edit-reject-bad-output",
  description: "验证 editDraft 脏/截断/误触 askUser 输出不会被真实解析链路误收。",
})
  .generateScore(({ run }) => {
    const base = makeDraftEditBaseDoc();
    const refA = draftEditRefAt(base, 0);
    const applied = applyDraftEditRawBlock(base, refA, run.output.raw);
    return applied.ok ? 0 : 1;
  })
  .generateReason(({ score }) => (score === 1 ? "非法输出被拒绝" : "非法输出被误收"));

export const draftEditRepairScorer = createScorer<undefined, DraftEditRepairOutput>({
  id: "draft-edit-repair",
  description: "验证首发失败后,重试输出可由真实解析/应用链路修复成功。",
})
  .generateScore(({ run }) => {
    const [first, ...rest] = run.output.attempts;
    if (first === undefined || rest.length === 0) return 0;
    const base = makeDraftEditBaseDoc();
    const refA = draftEditRefAt(base, 0);
    if (applyDraftEditRawBlock(base, refA, first).ok) return 0;
    const last = rest.at(-1);
    const applied = applyDraftEditRawBlock(base, refA, last);
    return applied.ok && pmToPlainText(applied.doc).includes(run.output.expectedText) ? 1 : 0;
  })
  .generateReason(({ score }) => (score === 1 ? "失败样本经重试修复" : "重试未修复失败样本"));

export const draftEditHitScorer = createScorer<undefined, DraftEditRawBlockOutput>({
  id: "draft-edit-hit",
  description: "验证 editDraft 输出命中目标 ref,不写错块。",
})
  .generateScore(({ run }) => {
    const base = makeDraftEditBaseDoc();
    const refA = draftEditRefAt(base, 0);
    const applied = applyDraftEditRawBlock(base, refA, run.output.raw);
    return applied.ok && applied.applied.includes(refA) ? 1 : 0;
  })
  .generateReason(({ score }) => (score === 1 ? "命中目标 ref" : "未命中目标 ref"));

function metricOutputScore(
  output: DraftEditMetricOutput,
  key: keyof ReturnType<typeof computeDraftEditMetric456>,
): number {
  if (output.scenario !== "base-doc-metric456") return 0;
  return computeDraftEditMetric456()[key];
}

export const draftEditZeroGhostHunkScorer = createScorer<undefined, DraftEditMetricOutput>({
  id: "draft-edit-zero-ghost-hunk",
  description: "验证单块修改 diff 不产生旁侧 ghost hunk。",
})
  .generateScore(({ run }) => metricOutputScore(run.output, "zeroGhostHunkRate"))
  .generateReason(({ score }) => (score === 1 ? "未产生 ghost hunk" : "出现 ghost hunk"));

export const draftEditMarkChangeVisibleScorer = createScorer<undefined, DraftEditMetricOutput>({
  id: "draft-edit-mark-change-visible",
  description: "验证 markText 变化能进入 diff hunk,前端可见。",
})
  .generateScore(({ run }) => metricOutputScore(run.output, "markChangeVisibleRate"))
  .generateReason(({ score }) => (score === 1 ? "mark 变化可见" : "mark 变化未进入 diff"));

export const draftEditReadAfterWriteScorer = createScorer<undefined, DraftEditMetricOutput>({
  id: "draft-edit-read-after-write",
  description: "验证连续编辑第二轮读取到第一轮写入后的草稿状态。",
})
  .generateScore(({ run }) => metricOutputScore(run.output, "readAfterWriteRate"))
  .generateReason(({ score }) => (score === 1 ? "第二轮读到第一轮结果" : "第二轮未读到第一轮结果"));

export const draftEditMetricScorers = [
  draftEditFirstLegalScorer,
  draftEditRejectBadOutputScorer,
  draftEditRepairScorer,
  draftEditHitScorer,
  draftEditZeroGhostHunkScorer,
  draftEditMarkChangeVisibleScorer,
  draftEditReadAfterWriteScorer,
] as const;

import type { DocSuggestion } from "@qingagent/contract-ts";
import { legacySectionsToPm, pmToLegacySections, type PmDoc } from "@qingagent/pm-schema";
import type { LegacySection } from "@qingagent/contract-ts";
import { describe, expect, it } from "vitest";
import { createSuggestionFromDiffHunk } from "../draftReviewSuggestions.js";
import {
  collectTopLevelTextBlocks,
  findLiteralMatches,
} from "../textEditOps.js";
import { applySuggestionToDoc, applySuggestionsToDoc } from "../pmPatch.js";

function p(text: string): LegacySection {
  return { kind: "p", data: { text } };
}

function doc(text: string): PmDoc {
  return legacySectionsToPm([p(text)]);
}

function plainText(pmDoc: PmDoc): string {
  const [section] = pmToLegacySections(pmDoc) as LegacySection[];
  if (section?.kind === "p") return section.data.text;
  return "";
}

function suggestionFor(
  pmDoc: PmDoc,
  id: string,
  before: string,
  after: string,
): DocSuggestion {
  const [match] = findLiteralMatches(collectTopLevelTextBlocks(pmDoc), before, false);
  if (!match) throw new Error(`测试夹具未找到唯一文本: ${before}`);
  return createSuggestionFromDiffHunk({
    hunk: {
      hunkId: id,
      reviewBatchId: "review:test",
      groupMode: "independent",
      op: "replace",
      blockPath: match.block.path,
      anchor: {
        blockId: match.blockId,
        pmFrom: match.pmFrom,
        pmTo: match.pmTo,
      },
      before: null,
      after: null,
      summary: "测试替换",
      beforeText: before,
      afterText: after,
    },
    docId: "doc-1",
    baseVersion: 1,
    baseSchemaVersion: pmDoc.attrs.schemaVersion,
  });
}

describe("pmPatch", () => {
  it("在当前文本漂移后使用 quote 重新定位", () => {
    const baseDoc = doc("开头 蓝毛巾 结尾");
    const suggestion = suggestionFor(baseDoc, "patch-drift", "蓝毛巾", "黄毛巾");

    const result = applySuggestionToDoc(
      doc("新的前缀。开头 蓝毛巾 结尾"),
      suggestion,
      2,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(plainText(result.doc)).toBe("新的前缀。开头 黄毛巾 结尾");
    expect(result.step.from).toBeGreaterThan(suggestion.anchor.pmFrom);
  });

  it("目标缺失时返回冲突，不修改相似位置", () => {
    const suggestion = suggestionFor(
      doc("开头 蓝毛巾 结尾"),
      "patch-missing",
      "蓝毛巾",
      "黄毛巾",
    );

    const result = applySuggestionToDoc(
      doc("开头 红围巾 结尾"),
      suggestion,
      2,
    );

    expect(result).toMatchObject({
      ok: false,
      conflict: {
        suggestionId: "patch-missing",
        currentVersion: 2,
      },
    });
  });

  it("应用已接受建议时不丢失其他 step", () => {
    const baseDoc = doc("蓝毛巾和红帽子");
    const first = suggestionFor(baseDoc, "patch-1", "蓝毛巾", "黄毛巾");
    const second = suggestionFor(baseDoc, "patch-2", "红帽子", "绿帽子");

    const result = applySuggestionsToDoc(baseDoc, [first, second], 1);

    expect(result.conflicts).toEqual([]);
    expect(result.steps).toHaveLength(2);
    expect(plainText(result.nextDoc)).toBe("黄毛巾和绿帽子");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { legacySectionsToPm, pmToLegacySections } from "@qingagent/pm-schema";
import type { LegacySection } from "@qingagent/contract-ts";
import {
  applyBeforeAfterPatchToDoc,
  applySuggestionToDoc,
  applySuggestionsToDoc,
  compileSuggestionFromBeforeAfter,
} from "../pmPatch.js";

function p(text: string): LegacySection {
  return { kind: "p", data: { text } };
}

function doc(text: string) {
  return legacySectionsToPm([p(text)]);
}

function plainText(pmDoc: ReturnType<typeof doc>): string {
  const [section] = pmToLegacySections(pmDoc) as LegacySection[];
  if (section?.kind === "p") return section.data.text;
  return "";
}

const originalServerReanchorFlag = process.env.QINGAGENT_SERVER_REANCHOR;

afterEach(() => {
  if (originalServerReanchorFlag === undefined) {
    delete process.env.QINGAGENT_SERVER_REANCHOR;
  } else {
    process.env.QINGAGENT_SERVER_REANCHOR = originalServerReanchorFlag;
  }
});

describe("pmPatch", () => {
  it("compiles a patch intent into one PM suggestion and replace step", () => {
    const result = compileSuggestionFromBeforeAfter({
      doc: doc("他拿着蓝毛巾。"),
      docId: "doc-1",
      baseVersion: 3,
      suggestionId: "patch-1",
      patch: {
        before: "蓝毛巾",
        after: "黄毛巾",
        summary: "换颜色",
        blockIndex: 0,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.suggestion.baseVersion).toBe(3);
    expect(result.record.suggestion.anchor.blockId).toBeTruthy();
    expect(result.record.suggestion.anchor.quote).toBe("蓝毛巾");
    expect(result.record.suggestion.patch.steps).toHaveLength(1);
    expect(result.record.suggestion.patch.steps[0]).toMatchObject({
      stepType: "replace",
      from: expect.any(Number),
      to: expect.any(Number),
    });
  });

  it("rejects duplicated quotes as an explicit ambiguous_match conflict", () => {
    const result = compileSuggestionFromBeforeAfter({
      doc: doc("蓝毛巾旁边还有蓝毛巾。"),
      docId: "doc-1",
      baseVersion: 1,
      suggestionId: "patch-ambiguous",
      patch: {
        before: "蓝毛巾",
        after: "黄毛巾",
        summary: "换颜色",
        blockIndex: 0,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      conflictKind: "ambiguous_match",
    });
  });

  it("re-anchors on current text drift using quote context", () => {
    const compiled = compileSuggestionFromBeforeAfter({
      doc: doc("开头 蓝毛巾 结尾"),
      docId: "doc-1",
      baseVersion: 1,
      suggestionId: "patch-drift",
      patch: {
        before: "蓝毛巾",
        after: "黄毛巾",
        summary: "换颜色",
        blockIndex: 0,
      },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const result = applySuggestionToDoc(
      doc("新的前缀。开头 蓝毛巾 结尾"),
      compiled.record.suggestion,
      2,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(plainText(result.doc)).toBe("新的前缀。开头 黄毛巾 结尾");
    expect(result.step.from).toBeGreaterThan(compiled.record.suggestion.anchor.pmFrom);
  });

  it("surfaces missing targets as conflicts instead of editing the first similar place", () => {
    const compiled = compileSuggestionFromBeforeAfter({
      doc: doc("开头 蓝毛巾 结尾"),
      docId: "doc-1",
      baseVersion: 1,
      suggestionId: "patch-missing",
      patch: {
        before: "蓝毛巾",
        after: "黄毛巾",
        summary: "换颜色",
        blockIndex: 0,
      },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const result = applySuggestionToDoc(
      doc("开头 红围巾 结尾"),
      compiled.record.suggestion,
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

  it("applies accepted suggestions without losing unrelated steps", () => {
    const first = compileSuggestionFromBeforeAfter({
      doc: doc("蓝毛巾和红帽子"),
      docId: "doc-1",
      baseVersion: 1,
      suggestionId: "patch-1",
      patch: { before: "蓝毛巾", after: "黄毛巾", summary: "换毛巾", blockIndex: 0 },
    });
    const second = compileSuggestionFromBeforeAfter({
      doc: doc("蓝毛巾和红帽子"),
      docId: "doc-1",
      baseVersion: 1,
      suggestionId: "patch-2",
      patch: { before: "红帽子", after: "绿帽子", summary: "换帽子", blockIndex: 0 },
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const result = applySuggestionsToDoc(
      doc("蓝毛巾和红帽子"),
      [first.record.suggestion, second.record.suggestion],
      1,
    );

    expect(result.conflicts).toEqual([]);
    expect(result.steps).toHaveLength(2);
    expect(plainText(result.nextDoc)).toBe("黄毛巾和绿帽子");
  });

  it("candidate-diff 草稿:整块 after 为管道表格时产出真实 table", () => {
    const result = applyBeforeAfterPatchToDoc({
      doc: doc("请把这里改成表格"),
      patch: {
        before: "请把这里改成表格",
        after: "| 指标 | 数值 |\n| --- | --- |\n| 转化率 | 12% |",
        summary: "改成表格",
        blockIndex: 0,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.content[0]?.type).toBe("table");
  });

  it("candidate-diff 草稿:多行 blockquote 保留为真实引用块", () => {
    const result = applyBeforeAfterPatchToDoc({
      doc: doc("请改成引用"),
      patch: {
        before: "请改成引用",
        after: "> 第一行\n> 第二行",
        summary: "改成引用",
        blockIndex: 0,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.content[0]?.type).toBe("blockquote");
  });

  it("普通单段 after 仍走内联替换路径", () => {
    const result = applyBeforeAfterPatchToDoc({
      doc: doc("他拿着蓝毛巾。"),
      patch: {
        before: "蓝毛巾",
        after: "黄毛巾",
        summary: "换颜色",
        blockIndex: 0,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.content[0]?.type).toBe("paragraph");
    expect(plainText(result.doc)).toBe("他拿着黄毛巾。");
  });

  it("server-reanchor flag 开:before 微漂移时唯一高置信命中并落草稿", () => {
    process.env.QINGAGENT_SERVER_REANCHOR = "1";

    const result = applyBeforeAfterPatchToDoc({
      doc: doc("他拿着蓝毛巾走到湖边。"),
      patch: {
        before: "他拿着蓝毛巾，走到湖边",
        after: "他拿着黄毛巾走到湖边",
        summary: "换颜色",
        blockIndex: 0,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(plainText(result.doc)).toBe("他拿着黄毛巾走到湖边。");
    expect(result.before).toBe("他拿着蓝毛巾走到湖边");
    expect(result.reanchor).toMatchObject({
      attempted: true,
      applied: true,
      matchCount: 1,
    });
    expect(result.reanchor?.confidence).toBeGreaterThanOrEqual(0.86);
  });

  it("server-reanchor flag 开:多处相似候选时 fail-closed 保持 anchorNotFound", () => {
    process.env.QINGAGENT_SERVER_REANCHOR = "1";

    const result = applyBeforeAfterPatchToDoc({
      doc: doc("他拿着蓝毛巾走到湖边。他拿着蓝毛巾走到河边。"),
      patch: {
        before: "他拿着蓝毛巾走到水边",
        after: "他拿着黄毛巾走到水边",
        summary: "换颜色",
        blockIndex: 0,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      conflictKind: "target_text_changed",
      reanchor: {
        attempted: true,
        applied: false,
        matchCount: 2,
      },
    });
  });

  it("server-reanchor flag 开:无高置信候选时 fail-closed 保持 anchorNotFound", () => {
    process.env.QINGAGENT_SERVER_REANCHOR = "1";

    const result = applyBeforeAfterPatchToDoc({
      doc: doc("湖边有柳树，他拿着蓝毛巾。"),
      patch: {
        before: "合同里写着付款节点和验收标准",
        after: "合同里写着付款计划和验收标准",
        summary: "改合同措辞",
        blockIndex: 0,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      conflictKind: "target_text_changed",
      reanchor: {
        attempted: true,
        applied: false,
        matchCount: 0,
      },
    });
  });

  it("server-reanchor flag 关:before 微漂移仍保持现状不重定位", () => {
    delete process.env.QINGAGENT_SERVER_REANCHOR;

    const result = applyBeforeAfterPatchToDoc({
      doc: doc("他拿着蓝毛巾走到湖边。"),
      patch: {
        before: "他拿着蓝毛巾，走到湖边",
        after: "他拿着黄毛巾走到湖边",
        summary: "换颜色",
        blockIndex: 0,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      conflictKind: "target_text_changed",
    });
    expect(result.reanchor).toBeUndefined();
  });

  it("追问新增表格时保留原段落并插入真实 table 节点", () => {
    const result = applyBeforeAfterPatchToDoc({
      doc: doc("这一段用于定位，请在这里新增内容。"),
      patch: {
        before: "请在这里新增内容",
        after: "请在这里新增内容\n\n| 指标 | 数值 |\n| --- | --- |\n| 转化率 | 12% |",
        summary: "新增表格",
        blockIndex: 0,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.content.map((node) => node.type)).toEqual(["paragraph", "table"]);
    expect(plainText(result.doc)).toBe("这一段用于定位，请在这里新增内容。");
  });

  it("追问新增引用块时插入真实 blockquote 节点", () => {
    const result = applyBeforeAfterPatchToDoc({
      doc: doc("先保留原段落，再追加引用。"),
      patch: {
        before: "追加引用",
        after: "追加引用\n\n> 第一行\n> 第二行",
        summary: "新增引用",
        blockIndex: 0,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.content.map((node) => node.type)).toEqual(["paragraph", "blockquote"]);
    expect(plainText(result.doc)).toBe("先保留原段落，再追加引用。");
  });

  it("老 suggestion 编译路径遇到块级 after 不再静默降级为纯文本", () => {
    const result = compileSuggestionFromBeforeAfter({
      doc: doc("请把这里改成表格"),
      docId: "doc-1",
      baseVersion: 1,
      suggestionId: "patch-table",
      patch: {
        before: "请把这里改成表格",
        after: "| 指标 | 数值 |\n| --- | --- |\n| 转化率 | 12% |",
        summary: "改成表格",
        blockIndex: 0,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: "block-level after needs candidate diff draft mode",
    });
  });
});

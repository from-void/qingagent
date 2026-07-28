import { describe, expect, it } from "vitest";
import type { DocDimensions } from "./docDimensions";
import {
  FIND_MATCH_LIMIT,
  collectReplaceAllPlans,
  collectMatches,
  formatFindCount,
  planReplaceAll,
  resolveFindBarMode,
  shouldInterceptFindShortcut,
  stepCursor,
  type FindMatch,
} from "./docFindModel";

function dim(overrides: Partial<DocDimensions> = {}): DocDimensions {
  return {
    content: { kind: "editing" },
    editor: "editable",
    overlay: null,
    agentBusy: false,
    ...overrides,
  };
}

describe("docFindModel", () => {
  it("在多段 text node 内收集多次命中并保留 PM 绝对位置", () => {
    const result = collectMatches(
      [
        { text: "abc abc", pos: 3 },
        { text: "xxabc", pos: 20 },
      ],
      "abc",
      true,
    );

    expect(result).toEqual({
      matches: [
        { from: 3, to: 6 },
        { from: 7, to: 10 },
        { from: 22, to: 25 },
      ],
      total: 3,
      truncated: false,
    });
  });

  it("跨段只按段内子串计数,不做跨 text node 拼接匹配", () => {
    const result = collectMatches(
      [
        { text: "ab", pos: 1 },
        { text: "c abc", pos: 5 },
      ],
      "abc",
      true,
    );

    expect(result.matches).toEqual([{ from: 7, to: 10 }]);
  });

  it("支持拉丁大小写开关,中文匹配不受影响", () => {
    expect(
      collectMatches([{ text: "Abc abc 中文", pos: 1 }], "abc", false).matches,
    ).toEqual([
      { from: 1, to: 4 },
      { from: 5, to: 8 },
    ]);
    expect(
      collectMatches([{ text: "Abc abc 中文", pos: 1 }], "abc", true).matches,
    ).toEqual([{ from: 5, to: 8 }]);
    expect(
      collectMatches([{ text: "中文 中文", pos: 2 }], "中文", false).matches,
    ).toEqual([
      { from: 2, to: 4 },
      { from: 5, to: 7 },
    ]);
  });

  it("大小写折叠展开字符时仍把命中映射回原文 UTF-16 范围", () => {
    expect(
      collectMatches([{ text: "AİBC", pos: 10 }], "bc", false).matches,
    ).toEqual([{ from: 12, to: 14 }]);
    expect(
      collectMatches([{ text: "İ", pos: 20 }], "i", false).matches,
    ).toEqual([{ from: 20, to: 21 }]);
    expect(
      collectMatches([{ text: "ΟΣ", pos: 30 }], "ος", false).matches,
    ).toEqual([{ from: 30, to: 32 }]);
  });

  it("空 query 返回空结果", () => {
    expect(collectMatches([{ text: "abc", pos: 1 }], "", false)).toEqual({
      matches: [],
      total: 0,
      truncated: false,
    });
  });

  it("超过 limit 时截断 matches 并让徽标显示 limit+", () => {
    const result = collectMatches([{ text: "aaaaa", pos: 1 }], "a", true, 3);

    expect(result.matches).toHaveLength(3);
    expect(result.total).toBe(5);
    expect(result.truncated).toBe(true);
    expect(formatFindCount(1, result.total, result.truncated, 3)).toBe("2/3+");
  });

  it("stepCursor 支持前后回环和空结果", () => {
    expect(stepCursor(-1, 0, 1)).toBe(-1);
    expect(stepCursor(-1, 3, 1)).toBe(0);
    expect(stepCursor(2, 3, 1)).toBe(0);
    expect(stepCursor(-1, 3, -1)).toBe(2);
    expect(stepCursor(0, 3, -1)).toBe(2);
  });

  it("planReplaceAll 按 from 降序生成替换计划", () => {
    const matches: FindMatch[] = [
      { from: 2, to: 4 },
      { from: 10, to: 12 },
      { from: 6, to: 8 },
    ];

    expect(planReplaceAll(matches, "X")).toEqual([
      { from: 10, to: 12, insert: "X" },
      { from: 6, to: 8, insert: "X" },
      { from: 2, to: 4, insert: "X" },
    ]);
  });

  it("全部替换重新收集上限外命中并生成完整倒序计划", () => {
    const segments = [{ text: "a".repeat(FIND_MATCH_LIMIT + 2), pos: 1 }];
    const displayed = collectMatches(segments, "a", true);
    const plans = collectReplaceAllPlans(segments, "a", true, "X");

    expect(displayed.matches).toHaveLength(FIND_MATCH_LIMIT);
    expect(displayed.truncated).toBe(true);
    expect(plans).toHaveLength(FIND_MATCH_LIMIT + 2);
    expect(plans[0]).toEqual({
      from: FIND_MATCH_LIMIT + 2,
      to: FIND_MATCH_LIMIT + 3,
      insert: "X",
    });
    expect(plans.at(-1)).toEqual({ from: 1, to: 2, insert: "X" });
  });

  it("formatFindCount 覆盖空、无当前、普通和截断分支", () => {
    expect(formatFindCount(-1, 0, false)).toBe("0/0");
    expect(formatFindCount(-1, 3, false)).toBe("0/3");
    expect(formatFindCount(0, 3, false)).toBe("1/3");
    expect(formatFindCount(999, 1001, true)).toBe("1000/1000+");
  });

  it("resolveFindBarMode 复用正文状态机判定三种模式", () => {
    expect(resolveFindBarMode(dim(), null, null)).toBe("full");
    expect(resolveFindBarMode(dim({ editor: "locked", agentBusy: true }), null, null)).toBe("find-only");
    expect(resolveFindBarMode(dim({ editor: "locked" }), null, null)).toBe("find-only");
    expect(
      resolveFindBarMode(
        dim({ content: { kind: "pendingReview" }, editor: "pendingReview" }),
        null,
        null,
      ),
    ).toBe("find-only");
    expect(resolveFindBarMode(dim({ content: { kind: "empty" }, editor: "empty" }), null, null)).toBe("find-only");
    expect(resolveFindBarMode(dim(), 1, null)).toBe("find-only");
    expect(resolveFindBarMode(dim(), null, {})).toBe("find-only");
    expect(resolveFindBarMode(dim({ editor: "locked", overlay: "askUser" }), null, null)).toBe("hidden");
  });

  it("shouldInterceptFindShortcut 只拦截非左栏、非 hidden 的 Ctrl/Cmd+F", () => {
    expect(shouldInterceptFindShortcut({ key: "f", ctrlKey: true }, false, "full")).toBe(true);
    expect(shouldInterceptFindShortcut({ key: "F", metaKey: true }, false, "find-only")).toBe(true);
    expect(shouldInterceptFindShortcut({ key: "f", ctrlKey: true, shiftKey: true }, false, "full")).toBe(false);
    expect(shouldInterceptFindShortcut({ key: "f", ctrlKey: true, altKey: true }, false, "full")).toBe(false);
    expect(shouldInterceptFindShortcut({ key: "g", ctrlKey: true }, false, "full")).toBe(false);
    expect(shouldInterceptFindShortcut({ key: "f", ctrlKey: true }, true, "full")).toBe(false);
    expect(shouldInterceptFindShortcut({ key: "f", ctrlKey: true }, false, "hidden")).toBe(false);
    expect(shouldInterceptFindShortcut({ key: "f", ctrlKey: true, defaultPrevented: true }, false, "full")).toBe(false);
  });
});

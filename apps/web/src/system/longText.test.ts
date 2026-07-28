import { describe, expect, it } from "vitest";
import {
  LONGTEXT_CHAR_THRESHOLD,
  countChars,
  longTextPreview,
  shouldCollapsePastedText,
} from "./longText";

describe("长文本 Unicode 字数口径", () => {
  it("按去空白后的字素统计 emoji、扩展汉字和组合字", () => {
    expect(countChars(" 𠮷 👨‍👩‍👧‍👦 e\u0301 ")).toBe(3);
  });

  it("按字素判断折叠阈值，不把代理对重复计数", () => {
    const belowThreshold = "𠮷".repeat(LONGTEXT_CHAR_THRESHOLD - 1);
    expect(shouldCollapsePastedText(belowThreshold)).toBe(false);
    expect(shouldCollapsePastedText(`${belowThreshold}😀`)).toBe(true);
  });

  it("预览截断不拆分扩展汉字或 ZWJ emoji", () => {
    expect(longTextPreview("甲乙𠮷👨‍👩‍👧‍👦丁", 10, 3)).toBe("甲乙𠮷 …");
  });
});

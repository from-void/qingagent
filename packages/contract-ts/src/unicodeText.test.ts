import { describe, expect, it, vi } from "vitest";
import {
  countGraphemes,
  removeUnpairedSurrogates,
  splitGraphemes,
  truncateGraphemes,
} from "./unicodeText";

describe("Unicode 字素工具", () => {
  it("把扩展汉字、组合字和 ZWJ emoji 各计为一个字素", () => {
    const text = "𠮷e\u0301👨‍👩‍👧‍👦👍🏽";
    expect(splitGraphemes(text)).toEqual(["𠮷", "e\u0301", "👨‍👩‍👧‍👦", "👍🏽"]);
    expect(countGraphemes(text)).toBe(4);
    expect(truncateGraphemes(`${text}尾`, 3)).toBe("𠮷e\u0301👨‍👩‍👧‍👦");
  });

  it("清除孤立代理项，避免 URI 编码失败", () => {
    expect(removeUnpairedSurrogates(`前\uD83D中\uDC00后😀`)).toBe("前中后😀");
    expect(() => encodeURIComponent(truncateGraphemes(`前\uD83D后`, 10))).not.toThrow();
  });

  it("Intl.Segmenter 不可用时回退到 code point 安全拆分", () => {
    const originalIntl = globalThis.Intl;
    vi.stubGlobal("Intl", { ...originalIntl, Segmenter: undefined });
    try {
      expect(splitGraphemes("甲𠮷😀乙")).toEqual(["甲", "𠮷", "😀", "乙"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

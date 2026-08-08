import { describe, expect, it } from "vitest";
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

});

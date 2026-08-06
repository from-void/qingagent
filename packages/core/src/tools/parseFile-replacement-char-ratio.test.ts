import { describe, expect, it } from "vitest";
import { replacementCharRatio } from "./replacementCharRatio.js";

function legacyReplacementCharRatio(text: string): number {
  const replacementCount = [...text].filter((char) => char === "\uFFFD").length;
  return replacementCount / Math.max(text.length, 1);
}

describe("replacementCharRatio", () => {
  it.each([
    ["空串", ""],
    ["不含替换符的 ASCII", "plain text"],
    ["不含替换符的中文", "正常中文正文"],
    ["单个替换符", "\uFFFD"],
    ["纯替换符", "\uFFFD\uFFFD\uFFFD\uFFFD"],
    ["混合正文", "前缀\uFFFD中间\uFFFD后缀"],
    ["不含替换符的代理对", "😀🚀"],
    ["代理对与替换符混合", "😀\uFFFD🚀\uFFFD"],
    ["孤高低代理与替换符混合", "\uD83D\uFFFD\uDE00"],
  ])("与旧实现对%s样本的结果逐位相等", (_name, text) => {
    expect(replacementCharRatio(text)).toBe(legacyReplacementCharRatio(text));
  });

  it("含代理对时仍以 UTF-16 code unit 长度作分母", () => {
    expect(replacementCharRatio("😀\uFFFD")).toBe(1 / 3);
  });
});

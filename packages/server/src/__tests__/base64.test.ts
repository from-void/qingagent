import { describe, expect, it } from "vitest";
import { decodeBase64 } from "../lib/base64";

describe("decodeBase64", () => {
  it.each([
    ["", ""],
    ["TQ==", "M"],
    ["TWE=", "Ma"],
    ["TWFu", "Man"],
  ])("解码 canonical base64：%s", (content, expected) => {
    expect(decodeBase64(content)?.toString("utf8")).toBe(expected);
  });

  it.each([
    "AAA",
    "A===",
    "=AAA",
    "AA=A",
    "AA==AAAA",
    "AA A",
    "AA\nA",
    "AB==",
    "AAB=",
  ])("拒绝非法、错位 padding 或非 canonical 输入：%j", (content) => {
    expect(decodeBase64(content)).toBeNull();
  });
});

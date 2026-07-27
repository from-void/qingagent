import { describe, expect, it } from "vitest";
import {
  extractFirstBalancedArray,
  extractJsonArray,
} from "../utils/extractJsonArray.js";

describe("extractJsonArray 首个顶层数组边界", () => {
  it("顶层数组截断时不把完整 options 子数组冒充结果", () => {
    const truncated =
      '[{"id":"q1","label":"选择？","kind":"single","options":[{"value":"a","label":"甲"}]}';

    expect(extractJsonArray(truncated)).toBeNull();
    expect(extractFirstBalancedArray(truncated)).toBeNull();
  });

  it("跳过前导散文方括号，并兼容 fence 与尾随文本", () => {
    const expected = '[{"label":"问题","options":[]}]';
    const raw = `说明[草稿]：\n\`\`\`json\n${expected}\n\`\`\`\n以上是结果。`;

    expect(extractJsonArray(raw)).toBe(expected);
    expect(extractFirstBalancedArray(raw)).toBe(expected);
  });

  it("跳过前导散文后，真正的顶层数组截断仍然失败", () => {
    const raw =
      '说明[草稿]：\n```json\n[{"id":"q1","options":[{"value":"a"}]}\n```\n以上是结果。';

    expect(extractJsonArray(raw)).toBeNull();
    expect(extractFirstBalancedArray(raw)).toBeNull();
  });

  it.each([
    [
      "尾随散文",
      '[{"label":"可含 ] 与 }","options":[]}] 以上是结果。',
      '[{"label":"可含 ] 与 }","options":[]}]',
    ],
    [
      "JSON fence",
      '```json\n[{"label":"含 \\"引号\\"","options":[]}]\n```',
      '[{"label":"含 \\"引号\\"","options":[]}]',
    ],
    [
      "前导说明",
      '结果如下：\n[{"label":"问题","options":[]}]',
      '[{"label":"问题","options":[]}]',
    ],
  ])("%s 中仍提取首个完整数组", (_label, raw, expected) => {
    expect(extractJsonArray(raw)).toBe(expected);
  });
});

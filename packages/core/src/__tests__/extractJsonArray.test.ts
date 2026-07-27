import { describe, expect, it } from "vitest";
import {
  extractFirstBalancedArray,
  extractJsonArray,
} from "../utils/extractJsonArray.js";

describe("extractJsonArray 顶层数组候选边界", () => {
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

  it.each([
    "[true]",
    "[1]",
    '["注"]',
  ])("前导散文小数组 %s 不截胡后随对象数组", (decoy) => {
    const expected = '[{"label":"问题","options":[]}]';
    const raw = `默认值为 ${decoy}，结果：${expected}`;

    expect(extractJsonArray(raw)).toBe(expected);
    expect(extractFirstBalancedArray(raw)).toBe(expected);
  });

  it("前置示例对象数组不截胡后随终答对象数组", () => {
    const example = '[{"label":"示例","options":[]}]';
    const expected = '[{"label":"终答","options":[]}]';

    expect(extractJsonArray(`格式示例：${example}\n最终答案：${expected}`)).toBe(expected);
    expect(extractFirstBalancedArray(`格式示例：${example}\n最终答案：${expected}`)).toBe(expected);
  });

  it("对象数组后的散文小数组不改变对象候选", () => {
    const expected = '[{"label":"终答","options":[]}]';

    expect(extractJsonArray(`${expected}\n补充说明：默认值为 [true]。`)).toBe(expected);
  });

  it("对象数组截断时不退回前导散文小数组", () => {
    const raw =
      '默认值为 [true]。说明[草稿]：\n```json\n[{"id":"q1","options":[{"value":"a"}]}\n```';

    expect(extractJsonArray(raw)).toBeNull();
    expect(extractFirstBalancedArray(raw)).toBeNull();
  });

  it("已平衡对象数组后出现未闭合末尾候选时仍失败", () => {
    const raw =
      '[{"label":"旧答案","options":[]}]\n最终答案：[{"label":"被截断","options":[';

    expect(extractJsonArray(raw)).toBeNull();
    expect(extractFirstBalancedArray(raw)).toBeNull();
  });

  it("组合处理散文方括号、小数组、fence 与尾随文本", () => {
    const expected = '[{"label":"问题","options":[]}]';
    const raw =
      `说明[草稿]，默认值为 [true]。\n\`\`\`json\n${expected}\n\`\`\`\n以上是结果。`;

    expect(extractJsonArray(raw)).toBe(expected);
    expect(extractFirstBalancedArray(raw)).toBe(expected);
  });

  it("多 fence 时只在最后一个 fence 内按嵌套边界取末候选", () => {
    const ignored = '[{"label":"前一 fence","options":[]}]';
    const earlier = '[{"label":"末 fence 示例","options":[]}]';
    const expected =
      '[{"label":"末 fence 终答","options":[{"value":"a","label":"含 ] 字符"}]}]';
    const raw = [
      "```json",
      ignored,
      "```",
      '[{"label":"fence 外","options":[]}]',
      "```json",
      earlier,
      expected,
      "```",
      '[{"label":"末 fence 后","options":[]}]',
    ].join("\n");

    expect(extractJsonArray(raw)).toBe(expected);
  });

  it("最后一个 fence 没有对象数组时不回退到前一 fence", () => {
    const raw = [
      "```json",
      '[{"label":"前一 fence","options":[]}]',
      "```",
      "```json",
      "[true]",
      "```",
    ].join("\n");

    expect(extractJsonArray(raw)).toBeNull();
  });

  it("validate 从后向前选择最后一个通过预校验的候选", () => {
    const expected = '[{"label":"可用","options":[]}]';
    const invalid = '[{"title":"对象数组但不是问卷"}]';
    const validate = (arr: unknown[]) =>
      arr.every((item) =>
        item !== null &&
        typeof item === "object" &&
        "label" in item &&
        typeof item.label === "string"
      );

    expect(extractJsonArray(`${expected}\n${invalid}`, validate)).toBe(expected);
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
  ])("%s 中仍提取最后一个对象数组", (_label, raw, expected) => {
    expect(extractJsonArray(raw)).toBe(expected);
  });
});

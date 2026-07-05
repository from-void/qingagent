import { describe, expect, it } from "vitest";
import { normalizeSliderSpec } from "../tools/askUser.js";

// F4 滑块范围 sanitize:LLM 输出不可信,枚举真实脏形态(AGENTS「脏路径」硬规则)。
describe("normalizeSliderSpec", () => {
  it("正常输入原样通过并补 aboveLabel", () => {
    const spec = normalizeSliderSpec({ min: 200, max: 3000, step: 100, unit: "字" });
    expect(spec).toMatchObject({ min: 200, max: 3000, step: 100, unit: "字" });
    expect(spec!.aboveLabel).toBe("3000字以上");
  });

  it("字数类 min=0 被抬到 50(需求:字数不可为 0)", () => {
    const spec = normalizeSliderSpec({ min: 0, max: 2000, step: 100, unit: "字" });
    expect(spec!.min).toBe(50);
  });

  it("min>=max 返回 null(整题降级)", () => {
    expect(normalizeSliderSpec({ min: 500, max: 500, step: 10 })).toBeNull();
    expect(normalizeSliderSpec({ min: 800, max: 200, step: 10 })).toBeNull();
  });

  it("step 缺失/0/负数/大于跨度/过碎时按跨度自动取齐", () => {
    expect(normalizeSliderSpec({ min: 0, max: 2000 })!.step).toBe(100);
    expect(normalizeSliderSpec({ min: 0, max: 2000, step: 0 })!.step).toBe(100);
    expect(normalizeSliderSpec({ min: 0, max: 2000, step: -5 })!.step).toBe(100);
    expect(normalizeSliderSpec({ min: 0, max: 100, step: 500 })!.step).toBe(5);
    expect(normalizeSliderSpec({ min: 0, max: 2000, step: 0.001 })!.step).toBe(100);
  });

  it("NaN/Infinity/字符串数字按缺失处理", () => {
    expect(normalizeSliderSpec({ min: NaN, max: 100, step: 1 })).toBeNull();
    expect(normalizeSliderSpec({ min: 0, max: Infinity, step: 1 })).toBeNull();
    expect(normalizeSliderSpec({ min: "100", max: 2000, step: 50 })).toBeNull();
  });

  it("负 min 非字数类被钳到 0", () => {
    const spec = normalizeSliderSpec({ min: -10, max: 100, step: 10 });
    expect(spec!.min).toBe(0);
  });

  it("marks 越界值被丢弃,全部越界则为 null", () => {
    const spec = normalizeSliderSpec({ min: 100, max: 1000, step: 100, marks: [50, 500, "700", NaN, 2000] });
    expect(spec!.marks).toEqual([500]);
    const spec2 = normalizeSliderSpec({ min: 100, max: 1000, step: 100, marks: [1, 2] });
    expect(spec2!.marks).toBeNull();
  });

  it("字数类 min 抬高后若不再小于 max 则返回 null", () => {
    expect(normalizeSliderSpec({ min: 0, max: 40, step: 10, unit: "字" })).toBeNull();
  });

  it("非对象/null/数组输入返回 null", () => {
    expect(normalizeSliderSpec(null)).toBeNull();
    expect(normalizeSliderSpec("slider")).toBeNull();
    expect(normalizeSliderSpec(undefined)).toBeNull();
  });

  it("aboveLabel 显式给出时不覆盖", () => {
    const spec = normalizeSliderSpec({ min: 100, max: 5000, step: 100, unit: "字", aboveLabel: "五千字以上" });
    expect(spec!.aboveLabel).toBe("五千字以上");
  });
});

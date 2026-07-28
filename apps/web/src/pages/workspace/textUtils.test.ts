import { describe, expect, it } from "vitest";
import { truncateLabel } from "./textUtils";

describe("truncateLabel", () => {
  it("中间截断时不拆分扩展汉字、肤色修饰或 ZWJ emoji", () => {
    expect(truncateLabel("甲𠮷👨‍👩‍👧‍👦👍🏽乙丙丁戊", 5)).toBe("甲𠮷…丁戊");
  });
});

import { describe, expect, it } from "vitest";
import { buildTemplateSummary } from "./TemplateGroup";

describe("buildTemplateSummary", () => {
  it("按字素为含扩展汉字与 ZWJ emoji 的摘要预留省略号", () => {
    expect(buildTemplateSummary("甲乙𠮷👨‍👩‍👧‍👦丁", "", 4)).toBe("甲乙𠮷…");
    expect(buildTemplateSummary("甲👨‍👩‍👧‍👦乙丙丁", "", 4)).toBe("甲👨‍👩‍👧‍👦乙…");
  });
});

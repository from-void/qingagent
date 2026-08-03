import { describe, expect, it } from "vitest";
import { annotationRemovalToastMessage } from "./annotationMessages";

describe("annotationRemovalToastMessage", () => {
  it("单条批注退场时说明原文被修改且该批注已自动移除", () => {
    expect(annotationRemovalToastMessage(1)).toBe(
      "有 1 条批注的原文已被修改，该批注已自动移除",
    );
  });

  it("多条批注退场时说明数量、原因和处理结果", () => {
    expect(annotationRemovalToastMessage(2)).toBe(
      "有 2 条批注的原文已被修改，已自动移除",
    );
  });
});

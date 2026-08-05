import { describe, expect, it } from "vitest";
import { annotationRemovalToastMessage } from "./annotationMessages";

describe("annotationRemovalToastMessage", () => {
  it("单处锚点失效时说明原文变化且高亮已隐藏", () => {
    expect(annotationRemovalToastMessage(1)).toBe(
      "有 1 处批注原文已变化，失效高亮已隐藏",
    );
  });

  it("多处锚点失效时说明数量、原因和处理结果", () => {
    expect(annotationRemovalToastMessage(2)).toBe(
      "有 2 处批注原文已变化，失效高亮已隐藏",
    );
  });
});

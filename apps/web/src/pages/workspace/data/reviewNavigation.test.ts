import { describe, expect, it } from "vitest";
import { stepReviewTargetId } from "./reviewNavigation";

describe("行级审阅导航", () => {
  it("按 review target 而非 patchId 逐行前进和后退", () => {
    const targets = ["patch-a::row:0", "patch-a::row:1", "patch-a::row:2"];
    expect(stepReviewTargetId(targets, targets[0]!, "next")).toBe(targets[1]);
    expect(stepReviewTargetId(targets, targets[1]!, "next")).toBe(targets[2]);
    expect(stepReviewTargetId(targets, targets[2]!, "previous")).toBe(targets[1]);
  });

  it("空清单返回 null，边界保持循环语义", () => {
    expect(stepReviewTargetId([], null, "next")).toBeNull();
    expect(stepReviewTargetId(["a", "b"], "b", "next")).toBe("a");
    expect(stepReviewTargetId(["a", "b"], "a", "previous")).toBe("b");
  });
});

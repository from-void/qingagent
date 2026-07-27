import { describe, expect, it } from "vitest";
import {
  INLINE_DIFF_MAX_MATRIX_CELLS,
  lcsDiff,
} from "./protocol";

describe("字符级 LCS 性能边界", () => {
  it("25 万 DP 槽在主线程预算内完成", () => {
    const side = Math.floor(Math.sqrt(INLINE_DIFF_MAX_MATRIX_CELLS));
    const before = Array.from({ length: side }, (_, index) => index);
    const after = Array.from({ length: side }, (_, index) =>
      index % 7 === 0 ? -index : index
    );

    const startedAt = performance.now();
    const diff = lcsDiff(before, after, Object.is);
    const elapsedMs = performance.now() - startedAt;

    expect(diff.length).toBeGreaterThanOrEqual(side);
    expect(elapsedMs).toBeLessThan(250);
  });
});

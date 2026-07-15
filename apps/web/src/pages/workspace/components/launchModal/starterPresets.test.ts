import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DERIVATIVE_STARTER_PRESETS,
  REVIEW_STARTER_PRESETS,
  ROLE_REVIEW_UPGRADED_STARTER_PRESETS,
} from "./starterPresets";

describe("起手模板文案锁", () => {
  it("角色三条升级后 custom 起手清空，并锁住其余 12 条审查与 5 条衍生文案", () => {
    const reviewCount = Object.values(REVIEW_STARTER_PRESETS).flat().length;
    const derivativeCount = Object.values(DERIVATIVE_STARTER_PRESETS)
      .flatMap((slots) => Object.values(slots).flat()).length;
    const digest = createHash("sha256")
      .update(JSON.stringify({ review: REVIEW_STARTER_PRESETS, derivative: DERIVATIVE_STARTER_PRESETS }))
      .digest("hex");

    expect(REVIEW_STARTER_PRESETS.custom).toEqual([]);
    expect(REVIEW_STARTER_PRESETS.role).toEqual([]);
    expect(ROLE_REVIEW_UPGRADED_STARTER_PRESETS.map((preset) => preset.name)).toEqual([
      "投资人视角", "竞品视角挑刺", "小白读者视角",
    ]);
    expect({ reviewCount, derivativeCount }).toEqual({ reviewCount: 12, derivativeCount: 5 });
    expect(digest).toBe("e16d0dd904f1c7f595af6aa30951704485ae044ef3b22d986940e4f1e4a6cfa7");
  });
});

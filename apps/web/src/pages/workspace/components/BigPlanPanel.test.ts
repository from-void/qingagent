import { describe, expect, it } from "vitest";
import { getBigPlanAutoScrollTarget } from "./BigPlanPanel";

describe("getBigPlanAutoScrollTarget", () => {
  it("问卷初始流式停顶部,仅问我更多(extraQuestions 增长)才跟随", () => {
    // 回归:初始问卷 spec.questions 从 1 到 5 流式到达时,extraQuestions 全程不变。
    const decisions = [1, 2, 3, 4, 5].map((specQuestionCount) => ({
      specQuestionCount,
      scrollTarget: getBigPlanAutoScrollTarget({
        prevExtraCount: 0,
        nextExtraCount: 0,
        stuck: true,
      }),
    }));
    expect(decisions).toEqual([
      { specQuestionCount: 1, scrollTarget: "none" },
      { specQuestionCount: 2, scrollTarget: "none" },
      { specQuestionCount: 3, scrollTarget: "none" },
      { specQuestionCount: 4, scrollTarget: "none" },
      { specQuestionCount: 5, scrollTarget: "none" },
    ]);
  });

  it("问我更多的问题增长且仍贴底时跟随到底", () => {
    expect(
      getBigPlanAutoScrollTarget({
        prevExtraCount: 0,
        nextExtraCount: 2,
        stuck: true,
      }),
    ).toBe("bottom");
  });

  it("问我更多的问题增长但用户已上滚时不跟随", () => {
    expect(
      getBigPlanAutoScrollTarget({
        prevExtraCount: 0,
        nextExtraCount: 2,
        stuck: false,
      }),
    ).toBe("none");
  });

  it("extraQuestions 不变时不滚动", () => {
    expect(
      getBigPlanAutoScrollTarget({
        prevExtraCount: 2,
        nextExtraCount: 2,
        stuck: true,
      }),
    ).toBe("none");
  });
});

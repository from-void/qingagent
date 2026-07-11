import { describe, expect, it } from "vitest";
import { askUserTriggerFixtures } from "../evals/askUserTriggerFixtures.js";
import { evaluateAskUserTriggerDecision } from "../evals/askUserTriggerScorers.js";

describe("planDraft trigger fixtures", () => {
  it("保持 45 条、18 应问、5 直写和九类覆盖", () => {
    expect(askUserTriggerFixtures).toHaveLength(45);
    expect(askUserTriggerFixtures.filter((fixture) => fixture.expectedDecision === "ask"))
      .toHaveLength(18);
    expect(askUserTriggerFixtures.filter((fixture) => fixture.requireWriteDraft === true))
      .toHaveLength(5);
    expect(new Set(askUserTriggerFixtures.map((fixture) => fixture.category)).size).toBe(9);
  });

  it("只把 planDraft 族当作写作方向问卷，askUserQuestion 不冒充", () => {
    const fixture = askUserTriggerFixtures.find((item) => item.expectedDecision === "ask")!;

    expect(evaluateAskUserTriggerDecision(fixture, {
      toolNames: ["planDraft"],
      text: "",
    }).score).toBe(1);
    expect(evaluateAskUserTriggerDecision(fixture, {
      toolNames: ["askUserQuestion"],
      text: "",
    }).score).toBe(0);
  });

  it("legacy askUser 仍按老会话方向问卷计分", () => {
    const fixture = askUserTriggerFixtures.find((item) => item.expectedDecision === "ask")!;

    expect(evaluateAskUserTriggerDecision(fixture, {
      toolNames: ["askUser"],
      text: "",
    }).score).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import type { ReviewOutcome, ReviewOutcomeHunk } from "@qingagent/contract-ts";
import { serializeReviewOutcome } from "../bridge/reviewOutcome";

function hunk(over: Partial<ReviewOutcomeHunk> = {}): ReviewOutcomeHunk {
  return {
    verdict: "rejected",
    blockSummary: "改写开篇",
    beforeText: "原句",
    afterText: "新句",
    ...over,
  };
}

function outcome(over: Partial<ReviewOutcome> = {}): ReviewOutcome {
  return { acceptedCount: 0, rejectedCount: 0, hunks: [], ...over };
}

describe("serializeReviewOutcome", () => {
  it("局部采纳:同时列出采纳与拒绝两组,并提示不要擅自重applied", () => {
    const text = serializeReviewOutcome(
      outcome({
        acceptedCount: 1,
        rejectedCount: 1,
        hunks: [
          hunk({ verdict: "accepted", blockSummary: "导语凝练", beforeText: "A", afterText: "B" }),
          hunk({ verdict: "rejected", blockSummary: "改成散文", beforeText: "C", afterText: "D" }),
        ],
      }),
    );
    expect(text).toContain("采纳了 1 处");
    expect(text).toContain("拒绝了 1 处");
    expect(text).toContain("【我采纳的修改】");
    expect(text).toContain("【我拒绝的修改（你需要重新考虑这些）】");
    expect(text).toContain("导语凝练");
    expect(text).toContain("改成散文");
    expect(text).toContain("不要擅自重新应用");
  });

  it("全部拒绝:用'全部'措辞且不出现采纳组", () => {
    const text = serializeReviewOutcome(
      outcome({
        acceptedCount: 0,
        rejectedCount: 2,
        hunks: [hunk(), hunk({ blockSummary: "第二处" })],
      }),
    );
    expect(text).toContain("拒绝了你这一轮的全部 2 处修改");
    expect(text).not.toContain("【我采纳的修改】");
  });

  it("少量拒绝(<=3):引导优先用 askUser(quickClarification) 浮层反问、别弹整页大问卷", () => {
    const text = serializeReviewOutcome(
      outcome({ acceptedCount: 0, rejectedCount: 1, hunks: [hunk()] }),
    );
    expect(text).toContain("askUser");
    expect(text).toContain("quickClarification");
    expect(text).toContain("浮层");
    expect(text).toContain("整页大问卷");
    expect(text).toMatch(/哪里不满意|想往哪个方向改/);
  });

  it("大量拒绝(>3):引导挑重点、别逐条追问也别弄成整页大问卷", () => {
    const text = serializeReviewOutcome(
      outcome({
        acceptedCount: 0,
        rejectedCount: 5,
        hunks: Array.from({ length: 5 }, (_, i) => hunk({ blockSummary: `第${i}处` })),
      }),
    );
    expect(text).toContain("被拒的地方较多");
    expect(text).toContain("别逐条追问");
    expect(text).toContain("整页大问卷");
  });

  it("超长正文被截断且标注原长度", () => {
    const long = "字".repeat(3000);
    const text = serializeReviewOutcome(
      outcome({ acceptedCount: 0, rejectedCount: 1, hunks: [hunk({ beforeText: long })] }),
    );
    expect(text).toContain("…（已截断，共3000字）");
    expect(text.length).toBeLessThan(3000 + 600);
  });

  it("空 before/after 用占位,不抛错", () => {
    const text = serializeReviewOutcome(
      outcome({
        acceptedCount: 0,
        rejectedCount: 1,
        hunks: [hunk({ beforeText: "", afterText: "", blockSummary: "" })],
      }),
    );
    expect(text).toContain("（空）");
    expect(text).toContain("（未命名片段）");
  });

  it("hunks 非数组(脏数据)时降级为空,不抛错", () => {
    const text = serializeReviewOutcome({
      acceptedCount: 0,
      rejectedCount: 0,
      hunks: undefined as unknown as ReviewOutcomeHunk[],
    });
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });
});

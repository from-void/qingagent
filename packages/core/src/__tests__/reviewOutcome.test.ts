import { describe, expect, it } from "vitest";
import type { ReviewOutcome, ReviewOutcomeHunk } from "@qingagent/contract-ts";
import { serializeReviewOutcome } from "../doc-engine/reviewOutcome";

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
  it("局部采纳:同时列出采纳与拒绝两组,并提示被拒是模型改写且不要擅自重新应用", () => {
    const text = serializeReviewOutcome(
      outcome({
        acceptedCount: 3,
        rejectedCount: 2,
        hunks: [
          hunk({ verdict: "accepted", blockSummary: "导语凝练", beforeText: "A", afterText: "B" }),
          hunk({ verdict: "accepted", blockSummary: "补充论据", beforeText: "A2", afterText: "B2" }),
          hunk({ verdict: "accepted", blockSummary: "收束段落", beforeText: "A3", afterText: "B3" }),
          hunk({ verdict: "rejected", blockSummary: "改成散文", beforeText: "C", afterText: "D" }),
          hunk({
            verdict: "rejected",
            blockSummary: "结语改名",
            beforeText: "结语",
            afterText: "写在最后",
          }),
        ],
      }),
    );
    expect(text).toContain("采纳了 3 处");
    expect(text).toContain("拒绝了 2 处");
    expect(text).toContain("【我采纳的修改】");
    expect(text).toContain("【我拒绝的修改（这是你刚才提出、但我没有接受的改动，已还原）】");
    expect(text).toContain("导语凝练");
    expect(text).toContain("改成散文");
    expect(text).toContain("你提出但我拒绝的改写：写在最后");
    expect(text).toContain("不是我想要的改法");
    expect(text).toContain("为什么不想应用这些改动");
    expect(text).toContain("更希望往什么方向处理");
    expect(text).toContain("不要擅自重新应用");
    expect(text).not.toContain("你为什么想要将");
    expect(text).not.toContain("你为什么想改成");
    expect(text).not.toContain("主要目的是什么");
    expect(text).not.toContain("优先调用 askUserQuestion");
    expect(text).not.toMatch(/必须.*askUserQuestion/);
  });

  it("全部拒绝:用'全部'措辞且不出现采纳组,澄清也只问拒绝原因", () => {
    const text = serializeReviewOutcome(
      outcome({
        acceptedCount: 0,
        rejectedCount: 2,
        hunks: [hunk(), hunk({ blockSummary: "第二处" })],
      }),
    );
    expect(text).toContain("拒绝了你这一轮的全部 2 处修改");
    expect(text).not.toContain("【我采纳的修改】");
    expect(text).toContain("这是你刚才提出、但我没有接受的改动");
    expect(text).toContain("不想应用这些改动的原因");
    expect(text).toContain("更希望的方向");
    expect(text).not.toContain("想改成这个改写");
    expect(text).not.toContain("主要目的是什么");
  });

  it("全部采纳:不注入被拒修改语义或 askUserQuestion 引导", () => {
    const text = serializeReviewOutcome(
      outcome({
        acceptedCount: 2,
        rejectedCount: 0,
        hunks: [
          hunk({ verdict: "accepted", blockSummary: "导语凝练", beforeText: "A", afterText: "B" }),
          hunk({ verdict: "accepted", blockSummary: "标题优化", beforeText: "C", afterText: "D" }),
        ],
      }),
    );

    expect(text).toContain("采纳了 2 处修改、拒绝了 0 处修改");
    expect(text).toContain("【我采纳的修改】");
    expect(text).not.toContain("【我拒绝的修改");
    expect(text).not.toContain("不是我想要的改法");
    expect(text).not.toContain("为什么不想应用这些改动");
    expect(text).not.toContain("askUserQuestion");
    expect(text).toContain("我整体接受了");
  });

  it("少量拒绝(<=3):askUserQuestion 只是可选澄清,不强制出问卷", () => {
    const text = serializeReviewOutcome(
      outcome({ acceptedCount: 0, rejectedCount: 1, hunks: [hunk()] }),
    );
    expect(text).toContain("askUserQuestion");
    expect(text).not.toContain("quickClarification");
    expect(text).toContain("浮层");
    expect(text).toContain("planDraft 整页问卷");
    expect(text).toContain("自行判断是否需要继续澄清");
    expect(text).toContain("如果拒绝原因不言自明，简短确认/接受反馈即可");
    expect(text).toContain("可选择调用 askUserQuestion");
    expect(text).toMatch(/哪里不满意|更希望的方向/);
    expect(text).not.toContain("优先调用 askUserQuestion");
    expect(text).not.toMatch(/必须.*问卷/);
  });

  it("大量拒绝(>3):引导挑重点,但仍不强制追问或问卷", () => {
    const text = serializeReviewOutcome(
      outcome({
        acceptedCount: 0,
        rejectedCount: 5,
        hunks: Array.from({ length: 5 }, (_, i) => hunk({ blockSummary: `第${i}处` })),
      }),
    );
    expect(text).toContain("被拒的地方较多");
    expect(text).toContain("别逐条追问");
    expect(text).toContain("planDraft 整页问卷");
    expect(text).toContain("先自行归纳反馈");
    expect(text).toContain("可用 askUserQuestion");
    expect(text).toContain("若拒绝意图已经清楚，直接接受反馈即可");
    expect(text).not.toContain("优先调用 askUserQuestion");
    expect(text).not.toMatch(/必须.*问卷/);
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

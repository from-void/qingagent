import { beforeEach, describe, expect, it, vi } from "vitest";

const generateQuestionsMock = vi.hoisted(() => vi.fn());

vi.mock("../services/genService.js", () => ({
  generateQuestions: generateQuestionsMock,
}));

const { planDraftTool } = await import("../tools/planDraft.js");

const input = {
  id: "direction-gathering",
  rationale: "需要确认写作方向",
  topic: "写一篇项目总结",
};

describe("planDraftTool 失败输出", () => {
  beforeEach(() => {
    generateQuestionsMock.mockReset();
  });

  it("运行环境不支持 suspend 时返回 schema 内 rejected 结果", async () => {
    const result = await planDraftTool.execute!(input, {} as never);

    expect(result).toEqual({
      rejected: true,
      reason: "当前运行环境无法展示写作方向问卷",
      retryInstruction: "请稍后重新调用 planDraft；若仍失败，基于已有上下文继续写作。",
    });
    expect(result).not.toHaveProperty("error");
  });

  it("出题链路异常时返回中性 rejected 结果且不暴露原始错误", async () => {
    generateQuestionsMock.mockRejectedValueOnce(
      new Error("upstream provider internal details"),
    );
    const suspend = vi.fn();

    const result = await planDraftTool.execute!(input, {
      agent: { suspend },
    } as never);

    expect(result).toEqual({
      rejected: true,
      reason: "写作方向问卷生成失败",
      retryInstruction: "请稍后重新调用 planDraft；若仍失败，基于已有上下文继续写作。",
    });
    expect(JSON.stringify(result)).not.toContain("upstream");
    expect(suspend).not.toHaveBeenCalled();
  });
});

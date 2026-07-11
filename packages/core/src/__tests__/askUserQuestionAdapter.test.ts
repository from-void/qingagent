import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, it, vi } from "vitest";

const observabilityMocks = vi.hoisted(() => ({
  end: vi.fn(),
  startSpan: vi.fn(),
}));

vi.mock("../mastra.js", () => ({
  getObservability: () => ({
    getDefaultInstance: () => ({
      startSpan: observabilityMocks.startSpan.mockReturnValue({ end: observabilityMocks.end }),
    }),
  }),
}));
import {
  adaptAskUserQuestionInput,
  askUserQuestionInputSchema,
  buildQuestionnaireRejectedResult,
} from "../tools/askUserQuestionAdapter.js";
import { askUserQuestionTool } from "../tools/askUserQuestion.js";

function option(label: string, extra: Record<string, unknown> = {}) {
  return { label, ...extra };
}

describe("adaptAskUserQuestionInput", () => {
  it("映射 question/multiSelect、补 value/placeholder 并重排题号", () => {
    const adapted = adaptAskUserQuestionInput({
      id: "direct-1",
      rationale: "确认偏好",
      questions: [
        {
          id: "重复 id",
          question: " 你偏好的语气？ ",
          header: " 语气 ",
          multiSelect: true,
          options: [option("正式"), option("轻松", { value: "casual" })],
        },
      ],
    });

    expect(adapted.questions).toEqual([
      {
        id: "q1",
        header: "语气",
        label: "你偏好的语气？",
        kind: { kind: "multi" },
        options: [
          { value: "正式", label: "正式", description: null, preview: null },
          { value: "casual", label: "轻松", description: null, preview: null },
        ],
        placeholder: null,
      },
    ]);
  });

  it("支持 questions JSON 字符串", () => {
    const questions = JSON.stringify([
      { question: "选一个", header: "偏好", options: [option("甲"), option("乙")] },
    ]);
    expect(adaptAskUserQuestionInput({ id: "json", rationale: "r", questions }).questions)
      .toHaveLength(1);
  });

  it("用项目真实 repairModelJson 打捞 BOM、值内裸引号和数组缺逗号", () => {
    const dirty = `\uFEFF[{"question":"偏好"正式"还是轻松","options":[{"label":"正式"},{"label":"轻松"}]} {"question":"篇幅","options":[{"label":"短"},{"label":"长"}]}]`;
    const adapted = adaptAskUserQuestionInput({ id: "dirty", rationale: "r", questions: dirty });
    expect(adapted.questions.map((question) => question.label)).toEqual([
      '偏好"正式"还是轻松',
      "篇幅",
    ]);
  });

  it("先清洗坏题再截断为 4 题，每题截断为 4 个有效选项", () => {
    const invalid = Array.from({ length: 5 }, (_, index) => ({
      question: `坏题 ${index}`,
      options: [option("仅一个")],
    }));
    const valid = Array.from({ length: 5 }, (_, index) => ({
      question: `好题 ${index + 1}`,
      options: [option(""), ...Array.from({ length: 5 }, (__, optIndex) => option(`选项 ${optIndex + 1}`))],
    }));
    const adapted = adaptAskUserQuestionInput({
      id: "limits",
      rationale: "r",
      questions: [...invalid, ...valid],
    });

    expect(adapted.questions.map((question) => question.label)).toEqual([
      "好题 1",
      "好题 2",
      "好题 3",
      "好题 4",
    ]);
    expect(adapted.questions.every((question) => question.options.length === 4)).toBe(true);
    expect(adapted.questions.map((question) => question.id)).toEqual(["q1", "q2", "q3", "q4"]);
  });

  it("header 按 code point 截到 12，preview 截到 800 后加省略号", () => {
    const preview = "🙂".repeat(801);
    const [question] = adaptAskUserQuestionInput({
      id: "unicode",
      rationale: "r",
      questions: [{
        question: "选择",
        header: "🙂".repeat(13),
        options: [option("甲", { preview }), option("乙")],
      }],
    }).questions;
    expect(Array.from(question!.header!)).toHaveLength(12);
    expect(Array.from(question!.options[0]!.preview!)).toHaveLength(801);
    expect(question!.options[0]!.preview!.endsWith("…")).toBe(true);
  });

  it.each([
    '```json\n[{"question":"选一个","options":[{"label":"甲"},{"label":"乙"}]}]\n```',
    '下面是问题：[{"question":"选一个","options":[{"label":"甲"},{"label":"乙"}]}]',
    "not json",
  ])("不支持 fence/前导散文等范围外形态并按 0 题处理", (questions) => {
    expect(adaptAskUserQuestionInput({ id: "bad", rationale: "r", questions }).questions)
      .toEqual([]);
  });

  it("宽松 schema 接受数组或字符串，rejected 输出带重试指令", () => {
    expect(askUserQuestionInputSchema.safeParse({ id: "x", rationale: "r", questions: [] }).success)
      .toBe(true);
    expect(askUserQuestionInputSchema.safeParse({ id: "x", rationale: "r", questions: "[]" }).success)
      .toBe(true);
    expect(buildQuestionnaireRejectedResult()).toEqual({
      rejected: true,
      reason: "没有可展示的有效问题",
      retryInstruction: "请重新调用并提供 1 至 4 道题，每题至少包含 2 个非空选项。",
    });
  });
});

describe("askUserQuestionTool", () => {
  it("0 题直接返回 rejected，不调用 suspend", async () => {
    const suspend = async () => { throw new Error("不应 suspend"); };
    const result = await askUserQuestionTool.execute!(
      { id: "empty", rationale: "r", questions: [] },
      { agent: { suspend } } as never,
    );
    expect(result).toMatchObject({ rejected: true });
  });

  it("合法题以无 purpose 的标准 payload 挂起", async () => {
    let payload: unknown;
    const result = await askUserQuestionTool.execute!(
      {
        id: "direct",
        rationale: "确认偏好",
        questions: [{ question: "选一个", header: "偏好", options: [option("甲"), option("乙")] }],
      },
      {
        agent: {
          suspend: async (value: unknown) => {
            payload = value;
            return { q1: { chosen: ["甲"], freeText: null } } as never;
          },
        },
      } as never,
    );
    expect(result).toEqual({ q1: { chosen: ["甲"], freeText: null } });
    expect(payload).toEqual({
      id: "direct",
      source: null,
      rationale: "确认偏好",
      questions: [{
        id: "q1",
        header: "偏好",
        label: "选一个",
        kind: "single",
        options: [
          { value: "甲", label: "甲", description: null, preview: null },
          { value: "乙", label: "乙", description: null, preview: null },
        ],
        placeholder: null,
      }],
    });
  });

  it("JSON 打捞失败返回可重试 rejected error，不调用 suspend", async () => {
    const suspend = vi.fn();
    const result = await askUserQuestionTool.execute!(
      { id: "broken", rationale: "确认分叉", questions: "not json" },
      { agent: { suspend } } as never,
    );

    expect(result).toEqual(buildQuestionnaireRejectedResult());
    expect(suspend).not.toHaveBeenCalled();
  });

  it("不受 planDraft 已完成闸抑制，并记录 direct span 与清洗差值", async () => {
    observabilityMocks.startSpan.mockClear();
    observabilityMocks.end.mockClear();
    const suspend = vi.fn(async () => ({ q1: { chosen: ["甲"], freeText: null } }));
    const requestContext = new RequestContext([
      ["sessionId", "session-direct-1"],
      ["clientTraceId", "client-1"],
      ["streamId", "stream-1"],
      ["runId", "run-1"],
      ["origin", "web"],
      ["askUserAlreadyCompleted", true],
    ]);

    await askUserQuestionTool.execute!(
      {
        id: "exempt",
        rationale: "确认分叉",
        questions: [
          { question: "坏题", options: [option("唯一选项")] },
          { question: "选一个", options: [option("甲"), option("乙")] },
        ],
      },
      { agent: { suspend }, requestContext } as never,
    );

    expect(suspend).toHaveBeenCalledOnce();
    expect(observabilityMocks.startSpan).toHaveBeenCalledWith(expect.objectContaining({
      name: "askuserquestion_direct",
      metadata: {
        eventKind: "askuserquestion_direct",
        sessionId: "session-direct-1",
        clientTraceId: "client-1",
        streamId: "stream-1",
        runId: "run-1",
        origin: "web",
        inputQuestionCount: 2,
        survivingQuestionCount: 1,
        salvagedCount: 1,
      },
    }));
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";

const mocks = vi.hoisted(() => ({
  branchCall: vi.fn(),
  getSessionSnapshot: vi.fn(),
  getDeepseekModel: vi.fn(() => ({ modelId: "fallback" })),
  resolveModelParams: vi.fn(() => ({})),
  streamText: vi.fn(),
}));

vi.mock("../llm/modelConfig.js", () => ({
  branchCall: mocks.branchCall,
  getSessionSnapshot: mocks.getSessionSnapshot,
  getDeepseekModel: mocks.getDeepseekModel,
  resolveModelParams: mocks.resolveModelParams,
}));
vi.mock("ai", () => ({ streamText: mocks.streamText }));

import {
  clearQuestionBranch,
  generateQuestions,
  parseGeneratedQuestions,
  parsePartialGeneratedQuestions,
} from "../services/genService.js";

const snapshot = {
  sessionId: "gen-session",
  streamId: "stream-main",
  generation: 3,
  leaseId: "lease-gen-service",
  ordinal: 2,
  epoch: 0,
  capturedAt: "2026-07-11T00:00:00.000Z",
  endpoint: "https://example.test/chat/completions",
  bodyText: "{}",
  safeHeaders: {},
  authFingerprint: "test",
};

function textStream(text: string): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      yield text;
    },
  };
}

function chunkStream(chunks: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

describe("GenService", () => {
  beforeEach(() => {
    clearQuestionBranch(snapshot.sessionId);
    mocks.branchCall.mockReset();
    mocks.getSessionSnapshot.mockReset().mockReturnValue(snapshot);
    mocks.streamText.mockReset();
  });

  it("askMore 在同一快照上只 append 初次 user/assistant 与新增 user，不重构前缀", async () => {
    mocks.branchCall
      .mockResolvedValueOnce({
        ok: true,
        text: '[{"id":"q-tone","label":"语气？","kind":"single","options":[{"value":"warm","label":"温暖"}]}]',
        assistantMessage: {
          role: "assistant",
          content: '[{"id":"q-tone","label":"语气？","kind":"single","options":[{"value":"warm","label":"温暖"}]}]',
        },
        attempts: 1,
        toolCallRetries: 0,
      })
      .mockResolvedValueOnce({
        ok: true,
        text: '[{"id":"q-extra-scene","label":"使用场景？","kind":"text","options":[]}]',
        assistantMessage: {
          role: "assistant",
          content: '[{"id":"q-extra-scene","label":"使用场景？","kind":"text","options":[]}]',
        },
        attempts: 1,
        toolCallRetries: 0,
      });

    const first = await generateQuestions({
      mode: "initial",
      rationale: "确认方向",
      topic: "手表市场",
    });
    const additional = await generateQuestions({
      mode: "additional",
      currentQuestions: first.questions.map((question) => ({
        ...question,
        kind: { kind: question.kind },
      })),
      currentAnswers: { "q-tone": { chosen: ["warm"] } },
    });

    expect(first.transport).toBe("branch");
    expect(additional.transport).toBe("branch");
    const firstTail = mocks.branchCall.mock.calls[0]?.[0].steeringTail;
    const secondTail = mocks.branchCall.mock.calls[1]?.[0].steeringTail;
    expect(firstTail).toHaveLength(1);
    expect(secondTail).toHaveLength(3);
    expect(secondTail[0]).toEqual(firstTail[0]);
    expect(secondTail[1]).toEqual(expect.objectContaining({ role: "assistant" }));
    expect(secondTail[2]).toEqual(expect.objectContaining({
      role: "user",
      content: expect.stringContaining("再生成 1-3 个补充问题"),
    }));
    expect(mocks.branchCall.mock.calls.map((call) => call[0].callSite)).toEqual(["planDraft", "askMore"]);
  });

  it("tool_call 单次失败后立即降级原独立模型路径", async () => {
    mocks.branchCall.mockResolvedValue({
      ok: false,
      reason: "tool_call",
      attempts: 1,
      toolCallRetries: 0,
    });
    mocks.streamText.mockReturnValue({
      textStream: textStream('[{"id":"q-note","label":"还有什么要求？","kind":"text","options":[]}]'),
    });

    const result = await generateQuestions({ mode: "initial", rationale: "r", topic: "t" });

    expect(result).toMatchObject({
      transport: "fallback",
      branchFailure: "tool_call",
      toolCallRetries: 0,
    });
    expect(result.questions).toHaveLength(1);
    expect(mocks.streamText).toHaveBeenCalledTimes(1);
    expect(mocks.branchCall).toHaveBeenCalledTimes(1);
  });

  it("真实脏输出支持 fence、尾随散文与 nested kind", () => {
    expect(parseGeneratedQuestions(`前导话\n\`\`\`json
[{"id":"q-extra-note","label":"补充？","kind":{"kind":"text"},"options":[],"placeholder":"可含 ] 字符"}]
\`\`\`\n以上。`)).toEqual([expect.objectContaining({
      id: "q-extra-note",
      kind: "text",
      placeholder: "可含 ] 字符",
    })]);
  });

  it("前导散文小数组不阻断后随问卷负载", () => {
    expect(parseGeneratedQuestions(
      '默认值为 [true]，正式结果：[{"label":"补充？","kind":"text","options":[]}]',
    )).toEqual([
      expect.objectContaining({ id: "q1", label: "补充？", kind: "text" }),
    ]);
  });

  it("用问卷 schema 预校验并选择最后一个通过的对象数组", () => {
    const example =
      '[{"label":"前置示例？","kind":"text","options":[]}]';
    const invalid = '[{"title":"后置说明对象"}]';

    expect(parseGeneratedQuestions(`${example}\n${invalid}`)).toEqual([
      expect.objectContaining({ id: "q1", label: "前置示例？", kind: "text" }),
    ]);
  });

  it("前置示例和终答均通过问卷校验时选择终答", () => {
    const example =
      '[{"label":"前置示例？","kind":"text","options":[]}]';
    const expected =
      '[{"label":"最终问题？","kind":"single","options":[{"value":"a","label":"甲"}]}]';

    expect(parseGeneratedQuestions(`${example}\n最终答案：${expected}`)).toEqual([
      expect.objectContaining({ id: "q1", label: "最终问题？", kind: "single" }),
    ]);
  });

  it("顶层问卷数组截断时不把 options 子数组正规化成问题", () => {
    expect(parseGeneratedQuestions(
      '[{"id":"q1","label":"选择？","kind":"single","options":[{"value":"a","label":"甲"}]}',
    )).toBeNull();
  });

  it("缺 id/kind 的真实脏问题可按序补齐，不让终态问卷清空", () => {
    expect(parseGeneratedQuestions(`[
      {"label":"偏向哪种语气？","options":[{"value":"warm","label":"温暖"}]},
      {"label":"还有什么补充？","options":[]}
    ]`)).toEqual([
      expect.objectContaining({ id: "q1", kind: "single" }),
      expect.objectContaining({ id: "q2", kind: "text" }),
    ]);
  });

  it("完整与流式解析对重复及补位冲突 id 使用同一稳定后缀", () => {
    const raw = `[
      {"id":"q2","label":"第一题？","kind":"text","options":[]},
      {"label":"第二题？","kind":"text","options":[]},
      {"id":"q2","label":"第三题？","kind":"text","options":[]}
    ]`;

    expect(parseGeneratedQuestions(raw)?.map((question) => question.id)).toEqual([
      "q2",
      "q2-2",
      "q2-3",
    ]);
    expect(parsePartialGeneratedQuestions(raw).map((question) => question.id)).toEqual([
      "q2",
      "q2-2",
      "q2-3",
    ]);
  });

  it("fallback 最终 JSON 截断时保留已流出的完整问题", async () => {
    mocks.getSessionSnapshot.mockReturnValue(null);
    mocks.streamText.mockReturnValue({
      textStream: textStream('[{"label":"已完成问题","options":[]},{"label":"半截"'),
    });

    const result = await generateQuestions({ mode: "initial", rationale: "r", topic: "t" });

    expect(result.questions).toEqual([
      expect.objectContaining({ id: "q1", label: "已完成问题", kind: "text" }),
    ]);
    expect(mocks.streamText).toHaveBeenCalledTimes(2);
  });

  it("fallback 恢复按完整问题递增的进度，并保留原 prompt 语义约束", async () => {
    mocks.getSessionSnapshot.mockReturnValue(null);
    mocks.streamText.mockReturnValue({
      textStream: chunkStream([
        '[{"id":"q-one","label":"侧重点？","kind":"single","options":[{"value":"a","label":"A"}]}',
        ',{"id":"q-two","label":"补充？","kind":"text","options":[]}]',
      ]),
    });
    const progress: number[] = [];

    const result = await generateQuestions({
      mode: "initial",
      rationale: "r",
      topic: "t",
      requestContext: new RequestContext([
        ["messages", [{ role: "user", content: "已说明给企业管理层阅读" }]],
      ] as never) as RequestContext,
      onProgress: (questions) => { progress.push(questions.length); },
    });

    expect(result.questions).toHaveLength(2);
    expect(progress).toEqual([1, 2]);
    const prompt = mocks.streamText.mock.calls[0]?.[0].prompt as string;
    expect(prompt).toContain("最大值滑到头必须用 aboveLabel");
    expect(prompt).toContain("不得出现 run_js、readDraft");
    expect(prompt).toContain("根据下面的主对话摘要和写作方向");
    expect(prompt).toContain("已说明给企业管理层阅读");
  });

  it("branch 按题干、逐选项、题完成及下一题顺序发帧，首题和编号不丢", async () => {
    const chunks = [
      '[{"label":"第一题？","kind":"single",',
      '"options":[{"value":"a","label":"甲"}',
      ',{"value":"b","label":"乙"}]',
      ',"placeholder":"请选择"}',
      ',{"label":"第二题？","kind":"text","options":[]',
      ',"placeholder":"请补充"}]',
    ];
    mocks.branchCall.mockImplementation(async (input) => {
      let accumulated = "";
      for (const chunk of chunks) {
        accumulated += chunk;
        await input.onTextDelta?.(chunk, accumulated);
      }
      return {
        ok: true,
        text: accumulated,
        assistantMessage: { role: "assistant", content: accumulated },
        attempts: 1,
        toolCallRetries: 0,
      };
    });
    const frames: Array<Array<{ id: string; options: number; placeholder?: string | null }>> = [];

    const result = await generateQuestions({
      mode: "initial",
      rationale: "r",
      topic: "t",
      onProgress: (questions) => {
        frames.push(questions.map((question) => ({
          id: question.id,
          options: question.options.length,
          placeholder: question.placeholder,
        })));
      },
    });

    expect(frames).toEqual([
      [{ id: "q1", options: 0, placeholder: "" }],
      [{ id: "q1", options: 1, placeholder: "" }],
      [{ id: "q1", options: 2, placeholder: "" }],
      [{ id: "q1", options: 2, placeholder: "请选择" }],
      [
        { id: "q1", options: 2, placeholder: "请选择" },
        { id: "q2", options: 0, placeholder: "" },
      ],
      [
        { id: "q1", options: 2, placeholder: "请选择" },
        { id: "q2", options: 0, placeholder: "请补充" },
      ],
    ]);
    expect(result.questions.map((question) => question.id)).toEqual(["q1", "q2"]);
  });

  it("畸形或截断的后续 JSON 不吞首题、题干和已完成选项", () => {
    const partial = parsePartialGeneratedQuestions(
      '[{"label":"第一题？","kind":"single","options":[{"value":"a","label":"含 } 和 \\\" 引号"}]},' +
      '{"label":"第二题？","kind":"multi","options":[{"value":"b","label":"已完成"},{"value":"c","label":"截断',
    );

    expect(partial).toEqual([
      expect.objectContaining({ id: "q1", label: "第一题？", options: [expect.objectContaining({ value: "a" })] }),
      expect.objectContaining({ id: "q2", label: "第二题？", options: [expect.objectContaining({ value: "b" })] }),
    ]);
  });

  it("预取消时不发 branch 或 fallback 请求", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(generateQuestions({
      mode: "initial",
      rationale: "r",
      topic: "t",
      abortSignal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.branchCall).not.toHaveBeenCalled();
    expect(mocks.streamText).not.toHaveBeenCalled();
  });
});

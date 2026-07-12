import type { BridgeFrame, MessagePart } from "@qingagent/contract-ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../sessionState.js";

const recordUsageEventMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@qingagent/db", () => ({
  recordUsageEvent: recordUsageEventMock,
}));

vi.mock("../../mastra.js", () => ({
  mastra: {
    getLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
  getObservability: () => null,
}));

async function* streamOf(...chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk;
}

async function collectFramesAndReturn<TReturn>(
  generator: AsyncGenerator<BridgeFrame, TReturn>,
): Promise<{ frames: BridgeFrame[]; result: TReturn }> {
  const frames: BridgeFrame[] = [];
  for (;;) {
    const next = await generator.next();
    if (next.done) return { frames, result: next.value };
    frames.push(next.value);
  }
}

type ToolCallUpdatedFrame = Extract<BridgeFrame, { kind: "toolCallUpdated" }>;

function isToolCallPart(part: MessagePart): part is Extract<MessagePart, { kind: "toolCall" }> {
  return part.kind === "toolCall";
}

function isToolCallUpdatedFrame(frame: BridgeFrame): frame is ToolCallUpdatedFrame {
  return frame.kind === "toolCallUpdated";
}

function fetchArticleResult(index: number, overrides: Record<string, unknown> = {}) {
  return {
    title: `文章 ${index}`,
    text: `第 ${index} 篇文章的完整正文，用于验证并行工具结果按各自 toolCallId 收口。`,
    wordCount: 31,
    images: [],
    screenshotSrc: null,
    ogImageUrl: null,
    sourceUrl: `https://example.com/article-${index}`,
    materialId: `mat-${index}`,
    via: "static",
    ...overrides,
  };
}

function parallelFetchChunks(results: unknown[]) {
  const toolCallIds = ["fetch-1", "fetch-2", "fetch-3"];
  return [
    { type: "step-start", payload: { request: { body: "{}" } } },
    ...toolCallIds.map((toolCallId, index) => ({
      type: "tool-call",
      payload: {
        toolName: "fetchArticle",
        toolCallId,
        args: { url: `https://example.com/article-${index + 1}` },
      },
    })),
    ...toolCallIds.map((toolCallId, index) => ({
      type: "tool-result",
      payload: {
        toolName: "fetchArticle",
        toolCallId,
        args: { url: `https://example.com/article-${index + 1}` },
        result: results[index],
      },
    })),
    { type: "text-delta", payload: { id: "text-1", text: "三个来源已处理。" } },
    {
      type: "step-finish",
      payload: {
        stepResult: { reason: "stop" },
        output: { usage: { inputTokens: 100, outputTokens: 10 } },
      },
    },
  ];
}

describe("processAgentStream 行为特征", () => {
  beforeEach(() => {
    recordUsageEventMock.mockClear();
  });

  it("按原顺序追加 text/thinking 增量并共享单调 seq", async () => {
    const { processAgentStream } = await import("../processAgentStream.js");
    const state = createSession("characterize-text-reasoning");
    state.chatHistory.push({
      id: "agent-message",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [],
      chips: null,
    });

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(
        streamOf(
          { type: "text-delta", payload: { id: "text-1", text: "甲" } },
          { type: "reasoning-start", payload: { id: "reasoning-1" } },
          { type: "reasoning-delta", payload: { id: "reasoning-1", text: "思考" } },
          { type: "reasoning-end", payload: { id: "reasoning-1" } },
          { type: "text-delta", payload: { id: "text-1", text: "乙" } },
        ),
        {
          state,
          agentMessageId: "agent-message",
          streamId: "stream-text-reasoning",
          runId: "run-text-reasoning",
        },
      ),
    );

    expect(frames).toEqual([
      {
        kind: "chatMessageAppended",
        data: {
          messageId: "agent-message",
          seq: 1,
          part: { kind: "text", data: { body: "甲" } },
        },
      },
      {
        kind: "chatMessageAppended",
        data: {
          messageId: "agent-message",
          seq: 2,
          part: {
            kind: "thinking",
            data: { id: "reasoning-1", steps: ["思考"] },
          },
        },
      },
      {
        kind: "chatMessageAppended",
        data: {
          messageId: "agent-message",
          seq: 3,
          part: { kind: "text", data: { body: "乙" } },
        },
      },
    ]);
    expect(state.chatHistory[0]?.parts).toEqual(frames.map((frame) => {
      if (frame.kind !== "chatMessageAppended") throw new Error("unexpected frame");
      return frame.data.part;
    }));
    expect(state.messages).toEqual([{ role: "assistant", content: "甲乙" }]);
    expect(result).toMatchObject({
      producedVisibleFrame: true,
      sawToolCall: false,
      sawSideEffectToolCall: false,
      streamWasUserAborted: false,
    });
  });

  it("step-finish 把 usage 与同级 providerMetadata 合并后记入 agent 账本", async () => {
    const { processAgentStream } = await import("../processAgentStream.js");
    const state = createSession("characterize-step-usage");

    await collectFramesAndReturn(
      processAgentStream(
        streamOf(
          {
            type: "step-start",
            payload: { request: { body: "{}" } },
          },
          { type: "text-delta", payload: { id: "text-1", text: "完成" } },
          {
            type: "step-finish",
            payload: {
              stepResult: { reason: "stop" },
              output: { usage: { inputTokens: 120, outputTokens: 8 } },
              providerMetadata: {
                openai: { cachedPromptTokens: 90 },
              },
            },
          },
        ),
        {
          state,
          agentMessageId: "agent-message",
          streamId: "stream-step-usage",
          runId: "run-step-usage",
        },
      ),
    );

    expect(recordUsageEventMock).toHaveBeenCalledOnce();
    expect(recordUsageEventMock).toHaveBeenCalledWith({
      sessionId: "characterize-step-usage",
      runId: "run-step-usage",
      callSite: "agent",
      modelId: expect.any(String),
      keyOrigin: expect.stringMatching(/^(none|env)$/),
      inputTokens: 120,
      outputTokens: 8,
      cacheHitTokens: 90,
      cacheMissTokens: 30,
    });
  });

  it("askUser 恢复流收到 null result 时仍原位收口问卷卡", async () => {
    const { processAgentStream } = await import("../processAgentStream.js");
    const state = createSession("characterize-null-questionnaire-result");
    state.chatHistory.push({
      id: "previous-agent-message",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [
        {
          kind: "toolCall",
          data: {
            id: "ask-1",
            name: "planDraft",
            render: { kind: "chatInline" },
            status: { kind: "running", data: { progressPct: null, etaSec: null } },
            body: { kind: "generic", data: { argsJson: "{}" } },
            result: null,
          },
        },
      ],
      chips: null,
    });

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(
        streamOf({
          type: "tool-result",
          payload: {
            toolName: "planDraft",
            toolCallId: "ask-1",
            args: {},
            result: null,
          },
        }),
        {
          state,
          agentMessageId: "resumed-agent-message",
          streamId: "stream-null-questionnaire-result",
          runId: "run-null-questionnaire-result",
        },
      ),
    );

    expect(frames).toEqual([
      {
        kind: "toolCallUpdated",
        data: {
          messageId: "previous-agent-message",
          toolCallId: "ask-1",
          spec: expect.objectContaining({
            id: "ask-1",
            name: "planDraft",
            status: { kind: "done" },
            result: { kind: "genericText", data: "已提交" },
          }),
        },
      },
      {
        kind: "chatMessageAppended",
        data: {
          messageId: "resumed-agent-message",
          seq: 1,
          part: {
            kind: "text",
            data: {
              body: "做了多步操作，但还没给出最终结果。回复“继续”我接着完成，或重试。",
            },
          },
        },
      },
      {
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: {
            streamId: "stream-null-questionnaire-result",
            retriable: true,
            reason: "做了多步操作，但还没给出最终结果。回复“继续”我接着完成，或重试。",
          },
        },
      },
    ]);
    expect(state.chatHistory[0]?.parts[0]).toMatchObject({
      kind: "toolCall",
      data: {
        id: "ask-1",
        status: { kind: "done" },
        result: { kind: "genericText", data: "已提交" },
      },
    });
    expect(result).toMatchObject({
      producedVisibleFrame: true,
      sawToolCall: true,
      sawSideEffectToolCall: false,
      streamWasUserAborted: false,
    });
  });

  it("同一步三个同名并行工具按 toolCallId 分别收口并正常结束", async () => {
    const { processAgentStream } = await import("../processAgentStream.js");
    const state = createSession("characterize-parallel-tools");

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(
        streamOf(
          ...parallelFetchChunks([
            fetchArticleResult(1),
            fetchArticleResult(2),
            fetchArticleResult(3),
          ]),
        ),
        {
          state,
          agentMessageId: "agent-message",
          streamId: "stream-parallel-tools",
          runId: "run-parallel-tools",
        },
      ),
    );

    const toolParts = state.chatHistory
      .flatMap((message) => message.parts)
      .filter(isToolCallPart);
    expect(toolParts).toHaveLength(3);
    expect(toolParts.map((part) => part.data.id)).toEqual(["fetch-1", "fetch-2", "fetch-3"]);
    expect(toolParts.map((part) => part.data.status.kind)).toEqual(["done", "done", "done"]);
    expect(
      frames
        .filter(isToolCallUpdatedFrame)
        .filter((frame) => frame.data.spec.status.kind !== "running")
        .map((frame) => [frame.data.toolCallId, frame.data.spec.status.kind]),
    ).toEqual([
      ["fetch-1", "done"],
      ["fetch-2", "done"],
      ["fetch-3", "done"],
    ]);
    expect(state.messages.at(-1)).toEqual({ role: "assistant", content: "三个来源已处理。" });
    expect(result).toMatchObject({
      producedVisibleFrame: true,
      sawToolCall: true,
      sawSideEffectToolCall: true,
      streamWasUserAborted: false,
    });
  });

  it("三个同名并行工具中一个错误对象不会阻塞其余结果收口", async () => {
    const { processAgentStream } = await import("../processAgentStream.js");
    const state = createSession("characterize-parallel-tools-one-error");

    const { result } = await collectFramesAndReturn(
      processAgentStream(
        streamOf(
          ...parallelFetchChunks([
            fetchArticleResult(1),
            fetchArticleResult(2, { ok: false, text: "[Error] 站点拒绝访问", wordCount: 0 }),
            fetchArticleResult(3),
          ]),
        ),
        {
          state,
          agentMessageId: "agent-message",
          streamId: "stream-parallel-tools-one-error",
          runId: "run-parallel-tools-one-error",
        },
      ),
    );

    const terminalById = new Map(
      state.chatHistory
        .flatMap((message) => message.parts)
        .filter(isToolCallPart)
        .map((part) => [part.data.id, part.data.status.kind]),
    );
    expect(terminalById).toEqual(new Map([
      ["fetch-1", "done"],
      ["fetch-2", "failed"],
      ["fetch-3", "done"],
    ]));
    expect(state.messages.at(-1)).toEqual({ role: "assistant", content: "三个来源已处理。" });
    expect(result.streamWasUserAborted).toBe(false);
  });
});

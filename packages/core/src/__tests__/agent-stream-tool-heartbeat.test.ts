import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolStream } from "@mastra/core/tools";
import type { BridgeFrame } from "@qingagent/contract-ts";
import { startToolHeartbeat } from "../tools/toolHeartbeat.js";

// 桥层回归:工具心跳只负责清零 idle 看门狗,不应变成聊天可见帧,
// 也不能被重试守卫当成真实副作用工具活动。

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => logger,
    getMemory: () => null,
  },
  getObservability: () => null,
}));

vi.mock("../agents/qingagent.js", () => ({
  getQingagentSkills: vi.fn(async () => ({
    maybeRefresh: vi.fn(async () => {}),
    has: vi.fn(async () => false),
  })),
  qingagentAgent: { stream: vi.fn(), resumeStream: vi.fn() },
}));

async function* streamOf(...chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk;
}

async function collectFramesAndReturn<TReturn>(
  gen: AsyncGenerator<BridgeFrame, TReturn>,
): Promise<{ frames: BridgeFrame[]; result: TReturn }> {
  const frames: BridgeFrame[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { frames, result: next.value };
    frames.push(next.value);
  }
}

type ToolCallUpdatedFrame = Extract<BridgeFrame, { kind: "toolCallUpdated" }>;

function isToolCallUpdatedFrame(frame: BridgeFrame): frame is ToolCallUpdatedFrame {
  return frame.kind === "toolCallUpdated";
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.ended) return { done: true, value: undefined };
        return await new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

async function* parallelCallsWithHeartbeatOnly(): AsyncGenerator<unknown> {
  const toolCallIds = ["heartbeat-fetch-1", "heartbeat-fetch-2", "heartbeat-fetch-3"];
  for (const [index, toolCallId] of toolCallIds.entries()) {
    yield {
      type: "tool-call",
      payload: {
        toolCallId,
        toolName: "fetchArticle",
        args: { url: `https://example.com/${index + 1}` },
      },
    };
  }
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 9));
    const toolCallId = toolCallIds[index % toolCallIds.length]!;
    yield {
      type: "tool-output",
      payload: {
        toolCallId,
        output: { type: "tool-heartbeat", tool: "fetchArticle", seq: index + 1 },
      },
    };
  }
  yield { type: "text-delta", payload: { id: "late", text: "不应等到这条迟到输出" } };
}

async function* heartbeatsWithRealProgress(): AsyncGenerator<unknown> {
  const toolCallId = "heartbeat-progress-1";
  yield {
    type: "tool-call",
    payload: { toolCallId, toolName: "parallelProbe", args: {} },
  };
  for (let index = 0; index < 2; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 9));
    yield {
      type: "tool-output",
      payload: {
        toolCallId,
        output: { type: "tool-heartbeat", tool: "parallelProbe", seq: index + 1 },
      },
    };
  }
  await new Promise((resolve) => setTimeout(resolve, 9));
  yield {
    type: "tool-output",
    payload: {
      toolCallId,
      output: { type: "research-fulltext", items: [] },
    },
  };
  await new Promise((resolve) => setTimeout(resolve, 9));
  yield {
    type: "tool-output",
    payload: {
      toolCallId,
      output: { type: "tool-heartbeat", tool: "parallelProbe", seq: 3 },
    },
  };
  await new Promise((resolve) => setTimeout(resolve, 9));
  yield {
    type: "tool-result",
    payload: {
      toolCallId,
      toolName: "parallelProbe",
      args: {},
      result: { ok: true },
    },
  };
  yield { type: "text-delta", payload: { id: "done", text: "正常完成" } };
}

describe("processAgentStream tool-heartbeat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tool-output 心跳本身不可见,零产出收尾补提示且不标记副作用工具调用", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("tool-heartbeat-no-frame");

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(
        streamOf({
          type: "tool-output",
          payload: {
            toolCallId: "hb-1",
            output: { type: "tool-heartbeat", tool: "generateSvg", seq: 1 },
          },
        }),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-heartbeat",
          runId: "run-heartbeat",
        },
      ),
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "chatMessageAppended",
      data: {
        part: {
          kind: "text",
          data: { body: expect.stringContaining("没有得到可展示的结果") },
        },
      },
    });
    expect(result.producedVisibleFrame).toBe(true);
    expect(result.sawSideEffectToolCall).toBe(false);
    expect(state.messages).toEqual([
      {
        role: "assistant",
        content: expect.stringContaining("没有得到可展示的结果"),
      },
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      "Tool heartbeat consumed by agent stream watchdog",
      expect.objectContaining({
        streamId: "stream-heartbeat",
        tool: "generateSvg",
        receivedCount: 1,
        resetsIdleTimer: true,
      }),
    );
  });

  it("Mastra ToolStream 实发心跳会进入 fullStream 形态并被 idle 计时器消费", async () => {
    vi.useFakeTimers();
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const queue = new AsyncEventQueue<unknown>();
    const observe = { log: vi.fn() };
    const state = createSession("tool-heartbeat-mastra-writer");
    queue.push({
      type: "tool-call",
      payload: { toolCallId: "mastra-writer-1", toolName: "slowTool", args: {} },
    });
    const writer = new ToolStream(
      {
        prefix: "tool",
        callId: "mastra-writer-1",
        name: "slowTool",
        runId: "run-heartbeat-mastra-writer",
      },
      async (chunk) => queue.push(chunk),
    );
    const stop = startToolHeartbeat(
      { writer, observe },
      { tool: "slowTool", intervalMs: 1_000 },
    );
    let done = false;
    const collected = collectFramesAndReturn(
      processAgentStream(queue, {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-heartbeat-mastra-writer",
        runId: "run-heartbeat-mastra-writer",
        idleTimeoutMs: 1_500,
        firstChunkTimeoutMs: 1_500,
        toolHeartbeatTimeoutMs: 5_000,
      }),
    ).then((result) => {
      done = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(3_500);
    expect(done).toBe(false);
    expect(observe.log).toHaveBeenCalledWith(
      "info",
      "Tool heartbeat emitted",
      expect.objectContaining({ tool: "slowTool", emittedCount: 1 }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Tool heartbeat consumed by agent stream watchdog",
      expect.objectContaining({
        streamId: "stream-heartbeat-mastra-writer",
        tool: "slowTool",
        resetsIdleTimer: true,
      }),
    );

    stop();
    queue.push({
      type: "tool-result",
      payload: {
        toolCallId: "mastra-writer-1",
        toolName: "slowTool",
        args: {},
        result: { ok: true },
      },
    });
    queue.push({ type: "text-delta", payload: { text: "心跳后正常收尾" } });
    queue.end();
    const { frames } = await collected;

    expect(JSON.stringify(frames)).not.toContain("draftingFailed");
    expect(state.messages.at(-1)).toEqual({ role: "assistant", content: "心跳后正常收尾" });
  });

  it("三个工具只有心跳却始终无结果时会有界失败并按 toolCallId 收口卡片", async () => {
    vi.useFakeTimers();
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("tool-heartbeat-bounded");

    const collected = collectFramesAndReturn(
      processAgentStream(parallelCallsWithHeartbeatOnly(), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-heartbeat-bounded",
        runId: "run-heartbeat-bounded",
        idleTimeoutMs: 10,
        toolHeartbeatTimeoutMs: 30,
      }),
    );

    await vi.advanceTimersByTimeAsync(60);
    const { frames, result } = await collected;
    const terminalUpdates = frames
      .filter(isToolCallUpdatedFrame)
      .filter((frame) => frame.data.spec.status.kind === "failed");

    expect(terminalUpdates.map((frame) => frame.data.toolCallId)).toEqual([
      "heartbeat-fetch-1",
      "heartbeat-fetch-2",
      "heartbeat-fetch-3",
    ]);
    expect(terminalUpdates.every((frame) =>
      frame.data.spec.status.kind === "failed" &&
      frame.data.spec.status.data.reason.includes("长时间未返回结果"),
    )).toBe(true);
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "stream",
      data: expect.objectContaining({ kind: "draftingFailed" }),
    }));
    expect(JSON.stringify(frames)).not.toContain("不应等到这条迟到输出");
    expect(result.streamWasUserAborted).toBe(false);
  });

  it("真实工具进度会重置连续心跳窗口并允许结果正常返回", async () => {
    vi.useFakeTimers();
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("tool-heartbeat-real-progress");

    const collected = collectFramesAndReturn(
      processAgentStream(heartbeatsWithRealProgress(), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-heartbeat-real-progress",
        runId: "run-heartbeat-real-progress",
        idleTimeoutMs: 10,
        toolHeartbeatTimeoutMs: 30,
      }),
    );

    await vi.advanceTimersByTimeAsync(60);
    const { frames } = await collected;
    const toolPart = state.chatHistory
      .flatMap((message) => message.parts)
      .find((part) => part.kind === "toolCall" && part.data.id === "heartbeat-progress-1");

    expect(toolPart).toMatchObject({
      kind: "toolCall",
      data: { id: "heartbeat-progress-1", status: { kind: "done" } },
    });
    expect(JSON.stringify(frames)).not.toContain("draftingFailed");
    expect(state.messages.at(-1)).toEqual({ role: "assistant", content: "正常完成" });
  });
});

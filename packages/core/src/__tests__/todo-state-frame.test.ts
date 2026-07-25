import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, TodoItem } from "@qingagent/contract-ts";

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
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

async function collect(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function updateTodosStart(toolCallId: string) {
  return {
    type: "tool-call-input-streaming-start",
    payload: { toolName: "updateTodos", toolCallId },
  };
}

function updateTodosCall(toolCallId: string, todos: unknown) {
  return {
    type: "tool-call",
    payload: { toolName: "updateTodos", toolCallId, args: { todos } },
  };
}

function updateTodosResult(toolCallId: string, todos: unknown) {
  return {
    type: "tool-result",
    payload: {
      toolName: "updateTodos",
      toolCallId,
      args: { todos },
      result: { ok: true, count: Array.isArray(todos) ? todos.length : 0 },
    },
  };
}

function visibleToolFrames(frames: BridgeFrame[]): BridgeFrame[] {
  return frames.filter(
    (frame) =>
      (frame.kind === "chatMessageAppended" && frame.data.part.kind === "toolCall") ||
      (frame.kind === "chatMessageAdded" &&
        frame.data.message.parts.some((part) => part.kind === "toolCall")) ||
      frame.kind === "toolCallUpdated",
  );
}

describe("updateTodos 会话状态帧", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("工具调用更新 state.todos 并只发 todosChanged,不建对话工具卡", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("todos-ok");
    const todos: TodoItem[] = [
      { content: "确认需求范围", status: "in_progress" },
      { content: "实现后端状态帧", status: "pending" },
      { content: "补回归测试", status: "pending" },
    ];

    const frames = await collect(
      processAgentStream(
        streamOf(
          updateTodosStart("todo-1"),
          updateTodosCall("todo-1", todos),
          updateTodosResult("todo-1", todos),
        ),
        { state, agentMessageId: "m", streamId: "s", runId: "r" },
      ),
    );

    expect(frames).toContainEqual({ kind: "todosChanged", data: { todos } });
    expect(state.todos).toEqual(todos);
    expect(visibleToolFrames(frames)).toEqual([]);
    expect(
      state.chatHistory.some((message) =>
        message.parts.some((part) => part.kind === "toolCall" && part.data.name === "updateTodos"),
      ),
    ).toBe(false);
  });

  it.each([
    ["status 非法", [{ content: "确认需求", status: "doing" }]],
    ["缺 content", [{ status: "pending" }]],
  ])("脏参数不崩溃、不发非法 todosChanged:%s", async (_label, todos) => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("todos-dirty");

    const frames = await collect(
      processAgentStream(
        streamOf(updateTodosCall("todo-dirty", todos), updateTodosResult("todo-dirty", todos)),
        { state, agentMessageId: "m", streamId: "s", runId: "r" },
      ),
    );

    expect(frames.some((frame) => frame.kind === "todosChanged")).toBe(false);
    expect(frames).toEqual([
      expect.objectContaining({
        kind: "chatMessageAppended",
        data: expect.objectContaining({
          part: {
            kind: "text",
            data: { body: expect.stringContaining("没有得到可展示的结果") },
          },
        }),
      }),
    ]);
    expect(state.todos).toEqual([]);
    expect(visibleToolFrames(frames)).toEqual([]);
  });
});

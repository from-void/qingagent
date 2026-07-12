import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../session/sessionState.js";
import {
  TODO_AWARENESS_MAX_CONTENT_CHARS,
  TODO_AWARENESS_MARKER,
  buildTodoAwarenessContent,
} from "../agent-run/todoAwareness.js";
import {
  appendTodoAwarenessToPromptOptions,
  todoAwarenessContentFromRequestContext,
  wrapModelWithTodoAwareness,
} from "../llm/todoAwarenessPrompt.js";
import type { BridgeFrame, TodoItem } from "@qingagent/contract-ts";
import type { CoreMessage } from "ai";

const agentStreamCalls: Array<{ messages: CoreMessage[]; options: Record<string, unknown> }> = [];

async function* streamOfText(text: string): AsyncGenerator<unknown> {
  yield { type: "text-delta", payload: { text } };
}

async function collectFrames(
  gen: AsyncGenerator<BridgeFrame>,
): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function messageText(message: CoreMessage): string {
  return contentText(message.content);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).join("");
  if (content && typeof content === "object" && "text" in content) {
    return String((content as { text?: unknown }).text ?? "");
  }
  return JSON.stringify(content);
}

function hasTodoAwareness(messages: CoreMessage[]): boolean {
  return messages.some((message) => messageText(message).includes(TODO_AWARENESS_MARKER));
}

function providerMessagesWithTodoAwareness(
  call: { messages: CoreMessage[]; options: Record<string, unknown> },
): CoreMessage[] {
  const requestContext = call.options.requestContext as { get?: (key: string) => unknown };
  const content = todoAwarenessContentFromRequestContext(requestContext);
  const options = appendTodoAwarenessToPromptOptions({
    prompt: call.messages,
  }, content);
  return options.prompt as CoreMessage[];
}

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
  qingagentAgent: {
    stream: vi.fn(async (messages: CoreMessage[], options: Record<string, unknown>) => {
      agentStreamCalls.push({ messages: [...messages], options });
      return {
        runId: `run-${agentStreamCalls.length}`,
        fullStream: streamOfText("收到。"),
      };
    }),
  },
}));

describe("任务清单每轮感知", () => {
  beforeEach(() => {
    agentStreamCalls.length = 0;
    vi.clearAllMocks();
  });

  it("有未完成项时在 provider prompt 尾部注入当前清单状态，但不污染 agent 输入", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const state = createSession("todo-awareness-inject");
    state.todos = [
      { content: "确认需求范围", status: "completed" },
      { content: "实现尾部注入", status: "in_progress" },
      { content: "补回归测试", status: "pending" },
    ];

    await collectFrames(runAgentTurn(state, "继续"));

    expect(agentStreamCalls).toHaveLength(1);
    expect(agentStreamCalls[0]!.options.inputProcessors).toBeUndefined();
    expect(agentStreamCalls[0]!.options.outputProcessors).toBeUndefined();
    expect(hasTodoAwareness(agentStreamCalls[0]!.messages)).toBe(false);
    const requestContext = agentStreamCalls[0]!.options.requestContext as { get?: (key: string) => unknown };
    expect(todoAwarenessContentFromRequestContext(requestContext)).toContain(TODO_AWARENESS_MARKER);
    const sentMessages = providerMessagesWithTodoAwareness(agentStreamCalls[0]!);
    const injected = sentMessages[sentMessages.length - 1];
    expect(injected?.role).toBe("user");
    const content = messageText(injected!);
    expect(content).toContain(`${TODO_AWARENESS_MARKER} 当前清单:`);
    expect(content).toContain("1.[已完成]确认需求范围");
    expect(content).toContain("2.[进行中]实现尾部注入");
    expect(content).toContain("3.[待办]补回归测试");
    expect(content).toContain("请继续推进未完成项");
    expect(content).toContain("调用 updateTodos 更新或清空清单");
  });

  it("全部 completed 时不注入", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const state = createSession("todo-awareness-completed");
    state.todos = [
      { content: "确认需求范围", status: "completed" },
      { content: "补回归测试", status: "completed" },
    ];

    await collectFrames(runAgentTurn(state, "现在做别的"));

    expect(agentStreamCalls).toHaveLength(1);
    expect(hasTodoAwareness(agentStreamCalls[0]!.messages)).toBe(false);
    expect(hasTodoAwareness(providerMessagesWithTodoAwareness(agentStreamCalls[0]!))).toBe(false);
  });

  it("空清单时不注入", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const state = createSession("todo-awareness-empty");

    await collectFrames(runAgentTurn(state, "你好"));

    expect(agentStreamCalls).toHaveLength(1);
    expect(hasTodoAwareness(agentStreamCalls[0]!.messages)).toBe(false);
    expect(hasTodoAwareness(providerMessagesWithTodoAwareness(agentStreamCalls[0]!))).toBe(false);
  });

  it("清单超过 10 项时最多逐项列出 10 项并汇总剩余数量", () => {
    const todos: TodoItem[] = Array.from({ length: 12 }, (_, index) => ({
      content: `步骤${index + 1}`,
      status: index === 0 ? "in_progress" : "pending",
    }));

    const content = buildTodoAwarenessContent(todos);

    expect(content).toContain("10.[待办]步骤10");
    expect(content).not.toContain("11.[待办]步骤11");
    expect(content).not.toContain("12.[待办]步骤12");
    expect(content).toContain("…另有 2 项");
  });

  it("长清单截断时优先保留未完成项，不让已完成项挤掉待办内容", () => {
    const todos: TodoItem[] = [
      ...Array.from({ length: 10 }, (_, index) => ({
        content: `步骤${index + 1}`,
        status: "completed" as const,
      })),
      { content: "步骤11", status: "pending" },
      { content: "步骤12", status: "in_progress" },
    ];

    const content = buildTodoAwarenessContent(todos);

    expect(content).toContain("9.[待办]步骤11");
    expect(content).toContain("10.[进行中]步骤12");
    expect(content).not.toContain("[已完成]步骤9");
    expect(content).not.toContain("[已完成]步骤10");
    expect(content).toContain("…另有 2 项");
  });

  it("长清单截断时优先保留进行中项，不让普通待办挤掉当前步骤", () => {
    const todos: TodoItem[] = [
      ...Array.from({ length: 10 }, (_, index) => ({
        content: `步骤${index + 1}`,
        status: "pending" as const,
      })),
      { content: "步骤11", status: "in_progress" },
    ];

    const content = buildTodoAwarenessContent(todos);

    expect(content).toContain("10.[进行中]步骤11");
    expect(content).not.toContain("[待办]步骤10");
    expect(content).toContain("…另有 1 项");
  });

  it("单项内容过长时截断注入文本，避免每轮重复塞入大段清单正文", () => {
    const longContent = "A".repeat(TODO_AWARENESS_MAX_CONTENT_CHARS + 20);
    const content = buildTodoAwarenessContent([{ content: longContent, status: "pending" }]);

    expect(content).toContain(`${"A".repeat(TODO_AWARENESS_MAX_CONTENT_CHARS)}…`);
    expect(content).not.toContain("A".repeat(TODO_AWARENESS_MAX_CONTENT_CHARS + 1));
  });

  it("模型代理在真实 provider 参数形态中追加提醒，不依赖 options.requestContext", async () => {
    let awareness: string | null = `${TODO_AWARENESS_MARKER} 当前清单:1.[待办]补测试。`;
    const seenPrompts: unknown[] = [];
    const baseModel = {
      async doGenerate(options: { prompt?: unknown }) {
        seenPrompts.push(options.prompt);
        return { content: [], finishReason: "stop", usage: {}, warnings: [] };
      },
      async doStream(options: { prompt?: unknown }) {
        seenPrompts.push(options.prompt);
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
        };
      },
    };

    const wrapped = wrapModelWithTodoAwareness(baseModel, () => awareness);
    await wrapped.doStream({ prompt: [{ role: "user", content: "继续" }] });
    awareness = `${TODO_AWARENESS_MARKER} 当前清单:1.[进行中]复查。`;
    await wrapped.doGenerate({ prompt: [{ role: "user", content: "继续" }] });
    awareness = null;
    await wrapped.doStream({ prompt: [{ role: "user", content: "继续" }] });

    expect((seenPrompts[0] as CoreMessage[]).at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: `${TODO_AWARENESS_MARKER} 当前清单:1.[待办]补测试。` }],
    });
    expect((seenPrompts[1] as CoreMessage[]).at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: `${TODO_AWARENESS_MARKER} 当前清单:1.[进行中]复查。` }],
    });
    expect((seenPrompts[2] as CoreMessage[])).toEqual([{ role: "user", content: "继续" }]);
    expect(wrapModelWithTodoAwareness(baseModel, null)).toBe(baseModel);
  });

  it("同一轮 updateTodos 后 requestContext 源读取最新 state.todos", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const state = createSession("todo-awareness-dynamic-source");
    state.todos = [{ content: "旧步骤", status: "pending" }];

    await collectFrames(runAgentTurn(state, "继续"));

    const requestContext = agentStreamCalls[0]!.options.requestContext as { get?: (key: string) => unknown };
    expect(todoAwarenessContentFromRequestContext(requestContext)).toContain("[待办]旧步骤");

    state.todos = [{ content: "新步骤", status: "in_progress" }];
    expect(todoAwarenessContentFromRequestContext(requestContext)).toContain("[进行中]新步骤");
    expect(todoAwarenessContentFromRequestContext(requestContext)).not.toContain("旧步骤");

    state.todos = [{ content: "新步骤", status: "completed" }];
    expect(todoAwarenessContentFromRequestContext(requestContext)).toBeNull();
  });

  it("连续 3 轮后 state.messages 和 chatHistory 都没有注入残留", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const state = createSession("todo-awareness-no-residue");
    state.todos = [{ content: "推进剩余任务", status: "in_progress" }];

    for (const text of ["第一轮", "第二轮", "第三轮"]) {
      await collectFrames(runAgentTurn(state, text));
    }

    expect(agentStreamCalls).toHaveLength(3);
    expect(agentStreamCalls.every((call) => hasTodoAwareness(call.messages))).toBe(false);
    expect(agentStreamCalls.every((call) => hasTodoAwareness(providerMessagesWithTodoAwareness(call))))
      .toBe(true);
    expect(hasTodoAwareness(state.messages)).toBe(false);
    expect(
      state.chatHistory.some((message) =>
        message.parts.some(
          (part) => part.kind === "text" && part.data.body.includes(TODO_AWARENESS_MARKER),
        ),
      ),
    ).toBe(false);
  });

  it("注入本身不产生 todosChanged 帧", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const state = createSession("todo-awareness-no-frame");
    state.todos = [{ content: "继续未完成任务", status: "pending" }];

    const frames = await collectFrames(runAgentTurn(state, "继续"));

    expect(agentStreamCalls).toHaveLength(1);
    expect(hasTodoAwareness(agentStreamCalls[0]!.messages)).toBe(false);
    expect(hasTodoAwareness(providerMessagesWithTodoAwareness(agentStreamCalls[0]!))).toBe(true);
    expect(frames.some((frame) => frame.kind === "todosChanged")).toBe(false);
    expect(state.todos).toEqual([{ content: "继续未完成任务", status: "pending" }]);
  });

  it("ToolSearch 开启时与 todoAwareness wrapper 共存,selected skill loaded state 不丢", async () => {
    const previousFlag = process.env.QINGAGENT_TOOL_SEARCH;
    process.env.QINGAGENT_TOOL_SEARCH = "1";
    try {
      const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
      const { getQingagentSkills } = await import("../agents/qingagent.js");
      vi.mocked(getQingagentSkills).mockResolvedValueOnce({
        maybeRefresh: vi.fn(async () => {}),
        has: vi.fn(async (name: string) => name === "image-gen"),
      } as never);
      const state = createSession("todo-awareness-tool-search");
      state.todos = [{ content: "给正文配一张示意图", status: "in_progress" }];

      await collectFrames(runAgentTurn(
        state,
        "生成一张文章配图",
        [],
        [],
        ["image-gen"],
      ));

      expect(agentStreamCalls).toHaveLength(1);
      const call = agentStreamCalls[0]!;
      expect(call.options.inputProcessors).toBeUndefined();
      expect(call.options.outputProcessors).toBeUndefined();
      expect(Object.keys((call.options.toolsets as any).capabilityTools).sort()).toEqual([
        "show_qr",
        "updateTodos",
      ]);
      const requestContext = call.options.requestContext as {
        get?: (key: string) => unknown;
      };
      expect(todoAwarenessContentFromRequestContext(requestContext)).toContain(TODO_AWARENESS_MARKER);
      expect(hasTodoAwareness(providerMessagesWithTodoAwareness(call))).toBe(true);

      const processor = requestContext.get?.("qingagentToolSearchProcessor") as {
        getLoadedToolsForRequestContext?: (args: { requestContext: unknown }) => Promise<Record<string, unknown>>;
      } | undefined;
      expect(processor?.getLoadedToolsForRequestContext).toBeTypeOf("function");
      await expect(processor!.getLoadedToolsForRequestContext!({ requestContext }))
        .resolves.toHaveProperty("generateSvg");
    } finally {
      if (previousFlag === undefined) delete process.env.QINGAGENT_TOOL_SEARCH;
      else process.env.QINGAGENT_TOOL_SEARCH = previousFlag;
    }
  });
});

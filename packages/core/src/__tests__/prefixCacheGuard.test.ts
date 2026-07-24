import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  PrefixCacheGuardError,
  __getPrefixCacheGuardSizeForTest,
  __resetPrefixCacheGuardForTest,
  guardBeforeProviderCall,
  guardContext,
  guardReset,
  withPrefixCacheGuardContext,
} from "../llm/prefixCacheGuard.js";
import { wrapModelWithDiagramVizEditing } from "../llm/diagramVizEditingPrompt.js";

type TestMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
};

const previousEnv = {
  cacheGuard: process.env.QINGAGENT_PREFIX_CACHE_GUARD,
  ci: process.env.CI,
};

function textPart(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function options(messages: TestMessage[], tools = [tool("writeDraft")]): unknown {
  return {
    prompt: messages,
    tools,
  };
}

function tool(name: string, description = `${name} tool`): unknown {
  return {
    type: "function",
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    },
  };
}

function streamFrom(parts: unknown[]): ReadableStream<any> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

function usage() {
  return { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
}

function hasMarkStepToolResult(prompt: unknown): boolean {
  const text = JSON.stringify(prompt);
  return text.includes('"tool-result"') && text.includes("markStep");
}

function createGuardedLoopModel(statuses: string[]): any {
  const finalText = "工具完成";
  return {
    specificationVersion: "v2",
    provider: "qingagent-test",
    modelId: "prefix-cache-real-agent-loop",
    supportedUrls: {},
    async doGenerate(options: any) {
      guardBeforeProviderCall(options);
      if (hasMarkStepToolResult(options.prompt)) {
        return {
          content: [{ type: "text", text: finalText }],
          finishReason: "stop",
          usage: usage(),
          warnings: [],
        };
      }
      return {
        content: [{
          type: "tool-call",
          toolCallId: "call_mark_step",
          toolName: "markStep",
          input: "{\"value\":\"ok\"}",
        }],
        finishReason: "tool-calls",
        usage: usage(),
        warnings: [],
      };
    },
    async doStream(options: any) {
      const result = guardBeforeProviderCall(options);
      statuses.push(result.status);
      if (hasMarkStepToolResult(options.prompt)) {
        return {
          stream: streamFrom([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: finalText },
            { type: "text-end", id: "text-1" },
            { type: "finish", finishReason: "stop", usage: usage() },
          ]),
        };
      }
      return {
        stream: streamFrom([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "call_mark_step",
            toolName: "markStep",
            input: "{\"value\":\"ok\"}",
          },
          { type: "finish", finishReason: "tool-calls", usage: usage() },
        ]),
      };
    },
  };
}

const markStepTool = createTool({
  id: "markStep",
  description: "Prefix cache guard real Agent loop test tool",
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input) => ({ ok: input.value === "ok" }),
});

function createGuardedAgent(statuses: string[]): Agent {
  return new Agent({
    id: "prefix-cache-real-agent",
    name: "Prefix Cache Real Agent",
    instructions: "Use markStep once, then answer with a short final text.",
    model: createGuardedLoopModel(statuses),
    tools: { markStep: markStepTool },
  });
}

async function drainGuardedAgent(
  agent: { stream: (messages: any, options: any) => Promise<{ fullStream: AsyncIterable<any> }> },
  messages: unknown,
  scopeId: string,
): Promise<any[]> {
  const context = {
    sessionId: "real-agent-prefix-cache",
    lineage: "turn" as const,
    scopeId,
  };
  const result = await guardContext.run(context, () =>
    agent.stream(messages, { maxSteps: 4 })
  );
  async function* fullStream(): AsyncGenerator<any, void> {
    for await (const chunk of result.fullStream) {
      yield chunk;
    }
  }
  const chunks: any[] = [];
  for await (const chunk of withPrefixCacheGuardContext(context, fullStream)) {
    chunks.push(chunk);
  }
  return chunks;
}

function callGuard(
  sessionId: string,
  lineage: "turn" | "resume",
  callOptions: unknown,
) {
  return guardContext.run({ sessionId, lineage }, () =>
    guardBeforeProviderCall(callOptions)
  );
}

describe("prefixCacheGuard", () => {
  beforeEach(() => {
    __resetPrefixCacheGuardForTest();
    process.env.QINGAGENT_PREFIX_CACHE_GUARD = "warn";
    delete process.env.CI;
  });

  afterEach(() => {
    __resetPrefixCacheGuardForTest();
    vi.restoreAllMocks();
    if (previousEnv.cacheGuard === undefined) delete process.env.QINGAGENT_PREFIX_CACHE_GUARD;
    else process.env.QINGAGENT_PREFIX_CACHE_GUARD = previousEnv.cacheGuard;
    if (previousEnv.ci === undefined) delete process.env.CI;
    else process.env.CI = previousEnv.ci;
  });

  it("同 session 前缀增长通过，工具集合乱序仍稳定", () => {
    const firstPrompt: TestMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: [textPart("第一轮")] },
    ];
    const secondPrompt: TestMessage[] = [
      ...firstPrompt,
      { role: "assistant", content: [textPart("收到")] },
      { role: "user", content: [textPart("第二轮")] },
    ];
    const firstTools = [tool("writeDraft"), tool("readMaterial")];
    const secondTools = [tool("readMaterial"), tool("writeDraft")];

    expect(callGuard("session-a", "turn", options(firstPrompt, firstTools)).status)
      .toBe("recorded");
    expect(callGuard("session-a", "turn", options(secondPrompt, secondTools)).status)
      .toBe("passed");
  });

  it("ToolSearch 明确激活的新增工具不触发工具漂移告警", () => {
    const firstPrompt: TestMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: [textPart("第一轮")] },
    ];
    const toolSearchResultPrompt: TestMessage[] = [
      ...firstPrompt,
      {
        role: "assistant",
        content: [{
          type: "tool-invocation",
          toolInvocation: {
            toolCallId: "search-1",
            toolName: "search_tools",
            state: "result",
            result: {
              results: [{ name: "generateSvg", description: "生成 SVG", score: 1 }],
              message: "Found and loaded 1 tool(s): generateSvg.",
            },
          },
        }],
      },
      { role: "user", content: [textPart("第二轮")] },
    ];

    expect(callGuard("session-toolsearch-load", "turn", options(firstPrompt, [
      tool("search_tools"),
    ])).status).toBe("recorded");
    expect(callGuard("session-toolsearch-load", "turn", options(toolSearchResultPrompt, [
      tool("search_tools"),
      tool("generateSvg"),
    ])).status).toBe("passed");
  });

  it("ToolSearch tool-result 使用 output 字段时也只放行实际加载工具", () => {
    const firstPrompt: TestMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: [textPart("第一轮")] },
    ];
    const toolSearchOutputPrompt: TestMessage[] = [
      ...firstPrompt,
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "search-1",
          toolName: "search_tools",
          output: {
            results: [{ name: "parseFile", description: "解析文件", score: 1 }],
          },
        }],
      },
    ];

    expect(callGuard("session-toolsearch-output", "turn", options(firstPrompt, [
      tool("search_tools"),
    ])).status).toBe("recorded");
    expect(callGuard("session-toolsearch-output", "turn", options(toolSearchOutputPrompt, [
      tool("search_tools"),
      tool("parseFile"),
    ])).status).toBe("passed");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(callGuard("session-toolsearch-output-unexpected", "turn", options(firstPrompt, [
      tool("search_tools"),
    ])).status).toBe("recorded");
    expect(callGuard("session-toolsearch-output-unexpected", "turn", options(toolSearchOutputPrompt, [
      tool("search_tools"),
      tool("webSearch"),
    ])).status).toBe("warned");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("selected skill 预加载 allowlist 只放行对应新增工具", () => {
    const firstPrompt: TestMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: [textPart("第一轮")] },
    ];
    const secondPrompt: TestMessage[] = [
      ...firstPrompt,
      { role: "assistant", content: [textPart("收到")] },
      { role: "user", content: [textPart("第二轮")] },
    ];

    expect(callGuard("session-toolsearch-preload", "turn", options(firstPrompt, [
      tool("search_tools"),
    ])).status).toBe("recorded");
    const result = guardContext.run({
      sessionId: "session-toolsearch-preload",
      lineage: "turn",
      allowedToolAdditions: ["generateSvg"],
    }, () => guardBeforeProviderCall(options(secondPrompt, [
      tool("search_tools"),
      tool("generateSvg"),
    ])));
    expect(result.status).toBe("passed");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unexpected = guardContext.run({
      sessionId: "session-toolsearch-preload-unexpected",
      lineage: "turn",
      allowedToolAdditions: ["generateSvg"],
    }, () => {
      guardBeforeProviderCall(options(firstPrompt, [tool("search_tools")]));
      return guardBeforeProviderCall(options(secondPrompt, [
        tool("search_tools"),
        tool("webSearch"),
      ]));
    });
    expect(unexpected.status).toBe("warned");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("ToolSearch allowlist 不放行同名工具 schema 漂移", () => {
    const prompt: TestMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: [textPart("同一轮")] },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = guardContext.run({
      sessionId: "session-toolsearch-same-name-drift",
      lineage: "turn",
      allowedToolAdditions: ["generateSvg"],
    }, () => {
      guardBeforeProviderCall(options(prompt, [tool("search_tools", "旧描述")]));
      return guardBeforeProviderCall(options(prompt, [tool("search_tools", "新描述")]));
    });

    expect(result.status).toBe("warned");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("hash 前剥离 Mastra providerOptions，历史消息语义不变时不误报", () => {
    process.env.QINGAGENT_PREFIX_CACHE_GUARD = "strict";
    const firstPrompt: TestMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [{
          type: "text",
          text: "第一轮",
          providerOptions: { mastra: { createdAt: 1781041155824 } },
        }],
      },
    ];
    const sameWirePrompt: TestMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [{
          type: "text",
          text: "第一轮",
          providerOptions: { mastra: { createdAt: 1781041155922 } },
        }],
      },
    ];

    expect(callGuard("session-provider-options", "turn", options(firstPrompt)).status)
      .toBe("recorded");
    expect(callGuard("session-provider-options", "turn", options(sameWirePrompt)).status)
      .toBe("passed");
  });

  it("warn 模式只告警并给出 firstDiffIndex，不抛错", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const firstPrompt: TestMessage[] = [
      { role: "system", content: "sys-a" },
      { role: "user", content: [textPart("第一轮")] },
    ];
    const driftPrompt: TestMessage[] = [
      { role: "system", content: "sys-b" },
      { role: "user", content: [textPart("第一轮")] },
    ];

    callGuard("session-b", "turn", options(firstPrompt));
    const result = callGuard("session-b", "turn", options(driftPrompt));

    expect(result.status).toBe("warned");
    if (result.status === "warned") {
      expect(result.diff.firstDiffIndex).toBe(0);
      expect(result.diff.prevRole).toBe("system");
      expect(result.diff.curRole).toBe("system");
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("strict 模式遇到 system 段漂移直接抛错", () => {
    process.env.QINGAGENT_PREFIX_CACHE_GUARD = "strict";
    const firstPrompt: TestMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: [textPart("第一轮")] },
    ];
    const driftPrompt: TestMessage[] = [
      { role: "system", content: "sys changed" },
      { role: "user", content: [textPart("第一轮")] },
    ];

    callGuard("session-c", "turn", options(firstPrompt));

    expect(() => callGuard("session-c", "turn", options(driftPrompt)))
      .toThrow(PrefixCacheGuardError);
  });

  it("图表编辑请求尾部注入不改变 system 消息集合和前缀快照", async () => {
    process.env.QINGAGENT_PREFIX_CACHE_GUARD = "strict";
    const systemMessages: TestMessage[] = [
      { role: "system", content: "固定主 system" },
      { role: "system", content: "固定工具规范" },
    ];
    const prompt: TestMessage[] = [
      ...systemMessages,
      { role: "user", content: [textPart("把图表改暖一点")] },
    ];
    const seenOptions: Array<{ prompt: TestMessage[]; tools: unknown[] }> = [];
    const baseModel = {
      async doGenerate(callOptions: { prompt: TestMessage[]; tools: unknown[] }) {
        seenOptions.push(callOptions);
        return { content: [], finishReason: "stop", usage: {}, warnings: [] };
      },
      async doStream() {
        return { stream: new ReadableStream() };
      },
    };
    const wrapped = wrapModelWithDiagramVizEditing(
      baseModel,
      '<diagram_viz_instruction purpose="edit" languages="mermaid">规范</diagram_viz_instruction>',
    );

    expect(callGuard("session-diagram-tail", "turn", options(prompt)).status)
      .toBe("recorded");
    await wrapped.doGenerate({
      prompt,
      tools: [tool("writeDraft")],
    });

    const injectedOptions = seenOptions[0]!;
    expect(injectedOptions.prompt.filter((message) => message.role === "system"))
      .toEqual(systemMessages);
    expect(injectedOptions.prompt.at(-1)).toMatchObject({ role: "user" });
    expect(JSON.stringify(injectedOptions.prompt.at(-1)?.content))
      .toContain("diagram_viz_instruction");
    expect(callGuard("session-diagram-tail", "turn", injectedOptions).status)
      .toBe("passed");
  });

  it("strict 模式忽略任务清单请求级临时提醒，不把它当历史前缀漂移", () => {
    process.env.QINGAGENT_PREFIX_CACHE_GUARD = "strict";
    const firstPrompt: TestMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: [textPart("第一轮")] },
      { role: "user", content: [textPart("[任务清单状态] 当前清单:1.[待办]补测试。")] },
    ];
    const toolLoopPrompt: TestMessage[] = [
      ...firstPrompt,
      { role: "assistant", content: [textPart("调用工具")] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", result: {} }] },
    ];
    const secondPrompt: TestMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: [textPart("第一轮")] },
      { role: "assistant", content: [textPart("收到")] },
      { role: "user", content: [textPart("第二轮")] },
    ];

    const first = guardContext.run(
      { sessionId: "session-todo-awareness", lineage: "turn", scopeId: "turn-1" },
      () => guardBeforeProviderCall(options(firstPrompt)),
    );
    const toolLoop = guardContext.run(
      { sessionId: "session-todo-awareness", lineage: "turn", scopeId: "turn-1" },
      () => guardBeforeProviderCall(options(toolLoopPrompt)),
    );
    const second = guardContext.run(
      { sessionId: "session-todo-awareness", lineage: "turn", scopeId: "turn-2" },
      () => guardBeforeProviderCall(options(secondPrompt)),
    );

    expect(first.status).toBe("recorded");
    expect(toolLoop.status).toBe("passed");
    expect(second.status).toBe("passed");
  });

  it("strict 模式不再把普通用户段文本变化当作 system 前缀漂移", () => {
    process.env.QINGAGENT_PREFIX_CACHE_GUARD = "strict";
    const firstPrompt: TestMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: [textPart("第一轮提到 [任务清单状态] 这几个字")] },
    ];
    const driftPrompt: TestMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: [textPart("第一轮内容被改写，也提到 [任务清单状态]")] },
    ];

    expect(callGuard("session-todo-awareness-marker-text", "turn", options(firstPrompt)).status)
      .toBe("recorded");
    expect(callGuard("session-todo-awareness-marker-text", "turn", options(driftPrompt)).status)
      .toBe("passed");
  });

  it("turn/resume 双谱系隔离，reset 后首轮只记录", () => {
    process.env.QINGAGENT_PREFIX_CACHE_GUARD = "strict";
    const turnPrompt: TestMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: [textPart("普通轮")] },
    ];
    const resumePrompt: TestMessage[] = [
      { role: "system", content: "sys" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "ask-1", result: {} }] },
    ];
    const nextTurnPrompt: TestMessage[] = [
      ...turnPrompt,
      { role: "assistant", content: [textPart("继续")] },
    ];

    expect(callGuard("session-d", "turn", options(turnPrompt)).status)
      .toBe("recorded");
    expect(callGuard("session-d", "resume", options(resumePrompt)).status)
      .toBe("recorded");
    expect(callGuard("session-d", "turn", options(nextTurnPrompt)).status)
      .toBe("passed");

    guardReset("session-d", "snapshot_lost");
    expect(callGuard("session-d", "turn", options(resumePrompt)).status)
      .toBe("recorded");
  });

  it("同字节重试通过，LRU 只保留最近 200 个 session", () => {
    const prompt: TestMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: [textPart("第一轮")] },
    ];

    callGuard("retry-session", "turn", options(prompt));
    expect(callGuard("retry-session", "turn", options(prompt)).status)
      .toBe("passed");

    for (let index = 0; index < 201; index += 1) {
      callGuard(`lru-${index}`, "turn", options(prompt));
    }

    expect(__getPrefixCacheGuardSizeForTest()).toBe(200);
  });

  it("真实 Mastra Agent 多轮 tool loop 零误报，用户历史增长或改写不触发 system guard", async () => {
    process.env.QINGAGENT_PREFIX_CACHE_GUARD = "strict";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const statuses: string[] = [];
    const agent = createGuardedAgent(statuses);

    await drainGuardedAgent(
      agent,
      [{ role: "user", content: "第一轮" }],
      "real-agent-turn-1",
    );
    await drainGuardedAgent(
      agent,
      [
        { role: "user", content: "第一轮" },
        { role: "assistant", content: "工具完成" },
        { role: "user", content: "第二轮" },
      ],
      "real-agent-turn-2",
    );

    expect(statuses).toEqual(["recorded", "passed", "passed", "passed"]);
    expect(warn).not.toHaveBeenCalled();

    const driftChunks = await drainGuardedAgent(
      agent,
      [
        { role: "user", content: "第一轮被改写" },
        { role: "assistant", content: "工具完成" },
        { role: "user", content: "第二轮" },
        { role: "assistant", content: "工具完成" },
        { role: "user", content: "第三轮" },
      ],
      "real-agent-turn-3",
    );
    expect(driftChunks.find((chunk) => chunk.type === "error")).toBeUndefined();
  });

  it("withPrefixCacheGuardContext return() 会传播到内层并执行清理 finally", async () => {
    let cleanedUp = false;
    async function* inner(): AsyncGenerator<string, void> {
      try {
        yield "frame-1";
        yield "frame-2";
      } finally {
        cleanedUp = true;
      }
    }

    const iterator = withPrefixCacheGuardContext(
      { sessionId: "return-cleanup", lineage: "turn", scopeId: "return-scope" },
      inner,
    );

    expect(await iterator.next()).toEqual({ done: false, value: "frame-1" });
    await iterator.return(undefined);

    expect(cleanedUp).toBe(true);
  });

  it("withPrefixCacheGuardContext throw() 会转发给内层生成器", async () => {
    const error = new Error("cancel stream");
    let received: unknown;
    let cleanedUp = false;
    async function* inner(): AsyncGenerator<string, void> {
      try {
        try {
          yield "frame-1";
        } catch (err) {
          received = err;
          yield "handled";
        }
      } finally {
        cleanedUp = true;
      }
    }

    const iterator = withPrefixCacheGuardContext(
      { sessionId: "throw-cleanup", lineage: "turn", scopeId: "throw-scope" },
      inner,
    );

    expect(await iterator.next()).toEqual({ done: false, value: "frame-1" });
    expect(await iterator.throw(error)).toEqual({ done: false, value: "handled" });
    await iterator.return(undefined);

    expect(received).toBe(error);
    expect(cleanedUp).toBe(true);
  });
});

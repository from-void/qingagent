import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
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

async function collectFrames(
  generator: AsyncGenerator<BridgeFrame, unknown>,
): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of generator) frames.push(frame);
  return frames;
}

function toolResult(toolName: string, toolCallId: string, result: unknown) {
  return {
    type: "tool-result",
    payload: { toolName, toolCallId, args: {}, result },
  };
}

function toolCall(toolName: string, toolCallId: string) {
  return {
    type: "tool-call",
    payload: { toolName, toolCallId, args: {} },
  };
}

function updatedSpec(
  frames: BridgeFrame[],
  toolCallId: string,
): ToolCallSpec | undefined {
  const frame = [...frames].reverse().find(
    (item: BridgeFrame) =>
      item.kind === "toolCallUpdated" &&
      item.data.toolCallId === toolCallId,
  );
  return frame?.kind === "toolCallUpdated" ? frame.data.spec : undefined;
}

describe("agent stream 工具结果契约分类", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      name: "readMaterial 不存在素材",
      toolName: "readMaterial",
      result: {
        text: "[Error] Material not found: missing",
        filename: "",
        wordCount: 0,
      },
    },
    {
      name: "summarizeMaterial 未更新",
      toolName: "summarizeMaterial",
      result: { updated: false },
    },
    {
      name: "parseFile 旧失败形态",
      toolName: "parseFile",
      result: {
        text: "[Error] 文件损坏",
        metadata: { pages: null, wordCount: 0, title: null },
      },
    },
  ])("$name 即使没有 ok:false 也收口为 failed", async ({
    toolName,
    result,
  }) => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const toolCallId = `tool-${toolName}`;
    const frames = await collectFrames(processAgentStream(
      streamOf(
        toolCall(toolName, toolCallId),
        toolResult(toolName, toolCallId, result),
      ),
      {
        state: createSession(`result-status-${toolName}`),
        agentMessageId: "agent-message",
        streamId: "stream-result-status",
        runId: "run-result-status",
      },
    ));

    expect(updatedSpec(frames, toolCallId)?.status.kind).toBe("failed");
  });

  it("普通工具正文含 Error 字样但无失败字段时仍按成功处理", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const frames = await collectFrames(processAgentStream(
      streamOf(
        toolCall("customTool", "tool-custom"),
        toolResult("customTool", "tool-custom", {
          text: "Error budget 是本次分析主题，不是工具错误。",
        }),
      ),
      {
        state: createSession("result-status-generic-success"),
        agentMessageId: "agent-message",
        streamId: "stream-result-status-generic",
        runId: "run-result-status-generic",
      },
    ));

    expect(updatedSpec(frames, "tool-custom")?.status.kind).toBe("done");
  });
});

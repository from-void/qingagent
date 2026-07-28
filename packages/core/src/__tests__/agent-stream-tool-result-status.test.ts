import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";

const observabilityMocks = vi.hoisted(() => ({
  startSpan: vi.fn(),
  end: vi.fn(),
}));

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
  getObservability: () => ({
    getDefaultInstance: () => ({
      startSpan: observabilityMocks.startSpan.mockImplementation(() => ({
        end: observabilityMocks.end,
      })),
    }),
  }),
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

async function executePrefixedBodyTool(
  toolName: "readMaterial" | "parseFile",
  text: string,
): Promise<unknown> {
  if (toolName === "readMaterial") {
    const { createSessionScopedTools } = await import("../session/sessionTools.js");
    const materials = new Map();
    materials.set("material-prefix", {
      id: "material-prefix",
      filename: "正文.txt",
      mimeType: "text/plain",
      text,
      summary: null,
      fileId: null,
      metadata: { pages: null, wordCount: text.length, title: null },
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    });
    const { readMaterial } = createSessionScopedTools(materials);
    return readMaterial.execute!(
      { materialId: "material-prefix", mode: "full" },
      {} as never,
    );
  }

  const previousRuntime = process.env.QINGAGENT_RUNTIME;
  process.env.QINGAGENT_RUNTIME = "desktop";
  try {
    const { parseFileTool } = await import("../tools/parseFile.js");
    return parseFileTool.execute!(
      {
        content: Buffer.from(text).toString("base64"),
        filename: "正文.txt",
        mimeType: "text/plain",
      },
      {} as never,
    );
  } finally {
    if (previousRuntime === undefined) delete process.env.QINGAGENT_RUNTIME;
    else process.env.QINGAGENT_RUNTIME = previousRuntime;
  }
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
      name: "summarizeMaterial 未更新",
      toolName: "summarizeMaterial",
      result: { updated: false },
    },
    {
      name: "parseFile 结构化失败",
      toolName: "parseFile",
      result: {
        ok: false,
        text: "",
        error: "文件损坏",
        failureKind: "error",
        metadata: { pages: null, wordCount: 0, title: null },
      },
    },
  ])("$name 收口为 failed", async ({
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
    expect(observabilityMocks.end).toHaveBeenCalledWith(expect.objectContaining({
      attributes: { success: false },
    }));
  });

  it.each([
    { toolName: "readMaterial" as const, text: "[Error] Material not found: 这是合法素材正文" },
    { toolName: "parseFile" as const, text: "[Error] Material not found: 这是合法文件正文" },
  ])("$toolName 合法正文以旧错误前缀开头仍按成功处理", async ({ toolName, text }) => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const toolCallId = `tool-${toolName}-prefix`;
    const result = await executePrefixedBodyTool(toolName, text);
    const frames = await collectFrames(processAgentStream(
      streamOf(
        toolCall(toolName, toolCallId),
        toolResult(toolName, toolCallId, result),
      ),
      {
        state: createSession(`result-status-${toolName}-prefix-success`),
        agentMessageId: "agent-message",
        streamId: "stream-result-status-generic",
        runId: "run-result-status-generic",
      },
    ));

    expect(updatedSpec(frames, toolCallId)?.status.kind).toBe("done");
  });
});

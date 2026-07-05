import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";

// 桥层回归:工具 execute() 抛错 → AI SDK v5 / Mastra v3 发 tool-error chunk。
// 此前主循环没有 tool-error 分支 → 被静默丢弃 → 该工具 spec 永远停在 running →
// 前端 spinner 不收口。修复后 tool-error 应把对应 spec 收口成 done(前端渲染成完成)。

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

function findToolCallSpec(chatHistory: { parts: { kind: string; data: unknown }[] }[], id: string): ToolCallSpec | null {
  for (const message of chatHistory) {
    for (const part of message.parts) {
      if (part.kind === "toolCall" && (part.data as ToolCallSpec).id === id) {
        return part.data as ToolCallSpec;
      }
    }
  }
  return null;
}

describe("processAgentStream tool-error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tool-error 把已建占位的工具 spec 从 running 收口成 done(spinner 停)", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("tool-error-collapse");

    const { frames } = await collectFramesAndReturn(
      processAgentStream(
        streamOf(
          // 1) 占位卡:spec 进 running
          {
            type: "tool-call-input-streaming-start",
            payload: { toolCallId: "te-1", toolName: "scrapeWithBrowser" },
          },
          // 2) 工具 execute 抛错 → tool-error
          {
            type: "tool-error",
            payload: { toolCallId: "te-1", toolName: "scrapeWithBrowser", error: { message: "boom" } },
          },
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-tool-error",
          runId: "run-tool-error",
        },
      ),
    );

    // chatHistory 里的 spec 必须收口成 done(不再 running),否则前端永远转 spinner
    const spec = findToolCallSpec(state.chatHistory, "te-1");
    expect(spec).not.toBeNull();
    expect(spec?.status.kind).toBe("done");

    // 也应发出一帧 toolCallUpdated(done)让前端实时收口
    const updated = frames.find(
      (f) => f.kind === "toolCallUpdated" && f.data.toolCallId === "te-1",
    ) as Extract<BridgeFrame, { kind: "toolCallUpdated" }> | undefined;
    expect(updated?.data.spec.status.kind).toBe("done");
  });

  it("tool-error 在没有占位卡时也兜底建一张 done 卡(不丢失收口)", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("tool-error-fallback");

    await collectFramesAndReturn(
      processAgentStream(
        streamOf({
          type: "tool-error",
          payload: { toolCallId: "te-2", toolName: "parseFile", error: "网络中断" },
        }),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-tool-error-2",
          runId: "run-tool-error-2",
        },
      ),
    );

    const spec = findToolCallSpec(state.chatHistory, "te-2");
    expect(spec).not.toBeNull();
    expect(spec?.status.kind).toBe("done");
  });
});

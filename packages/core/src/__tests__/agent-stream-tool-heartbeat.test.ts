import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";

// 桥层回归:工具心跳只负责清零 idle 看门狗,不应变成聊天可见帧,
// 也不能被重试守卫当成真实副作用工具活动。

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

describe("processAgentStream tool-heartbeat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tool-output 心跳不产生可见帧,也不标记副作用工具调用", async () => {
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

    expect(frames).toHaveLength(0);
    expect(result.producedVisibleFrame).toBe(false);
    expect(result.sawSideEffectToolCall).toBe(false);
    expect(state.messages).toHaveLength(0);
  });
});

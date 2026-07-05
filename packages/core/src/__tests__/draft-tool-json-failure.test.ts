import { describe, expect, it, vi } from "vitest";
import type { BridgeFrame, LegacySection } from "@qingagent/contract-ts";

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
  qingagentAgent: {
    stream: vi.fn(),
    resumeStream: vi.fn(),
  },
}));

type StreamChunk =
  | {
      type: "tool-call";
      payload: {
        toolName: "editDraft";
        toolCallId: string;
        args: Record<string, unknown>;
      };
    }
  | {
      type: "tool-result";
      payload: {
        toolName: "editDraft";
        toolCallId: string;
        args: Record<string, unknown>;
        result: { ok: false; applied: string[]; error: string };
      };
    }
  | {
      type: "text-delta";
      payload: { text: string };
    };

async function* streamOf(...chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) yield chunk;
}

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function textBodies(frames: BridgeFrame[]): string[] {
  return frames.flatMap((frame) =>
    frame.kind === "chatMessageAppended" && frame.data.part.kind === "text"
      ? [frame.data.part.data.body]
      : [],
  );
}

function draftingFailureReasons(frames: BridgeFrame[]): string[] {
  return frames.flatMap((frame) =>
    frame.kind === "stream" && frame.data.kind === "draftingFailed"
      ? [frame.data.data.reason]
      : [],
  );
}

describe("draft tool JSON failure UX", () => {
  it("editDraft 空参数失败且 0 patch 无正文时给出可操作可重试提示", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("draft-tool-json-failure");
    const originalSections: LegacySection[] = [
      { kind: "p", data: { text: "原文保持不变" } },
    ];
    state.legacySections = originalSections;

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          {
            type: "tool-call",
            payload: { toolName: "editDraft", toolCallId: "edit-bad-json", args: {} },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "editDraft",
              toolCallId: "edit-bad-json",
              args: {},
              result: {
                ok: false,
                applied: [],
                error: "Provided arguments: {}",
              },
            },
          },
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-bad-json",
          runId: "run-bad-json",
        },
      ),
    );

    expect(state.legacySections).toEqual(originalSections);
    expect(textBodies(frames).some((body) => body.includes("不是合法 JSON"))).toBe(true);
    expect(textBodies(frames).some((body) => body.includes("半角双引号必须写成"))).toBe(true);
    expect(draftingFailureReasons(frames)).toHaveLength(1);
    expect(draftingFailureReasons(frames)[0]).toContain("请重试");
  });

  // EE②/SS 回归:模型这一轮既吐了破损 editDraft(解析失败→坍缩成 {}),又写了"已为你加上小标题"
  // 之类正文(accumulatedText 非空)。旧实现因 `!accumulatedText` 前提跳过兜底 → 用户只看到谎称
  // 已改、看不到任何错误。修复后:只要本轮有破损 editDraft 且 0 有效改动,即便有正文也强制发
  // draftingFailed 帧,堵住"谎称已改"。
  it("editDraft 破损参数失败但模型已写正文(谎称已改)时仍强制发 draftingFailed", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("draft-tool-json-failure-with-text");
    const originalSections: LegacySection[] = [
      { kind: "p", data: { text: "原文保持不变" } },
    ];
    state.legacySections = originalSections;

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          {
            type: "tool-call",
            payload: { toolName: "editDraft", toolCallId: "edit-bad-json-2", args: {} },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "editDraft",
              toolCallId: "edit-bad-json-2",
              args: {},
              result: { ok: false, applied: [], error: "Provided arguments: {}" },
            },
          },
          // 模型谎称已改的正文(accumulatedText 非空)
          { type: "text-delta", payload: { text: "已为你加上小标题。" } },
        ),
        {
          state,
          agentMessageId: "agent-msg-2",
          streamId: "stream-bad-json-2",
          runId: "run-bad-json-2",
        },
      ),
    );

    // 草稿没动
    expect(state.legacySections).toEqual(originalSections);
    // 模型谎称已改的正文仍在(不删模型输出)
    expect(textBodies(frames).some((body) => body.includes("已为你加上小标题"))).toBe(true);
    // 关键:即便有正文,失败帧照样发出(堵住"谎称已改")
    expect(draftingFailureReasons(frames)).toHaveLength(1);
    expect(draftingFailureReasons(frames)[0]).toContain("请重试");
    expect(textBodies(frames).some((body) => body.includes("不是合法 JSON"))).toBe(true);
  });
});

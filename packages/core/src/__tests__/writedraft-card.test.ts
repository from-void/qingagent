import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, ToolCallSpec, WriteDraftCardBody } from "@qingagent/contract-ts";

// 写稿小卡片桥层回归:writedraft-progress 流式刷新工具卡(writing/revising/finalizing/failed),
// tool-result 定格 done 卡(最终字数+lengthStatus),不再是静态 loading 药丸。

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

const progress = (over: Partial<WriteDraftCardBody>): WriteDraftCardBody => ({
  title: "测试文档",
  phase: "writing",
  charCount: 0,
  excerpt: null,
  targetLength: 100,
  minLength: 90,
  maxLength: 110,
  revisionCount: 0,
  lengthStatus: null,
  ...over,
});

function cardSpecs(frames: BridgeFrame[], toolCallId: string): ToolCallSpec[] {
  return frames
    .filter((f) => f.kind === "toolCallUpdated")
    .map((f) => (f.data as { toolCallId: string; spec: ToolCallSpec }))
    .filter((d) => d.toolCallId === toolCallId)
    .map((d) => d.spec)
    .filter((s) => s.body.kind === "writeDraftCard");
}

function appendedToolCalls(frames: BridgeFrame[], toolCallId: string): ToolCallSpec[] {
  return frames.flatMap((frame) => {
    if (frame.kind !== "chatMessageAppended") return [];
    const part = frame.data.part;
    if (part.kind !== "toolCall" || part.data.id !== toolCallId) return [];
    return [part.data];
  });
}

describe("写稿小卡片帧协议", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writing→revising 流式刷卡,tool-result 定格 done+lengthStatus", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("wd-card");

    const frames = await collect(
      processAgentStream(
        streamOf(
          {
            type: "tool-call",
            payload: { toolName: "writeDraft", toolCallId: "w1", args: { title: "测试文档", outline: "o", lengthTarget: 100 } },
          },
          {
            type: "tool-output",
            payload: {
              toolCallId: "w1",
              output: {
                type: "writedraft-progress",
                progress: progress({ phase: "writing", charCount: 80, excerpt: "正在写的一段……" }),
              },
            },
          },
          {
            type: "tool-output",
            payload: {
              toolCallId: "w1",
              output: {
                type: "writedraft-progress",
                progress: progress({ phase: "finalizing", charCount: 100, excerpt: "定稿全文摘录" }),
              },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "writeDraft",
              toolCallId: "w1",
              args: { title: "测试文档", outline: "o", lengthTarget: 100 },
              result: {
                ok: true,
                visibleCharCount: 100,
                targetLength: 100,
                minLength: 90,
                maxLength: 110,
                revisionCount: 1,
                lengthStatus: "accepted_after_revision",
              },
            },
          },
        ),
        { state, agentMessageId: "m", streamId: "s-card", runId: "r" },
      ),
    );

    const cards = cardSpecs(frames, "w1");
    expect(cards.length).toBeGreaterThanOrEqual(3);

    const phases = cards.map((c) => (c.body as { data: WriteDraftCardBody }).data.phase);
    expect(phases).toContain("writing");
    expect(phases).toContain("finalizing");

    const final = cards[cards.length - 1]!;
    const finalData = (final.body as { data: WriteDraftCardBody }).data;
    expect(final.status.kind).toBe("done");
    expect(finalData.phase).toBe("done");
    expect(finalData.charCount).toBe(100);
    expect(finalData.charCountApproximate).toBe(false);
    expect(finalData.lengthStatus).toBe("accepted_after_revision");
    expect(finalData.revisionCount).toBe(1);
  });

  it("writeDraft 失败时定格 failed 卡", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("wd-card-fail");

    const frames = await collect(
      processAgentStream(
        streamOf(
          {
            type: "tool-call",
            payload: { toolName: "writeDraft", toolCallId: "w2", args: { title: "失败文档", outline: "o" } },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "writeDraft",
              toolCallId: "w2",
              args: { title: "失败文档", outline: "o" },
              result: {
                ok: false,
                error: "writeDraft 失败: x",
                diagnostic: {
                  failureKind: "unsupported-nested-table",
                  warningKinds: ["unsupported-nested-table"],
                  tagSkeleton: "<table><tr><td><table></table></td></tr></table>",
                  errorLocations: [{ kind: "unsupported-nested-table", startOffset: 15 }],
                },
              },
            },
          },
        ),
        { state, agentMessageId: "m", streamId: "s-card-f", runId: "r" },
      ),
    );

    const cards = cardSpecs(frames, "w2");
    expect(cards.length).toBeGreaterThanOrEqual(1);
    const final = cards[cards.length - 1]!;
    expect(final.status.kind).toBe("failed");
    expect((final.body as { data: WriteDraftCardBody }).data).toMatchObject({
      phase: "failed",
      excerpt: null,
      diagnostic: {
        failureKind: "unsupported-nested-table",
        tagSkeleton: expect.stringContaining("<table>"),
      },
    });
  });

  it("writeDraft failed 进度帧直接收口为 failed 卡", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("wd-card-fail-progress");

    const frames = await collect(
      processAgentStream(
        streamOf({
          type: "tool-output",
          payload: {
            toolCallId: "w-progress-failed",
            output: {
              type: "writedraft-progress",
              progress: progress({ phase: "failed", charCount: 30, excerpt: null }),
            },
          },
        }),
        { state, agentMessageId: "m", streamId: "s-card-fp", runId: "r" },
      ),
    );

    const cards = cardSpecs(frames, "w-progress-failed");
    expect(cards.at(-1)?.status.kind).toBe("failed");
    expect((cards.at(-1)?.body as { data: WriteDraftCardBody } | undefined)?.data.phase).toBe("failed");
  });

  it("GLM/anthropic 缺前置 tool-call 占位时,writedraft-progress 仍补建可渲染卡", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("wd-card-progress-first");

    const frames = await collect(
      processAgentStream(
        streamOf(
          {
            type: "tool-output",
            payload: {
              toolCallId: "w-progress-first",
              output: {
                type: "writedraft-progress",
                progress: progress({ phase: "writing", charCount: 42, excerpt: "先流出正文进度" }),
              },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "writeDraft",
              toolCallId: "w-progress-first",
              args: { title: "测试文档", outline: "o", lengthTarget: 100 },
              result: {
                ok: true,
                visibleCharCount: 100,
                targetLength: 100,
                minLength: 90,
                maxLength: 110,
                revisionCount: 0,
                lengthStatus: "accepted",
              },
            },
          },
        ),
        { state, agentMessageId: "m", streamId: "s-card-progress-first", runId: "r" },
      ),
    );

    const appended = appendedToolCalls(frames, "w-progress-first");
    expect(appended).toHaveLength(1);
    expect(appended[0]?.body.kind).toBe("writeDraftCard");

    const cards = cardSpecs(frames, "w-progress-first");
    expect(cards[0]?.status.kind).toBe("running");
    const final = cards.at(-1)!;
    expect(final.status.kind).toBe("done");
    expect((final.body as { data: WriteDraftCardBody }).data.phase).toBe("done");
  });

  it("GLM/anthropic 只有 tool-result 可见时,writeDraft 结果也会补建卡片 part", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("wd-card-result-first");

    const frames = await collect(
      processAgentStream(
        streamOf({
          type: "tool-result",
          payload: {
            toolName: "writeDraft",
            toolCallId: "w-result-first",
            args: { title: "测试文档", outline: "o", lengthTarget: 100 },
            result: {
              ok: true,
              visibleCharCount: 100,
              targetLength: 100,
              minLength: 90,
              maxLength: 110,
              revisionCount: 0,
              lengthStatus: "accepted",
            },
          },
        }),
        { state, agentMessageId: "m", streamId: "s-card-result-first", runId: "r" },
      ),
    );

    const appended = appendedToolCalls(frames, "w-result-first");
    expect(appended).toHaveLength(1);
    expect(appended[0]?.body.kind).toBe("writeDraftCard");
    expect(appended[0]?.status.kind).toBe("done");
  });
});

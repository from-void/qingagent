import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";

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

function specs(frames: BridgeFrame[], toolCallId: string): ToolCallSpec[] {
  const out: ToolCallSpec[] = [];
  for (const frame of frames) {
    if (frame.kind !== "toolCallUpdated") continue;
    if (frame.data.toolCallId !== toolCallId) continue;
    if (frame.data.spec.body.kind === "generateSvg") out.push(frame.data.spec);
  }
  return out;
}

function draftingFailed(frames: BridgeFrame[]): BridgeFrame[] {
  return frames.filter((f) =>
    f.kind === "stream" && f.data.kind === "draftingFailed"
  );
}

describe("generateSvg 工具卡帧协议", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generatesvg-progress 刷新 running 卡片,携带阶段/耗时/KB", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("svg-card-progress");

    const frames = await collect(
      processAgentStream(
        streamOf(
          {
            type: "tool-call",
            payload: {
              toolName: "generateSvg",
              toolCallId: "svg-1",
              args: { description: "红色方块", aspect: "16:9", style: "简约" },
            },
          },
          {
            type: "tool-output",
            payload: {
              toolCallId: "svg-1",
              output: {
                type: "generatesvg-progress",
                progress: {
                  stage: "streaming",
                  elapsedMs: 1200,
                  rawKb: 1.5,
                  message: "正在生成 SVG 结构",
                  partialSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><g><path d="M0 0L10 10"/><rect width="5" height="5"/><text>安全预览</text></g></svg>`,
                },
              },
            },
          },
        ),
        { state, agentMessageId: "m", streamId: "s-svg-progress", runId: "r" },
      ),
    );

    const cards = specs(frames, "svg-1");
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const streamingCard = cards.find((card) =>
      card.status.kind === "running" &&
      card.body.kind === "generateSvg" &&
      card.body.data.progress?.stage === "streaming"
    );
    const progress = streamingCard?.body.kind === "generateSvg"
      ? streamingCard.body.data.progress
      : null;
    expect(streamingCard?.status.kind).toBe("running");
    expect(progress).toMatchObject({
      stage: "streaming",
      elapsedMs: 1200,
      rawKb: 1.5,
      message: "正在生成 SVG 结构",
    });
    for (const element of ["linearGradient", "<path", "<rect", "<text"]) {
      expect(progress?.partialSvg).toContain(element);
    }
  });

  it("generatesvg-progress 在卡片收口再次消毒 partialSvg", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("svg-card-sanitize");
    const maliciousSvg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">` +
      `<script>alert(1)</script>` +
      `<foreignObject><img src="x" onerror="alert(1)"/></foreignObject>` +
      `<rect width="10" height="10"/>` +
      `</svg>`;

    const frames = await collect(
      processAgentStream(
        streamOf(
          {
            type: "tool-call",
            payload: {
              toolName: "webSearch",
              toolCallId: "forged-svg-progress",
              args: { query: "untrusted progress" },
            },
          },
          {
            type: "tool-output",
            payload: {
              toolCallId: "forged-svg-progress",
              output: {
                type: "generatesvg-progress",
                progress: { stage: "streaming", partialSvg: maliciousSvg },
              },
            },
          },
        ),
        { state, agentMessageId: "m", streamId: "s-svg-sanitize", runId: "r" },
      ),
    );

    const progress = specs(frames, "forged-svg-progress").at(-1)?.body;
    const partialSvg = progress?.kind === "generateSvg" ? progress.data.progress?.partialSvg : null;
    expect(partialSvg).toMatch(/<rect/i);
    expect(partialSvg).not.toMatch(/onload|onerror|<script|<foreignObject/i);
  });

  it("失败只定格 generateSvg 工具卡,不发 draftingFailed", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("svg-card-fail");

    const frames = await collect(
      processAgentStream(
        streamOf(
          {
            type: "tool-call",
            payload: {
              toolName: "generateSvg",
              toolCallId: "svg-2",
              args: { description: "复杂海报", aspect: "16:9" },
            },
          },
          {
            type: "tool-output",
            payload: {
              toolCallId: "svg-2",
              output: {
                type: "generatesvg-progress",
                progress: {
                  stage: "streaming",
                  elapsedMs: 8000,
                  rawKb: 2.2,
                  message: "正在生成 SVG 结构",
                },
              },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "generateSvg",
              toolCallId: "svg-2",
              args: { description: "复杂海报", aspect: "16:9" },
              result: {
                ok: false,
                error: "SVG 生成超过 30 秒已停止，请用更简洁的配图描述。",
              },
            },
          },
        ),
        { state, agentMessageId: "m", streamId: "s-svg-fail", runId: "r" },
      ),
    );

    const final = specs(frames, "svg-2").at(-1);
    expect(final?.status.kind).toBe("failed");
    expect(final?.status.kind === "failed" ? final.status.data.retriable : null).toBe(false);
    expect(final?.body.kind === "generateSvg" ? final.body.data.progress?.stage : null).toBe("failed");
    expect(final?.body.kind === "generateSvg" ? final.body.data.progress?.rawKb : null).toBe(2.2);
    expect(draftingFailed(frames)).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";

// 抓取卡片可见性回归:抓取成功必出一张卡——有截图/og图走图片卡,
// 无图(站点没配 og:image)或图片下载失败降级为文字卡(src=null),
// 不再因为图片这个硬条件静默消失(用户无法对账"N 个链接抓回来没有")。

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

const toolCall = (toolName: string, toolCallId: string, args: Record<string, unknown>) => ({
  type: "tool-call",
  payload: { toolName, toolCallId, args },
});
const toolResult = (
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
) => ({ type: "tool-result", payload: { toolName, toolCallId, args, result } });

type CardData = { src: string | null; sourceUrl: string | null; label: string };
function imageParts(frames: BridgeFrame[]): CardData[] {
  return frames
    .filter((f) => f.kind === "chatMessageAppended")
    .map((f) => (f.data as unknown as { part: { kind: string; data: CardData } }).part)
    .filter((p) => p.kind === "image")
    .map((p) => p.data);
}

describe("抓取卡片:成功必出卡", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("无截图无 og:image 的抓取也出卡——src=null 的简化文字卡,带标题和原链接", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("card-noimg");

    const frames = await collect(
      processAgentStream(
        streamOf(
          toolCall("fetchArticle", "f1", { url: "https://no-og.example.com/post" }),
          toolResult("fetchArticle", "f1", { url: "https://no-og.example.com/post" }, {
            text: "正文内容。".repeat(30),
            title: "没有预览图的文章",
            sourceUrl: "https://no-og.example.com/post",
            screenshotBase64: null,
            ogImageUrl: null,
          }),
        ),
        { state, agentMessageId: "m", streamId: "s1", runId: "r" },
      ),
    );

    const cards = imageParts(frames);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.src).toBeNull();
    expect(cards[0]?.label).toBe("没有预览图的文章");
    expect(cards[0]?.sourceUrl).toBe("https://no-og.example.com/post");
  });

  it("抓取失败([Error] 正文)不出卡", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("card-err");

    const frames = await collect(
      processAgentStream(
        streamOf(
          toolCall("fetchArticle", "f1", { url: "https://dead.example.com" }),
          toolResult("fetchArticle", "f1", { url: "https://dead.example.com" }, {
            text: "[Error] fetch failed",
            title: "抓取失败",
            sourceUrl: "https://dead.example.com",
            screenshotBase64: null,
            ogImageUrl: null,
          }),
        ),
        { state, agentMessageId: "m", streamId: "s2", runId: "r" },
      ),
    );

    expect(imageParts(frames)).toHaveLength(0);
  });

  it("有截图仍走图片卡(原行为不回归)", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("card-shot");
    const shot = Buffer.from("fake-jpeg-bytes").toString("base64");

    const frames = await collect(
      processAgentStream(
        streamOf(
          toolCall("scrapeWithBrowser", "f1", { url: "https://shot.example.com" }),
          toolResult("scrapeWithBrowser", "f1", { url: "https://shot.example.com" }, {
            text: "正文。".repeat(30),
            title: "带截图的文章",
            sourceUrl: "https://shot.example.com",
            screenshotBase64: shot,
            ogImageUrl: null,
          }),
        ),
        { state, agentMessageId: "m", streamId: "s3", runId: "r" },
      ),
    );

    const cards = imageParts(frames);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.src).toMatch(/^\/api\/v1\/files\//);
  });
});

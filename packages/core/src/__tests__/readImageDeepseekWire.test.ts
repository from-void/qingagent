import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { RequestContext } from "@mastra/core/request-context";

const resolveImageInputMock = vi.hoisted(() => vi.fn());

vi.mock("../tools/imageInput.js", async (importActual) => {
  const actual = await importActual<typeof import("../tools/imageInput.js")>();
  return { ...actual, resolveImageInput: resolveImageInputMock };
});

const { readImageTool } = await import("../tools/readImage.js");

function streamResponse(): Response {
  const chunks = [
    {
      id: "chatcmpl-vision",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash-vision-exp",
      choices: [{ index: 0, delta: { role: "assistant", content: "识别成功" }, finish_reason: null }],
    },
    {
      id: "chatcmpl-vision",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash-vision-exp",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
  ];
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("readImage DeepSeek Files wire", () => {
  beforeEach(() => {
    resolveImageInputMock.mockReset();
    resolveImageInputMock.mockResolvedValue({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("真实 streamText 保留哨兵 URL 到 provider wire，并最终改写为 file part", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === "https://api.deepseek.com/v1/files") {
        return Response.json({
          id: "file-api-wire-123",
          bytes: 4,
          created_at: 1,
          filename: "image.png",
          purpose: "user_data",
          expires_at: Math.floor(Date.now() / 1000) + 604_800,
        });
      }
      if (url === "https://api.deepseek.com/v1/chat/completions") return streamResponse();
      throw new Error(`不应下载哨兵 URL: ${url}`);
    }));
    const requestContext = new RequestContext([["modelOverrides", {
      provider: "deepseek",
      visitorApiKey: "sk-wire-integration",
    }]] as never) as unknown as RequestContext;

    const result = await readImageTool.execute!(
      { image: "wire-image", prompt: "描述", includeConversation: false },
      { requestContext } as never,
    );

    expect(result).toMatchObject({ ok: true, text: "识别成功" });
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.deepseek.com/v1/files",
      "https://api.deepseek.com/v1/chat/completions",
    ]);
    const chatBody = JSON.parse(String(requests[1]?.init?.body)) as {
      messages: Array<{ content: unknown[] }>;
    };
    expect(chatBody.messages[0]?.content).toEqual([
      { type: "text", text: "描述" },
      { type: "file", file_id: "file-api-wire-123" },
    ]);
  });
});

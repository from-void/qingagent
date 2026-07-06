import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callDeepseekDraft, deepseekDraftClientInternals } from "../tools/deepseekDraftClient.js";

const originalDeepseekApiKey = process.env.DEEPSEEK_API_KEY;

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200 });
}

describe("deepseekDraftClient", () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalDeepseekApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalDeepseekApiKey;
  });

  it("OpenAI 请求体优先复用完整 messages", () => {
    const messages = [
      { role: "system" as const, content: "母对话 system" },
      { role: "user" as const, content: "用户原文" },
      { role: "assistant" as const, content: "助手原文" },
      { role: "user" as const, content: "尾部薄指令 json" },
    ];

    const body = deepseekDraftClientInternals.buildRequestBody({
      system: "fallback system",
      user: "fallback user",
      messages,
      thinking: false,
      temperature: 0.4,
      stream: false,
    });

    expect(body.messages).toBe(messages);
    expect(body).toMatchObject({
      thinking: { type: "disabled" },
      temperature: 0.4,
      stream: false,
    });
    expect(body).not.toHaveProperty("response_format");
  });

  it("Anthropic 请求体保留 V4 messages 上下文", () => {
    const body = deepseekDraftClientInternals.buildAnthropicBody({
      system: "fallback system",
      user: "fallback user",
      messages: [
        { role: "system", content: "母对话 system" },
        { role: "user", content: "用户原文" },
        { role: "assistant", content: "助手原文" },
        { role: "user", content: "尾部薄指令 json" },
      ],
      thinking: false,
      temperature: 0.4,
      stream: false,
      protocol: "anthropic",
    });

    expect(body).toMatchObject({
      system: "母对话 system",
      messages: [
        { role: "user", content: "用户原文" },
        { role: "assistant", content: "助手原文" },
        { role: "user", content: "尾部薄指令 json" },
      ],
      temperature: 0.4,
      stream: false,
    });
  });

  it("流式 SSE 坏 data 行只跳过,正常增量继续拼接", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => sseResponse([
      "\n\n",
      "data:\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n",
      "data: {坏 JSON\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n",
      "data: [DONE]\n\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];
    const raws: string[] = [];
    const starts: number[] = [];

    const result = await callDeepseekDraft({
      system: "sys",
      user: "user",
      thinking: false,
      temperature: 0.4,
      stream: true,
      maxRetries: 0,
      onContentStart: (elapsedMs) => starts.push(elapsedMs),
      onContentDelta: (delta, raw) => {
        deltas.push(delta);
        raws.push(raw);
      },
    });

    expect(result.raw).toBe("你好");
    expect(result.contentStartMs).toEqual(expect.any(Number));
    expect(deltas).toEqual(["你", "好"]);
    expect(raws).toEqual(["你", "你好"]);
    expect(starts).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("跳过无法解析");
  });

  it("stream:true 收到普通 JSON 响应时按一次完整 delta 回退解析", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        choices: [{
          message: { content: "完整正文" },
          finish_reason: "stop",
        }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];
    const raws: string[] = [];

    const result = await callDeepseekDraft({
      system: "sys",
      user: "user",
      thinking: false,
      temperature: 0.4,
      stream: true,
      maxRetries: 0,
      onContentDelta: (delta, raw) => {
        deltas.push(delta);
        raws.push(raw);
      },
    });

    expect(result).toMatchObject({ raw: "完整正文", finishReason: "stop" });
    expect(result.contentStartMs).toEqual(expect.any(Number));
    expect(deltas).toEqual(["完整正文"]);
    expect(raws).toEqual(["完整正文"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = calls[0]![1].body as string;
    expect(JSON.parse(body)).toMatchObject({ stream: true });
  });

  it("OpenAI 兼容端点 stream 参数 400 时仅该次调用降级重试非流式", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 400 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          choices: [{
            message: { content: "非流式正文" },
            finish_reason: "stop",
          }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];

    const result = await callDeepseekDraft({
      system: "sys",
      user: "user",
      thinking: false,
      temperature: 0.4,
      stream: true,
      maxRetries: 0,
      baseUrl: "https://proxy.example.com/v1",
      onContentDelta: (delta) => deltas.push(delta),
    });

    expect(result.raw).toBe("非流式正文");
    expect(deltas).toEqual(["非流式正文"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const firstBody = calls[0]![1].body as string;
    const secondBody = calls[1]![1].body as string;
    expect(JSON.parse(firstBody)).toMatchObject({ stream: true });
    expect(JSON.parse(secondBody)).toMatchObject({ stream: false });
  });

  it("OpenAI 兼容上游错误不把响应体里的 key 塞进 Error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        "Authorization: Bearer sk-live-openai-secret x-api-key: sk-live-header-secret 请求体很长",
        { status: 401 },
      )),
    );

    let error: unknown;
    try {
      await callDeepseekDraft({
        system: "sys",
        user: "user",
        thinking: false,
        temperature: 0.4,
        stream: false,
        maxRetries: 0,
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toBe("DeepSeek upstream HTTP 401");
    expect(message).not.toContain("sk-live-openai-secret");
    expect(message).not.toContain("sk-live-header-secret");
    expect(message).not.toContain("Authorization");
  });

  it("Anthropic 兼容上游错误不把响应体里的 x-api-key 泄漏到 Error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        JSON.stringify({ error: { message: "x-api-key: sk-live-anthropic-secret" } }),
        { status: 403 },
      )),
    );

    let error: unknown;
    try {
      await callDeepseekDraft({
        system: "sys",
        user: "user",
        thinking: false,
        temperature: 0.4,
        stream: false,
        maxRetries: 0,
        protocol: "anthropic",
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toBe("Anthropic upstream HTTP 403");
    expect(message).not.toContain("sk-live-anthropic-secret");
    expect(message).not.toContain("x-api-key");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callDeepseekDraft,
  deepseekDraftClientInternals,
  type DeepseekDraftAttempt,
} from "../tools/deepseekDraftClient.js";
import { recordUsageEvent } from "../db/usageRepo.js";
import { getDocumentsClient } from "../db/documentsClient.js";
import { __resetMigrationsForTest } from "../db/migrations.js";
import {
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "../db/__tests__/dbTestUtils.js";

const originalDeepseekApiKey = process.env.DEEPSEEK_API_KEY;
let tempDb: TempDocumentsDb;

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
    __resetMigrationsForTest();
    tempDb = prepareTempDocumentsDb("deepseek-draft-usage-");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    __resetMigrationsForTest();
    tempDb.cleanup();
    if (originalDeepseekApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalDeepseekApiKey;
  });

  const recordAttempt = (attempt: DeepseekDraftAttempt) => recordUsageEvent({
    sessionId: "session-usage",
    runId: "run-usage",
    callSite: "writeDraft",
    modelId: "test-model",
    keyOrigin: "env",
    inputTokens: attempt.inputTokens,
    outputTokens: attempt.outputTokens,
    cacheHitTokens: attempt.cacheHitTokens,
    cacheMissTokens: attempt.cacheMissTokens,
    cacheCreationTokens: attempt.cacheCreationTokens,
    usageState: attempt.usageState,
    reason: attempt.reason,
    lane: 2,
    attempt: attempt.attempt,
  });

  async function usageRows(): Promise<Array<Record<string, unknown>>> {
    const result = await getDocumentsClient().execute(
      "SELECT * FROM llm_usage_events ORDER BY attempt",
    );
    return result.rows as unknown as Array<Record<string, unknown>>;
  }

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

  it("OpenAI 正常末帧 usage 按 lane/attempt 入账", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"正文"},"finish_reason":null}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_cache_hit_tokens":60,"prompt_cache_miss_tokens":40}}\n\n',
      "data: [DONE]\n\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);

    await callDeepseekDraft({
      system: "sys",
      user: "user",
      thinking: false,
      temperature: 0.4,
      stream: true,
      maxRetries: 0,
      onAttemptComplete: recordAttempt,
    });

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      usage_state: "recorded",
      lane: 2,
      attempt: 1,
      input_tokens: 100,
      output_tokens: 20,
      cache_hit_tokens: 60,
      cache_miss_tokens: 40,
    });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(String(calls[0]![1].body));
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("Anthropic message_start/message_delta 合并 usage 并分列 creation cache", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":90,"cache_read_input_tokens":50,"cache_creation_input_tokens":12}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"GLM 正文"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":18}}\n\n',
    ])));

    await callDeepseekDraft({
      system: "sys",
      user: "user",
      thinking: false,
      temperature: 0.4,
      stream: true,
      protocol: "anthropic",
      maxRetries: 0,
      onAttemptComplete: recordAttempt,
    });

    expect((await usageRows())[0]).toMatchObject({
      usage_state: "recorded",
      input_tokens: 90,
      output_tokens: 18,
      cache_hit_tokens: 50,
      cache_miss_tokens: 90,
      cache_creation_tokens: 12,
    });
  });

  it("代理吞掉 usage 时保留全零 missing 事件", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"正文"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ])));

    await callDeepseekDraft({
      system: "sys", user: "user", thinking: false, temperature: 0.4,
      stream: true, maxRetries: 0, onAttemptComplete: recordAttempt,
    });

    expect((await usageRows())[0]).toMatchObject({
      usage_state: "missing",
      reason: "provider_usage_unavailable",
      input_tokens: 0,
      output_tokens: 0,
      attempt: 1,
    });
  });

  it("abort 的真实请求入账 missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    }));

    await expect(callDeepseekDraft({
      system: "sys", user: "user", thinking: false, temperature: 0.4,
      stream: true, maxRetries: 2, onAttemptComplete: recordAttempt,
    })).rejects.toMatchObject({ name: "AbortError" });

    expect((await usageRows())[0]).toMatchObject({
      usage_state: "missing",
      reason: "aborted",
      attempt: 1,
    });
  });

  it("非流式 fallback 的两次真实请求分别入账", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "fallback" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 30, completion_tokens: 8 },
      }), { status: 200 })));

    await callDeepseekDraft({
      system: "sys", user: "user", thinking: false, temperature: 0.4,
      stream: true, maxRetries: 0, onAttemptComplete: recordAttempt,
    });

    expect(await usageRows()).toMatchObject([
      { usage_state: "missing", reason: "http_400", attempt: 1 },
      { usage_state: "recorded", input_tokens: 30, output_tokens: 8, attempt: 2 },
    ]);
  });

  it("重试的失败与成功请求都入账且 attempt 连续", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":22,"completion_tokens":4}}\n\n',
      ])));

    await callDeepseekDraft({
      system: "sys", user: "user", thinking: false, temperature: 0.4,
      stream: true, maxRetries: 1, onAttemptComplete: recordAttempt,
    });

    expect(await usageRows()).toMatchObject([
      { usage_state: "missing", reason: "http_500", attempt: 1 },
      { usage_state: "recorded", input_tokens: 22, output_tokens: 4, attempt: 2 },
    ]);
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

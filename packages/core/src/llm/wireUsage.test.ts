import { describe, expect, it, vi } from "vitest";
import { afterEach } from "vitest";
import { modelFetch } from "./modelTransport.js";
import {
  claimWireScopeFinalization,
  createWireScope,
  observeWireResponse,
  WireUsageParser,
  type WireAttempt,
  wireUsageStorage,
} from "./wireUsage.js";

afterEach(() => vi.unstubAllGlobals());

function attempt(): WireAttempt {
  return {
    wireAttemptSeq: 1,
    startedAt: Date.now(),
    requestEstimate: { uncachedInputText: "prompt" },
    responseStatus: null,
    responseReceivedAt: null,
    endedAt: null,
    usage: null,
    outputText: "",
    parseStoppedReason: null,
    transportError: null,
  };
}

function pushText(parser: WireUsageParser, text: string): void {
  parser.push(new TextEncoder().encode(text));
}

describe("WireUsageParser", () => {
  it("兼容 CRLF、注释、多行 data、[DONE]、多 choice 与 tool delta", () => {
    const target = attempt();
    const parser = new WireUsageParser(target, "text/event-stream");
    pushText(parser, ": keep-alive\r\n\r\n");
    pushText(parser, "data: {\"choices\":[{\"delta\":{\"content\":\"甲\"}},{\"delta\":{\"content\":\"乙\",\"tool_calls\":[{\"function\":{\"arguments\":\"{\\\"x\\\":\"}}]}}],\r\n");
    pushText(parser, "data: \"usage\":{\"prompt_tokens\":11,\"completion_tokens\":7,\"prompt_tokens_details\":{\"cached_tokens\":3}}}\r\n\r\n");
    pushText(parser, "data: [DONE]\r\n\r\n");
    parser.finish();

    expect(target.outputText).toBe("甲乙{\"x\":");
    expect(target.usage).toEqual({
      completeness: "complete",
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    });
  });

  it("Anthropic 只有 message_start 或未到 message_stop 时保持 partial-input", () => {
    const target = attempt();
    const parser = new WireUsageParser(target, "text/event-stream");
    pushText(parser, 'data: {"type":"message_start","message":{"usage":{"input_tokens":23,"cache_read_input_tokens":9}}}\n\n');
    pushText(parser, 'data: {"type":"message_delta","usage":{"output_tokens":4}}\n\n');
    parser.finish();

    expect(target.usage).toEqual({
      completeness: "partial-input",
      usage: { input_tokens: 23, cache_read_input_tokens: 9 },
    });
  });

  it("Anthropic 合并 start 输入与末个 delta 输出且 stop 后才 complete", () => {
    const target = attempt();
    const parser = new WireUsageParser(target, "text/event-stream");
    pushText(parser, 'data: {"type":"message_start","message":{"usage":{"input_tokens":31,"cache_creation_input_tokens":6}}}\n\n');
    pushText(parser, 'data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n');
    pushText(parser, 'data: {"type":"message_delta","usage":{"output_tokens":8}}\n\n');
    pushText(parser, 'data: {"type":"message_stop"}\n\n');

    expect(target.usage).toEqual({
      completeness: "complete",
      usage: { input_tokens: 31, cache_creation_input_tokens: 6, output_tokens: 8 },
    });
  });

  it("非流 JSON 整包 usage 记 complete 并提取正文", () => {
    const target = attempt();
    const parser = new WireUsageParser(target, "application/json");
    pushText(parser, JSON.stringify({
      choices: [{ message: { content: "完整回答" } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }));
    parser.finish();
    expect(target.usage?.completeness).toBe("complete");
    expect(target.outputText).toBe("完整回答");
  });

  it("TextDecoder 跨 chunk 保留非 ASCII UTF-8 字符", async () => {
    const scope = createWireScope({ onFinalizeTimeout: vi.fn() });
    const target = attempt();
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"汉"}}]}\n\ndata: [DONE]\n\n');
    const split = bytes.indexOf(0xe6) + 1;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    const response = observeWireResponse(scope, target, new Response(source, {
      headers: { "content-type": "text/event-stream" },
    }));
    await response.text();
    expect(target.outputText).toBe("汉");
  });

  it("单帧或总量超界只停解析，不截断下游响应", async () => {
    const scope = createWireScope({ onFinalizeTimeout: vi.fn() });
    const frameTarget = attempt();
    const frameBody = `data: ${"x".repeat(40)}\n\n尾部`;
    const frameResponse = observeWireResponse(
      scope,
      frameTarget,
      new Response(frameBody, { headers: { "content-type": "text/event-stream" } }),
      { maxFrameBytes: 16, maxTotalBytes: 1024 },
    );
    expect(await frameResponse.text()).toBe(frameBody);
    expect(frameTarget.parseStoppedReason).toBe("frame_limit");

    const totalTarget = attempt();
    const totalBody = "z".repeat(80);
    const totalResponse = observeWireResponse(
      scope,
      totalTarget,
      new Response(totalBody, { headers: { "content-type": "application/json" } }),
      { maxFrameBytes: 1024, maxTotalBytes: 32 },
    );
    expect(await totalResponse.text()).toBe(totalBody);
    expect(totalTarget.parseStoppedReason).toBe("total_limit");
  });
});

describe("wire scope finalizeOnce", () => {
  it("响应头到达即 arm，不读取也会超时，迟到终态无法二次 claim", async () => {
    vi.useFakeTimers();
    try {
      const timeout = vi.fn();
      const scope = createWireScope({ onFinalizeTimeout: timeout, idleTimeoutMs: 25 });
      const target = attempt();
      observeWireResponse(scope, target, new Response(new ReadableStream<Uint8Array>({
        pull() {
          // 永远没有第一个 chunk。
        },
      }), { headers: { "content-type": "text/event-stream" } }));

      await vi.advanceTimersByTimeAsync(25);
      expect(timeout).toHaveBeenCalledOnce();
      expect(claimWireScopeFinalization(scope)).toBe(true);
      expect(claimWireScopeFinalization(scope)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("同毫秒 branch/fallback、并发工具和缓存 Anthropic provider 在 ALS 返回后逆序消费仍零串账", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const id = (JSON.parse(String(init?.body)) as { id: string }).id;
      const index = ["branch", "fallback", "tool-a", "tool-b"].indexOf(id) + 1;
      const usage = { input_tokens: index * 101, output_tokens: index * 11 };
      return new Response([
        `data: ${JSON.stringify({ type: "message_start", message: { usage } })}`,
        `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: usage.output_tokens } })}`,
        `data: ${JSON.stringify({ type: "message_stop" })}`,
        "",
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    }));
    // 模拟 qingagent.ts 按 key 缓存、跨 requestContext 复用的 provider 实例。
    const cachedProvider = {
      request: (id: string) => modelFetch("https://example.com/anthropic/v1/messages", {
        method: "POST",
        body: JSON.stringify({ id, messages: [{ role: "user", content: id }] }),
      }),
    };
    const ids = ["branch", "fallback", "tool-a", "tool-b"];
    const scopes = ids.map(() => createWireScope({ onFinalizeTimeout: vi.fn() }));
    const responses = await Promise.all(ids.map((id, index) =>
      wireUsageStorage.run(scopes[index]!, () => cachedProvider.request(id))
    ));

    // 所有 als.run 均已返回；故意逆序消费，禁止回调阶段重新 getStore 配对。
    for (const response of [...responses].reverse()) await response.text();
    expect(scopes.map((scope) => scope.attempts[0]?.usage)).toEqual(ids.map((_id, index) => ({
      completeness: "complete",
      usage: { input_tokens: (index + 1) * 101, output_tokens: (index + 1) * 11 },
    })));
  });
});

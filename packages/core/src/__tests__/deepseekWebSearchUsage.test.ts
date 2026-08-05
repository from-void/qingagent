import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recordUsageEventMock = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>) => undefined),
);
vi.mock("@qingagent/db", () => ({
  resolveDbUrl: () => "file::memory:",
  recordUsageEvent: recordUsageEventMock,
}));
const { fetchDeepseekSearchLinks } = await import("../search/deepseekWebSearch.js");

describe("DeepSeek webSearch usage 留痕", () => {
  beforeEach(() => recordUsageEventMock.mockClear());
  afterEach(() => vi.unstubAllGlobals());

  it("拿到搜索链接后主动掐流，以 prompt 与已收 delta 记 estimated", async () => {
    const events = [
      { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", content: [
        { type: "web_search_result", title: "来源", url: "https://example.com/a" },
      ] } },
      { type: "content_block_stop", index: 1 },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));

    await expect(fetchDeepseekSearchLinks("查询", "key", 3, "deepseek-v4-flash", {
      sessionId: "session-search",
      runId: "run-search",
      keyOrigin: "visitor",
    })).resolves.toHaveLength(1);
    expect(recordUsageEventMock).toHaveBeenCalledOnce();
    expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      callSite: "webSearch",
      usageState: "estimated",
      reason: "search_links_early_abort",
      sessionId: "session-search",
      cacheAccountingState: "known",
    }));
    const event = recordUsageEventMock.mock.calls[0]?.[0] as {
      inputTokens?: number;
      outputTokens?: number;
      cacheHitTokens?: number;
      cacheMissTokens?: number;
    };
    expect(event.inputTokens).toBeGreaterThan(0);
    expect(event.outputTokens).toBeGreaterThan(0);
    expect(event.cacheHitTokens).toBe(0);
    expect(event.cacheMissTokens).toBe(event.inputTokens);
  });

  it("provider 请求异常同样留 missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(fetchDeepseekSearchLinks("查询", "key", 3, "deepseek-v4-flash", {
      sessionId: "session-search",
      keyOrigin: "env",
    })).resolves.toEqual([]);
    expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      usageState: "missing",
      reason: "provider_request_error",
    }));
  });

  it("把外部 signal 的 abort 和 reason 传给内部 fetch controller", async () => {
    let requestSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (requestSignal?.aborted) {
          reject(requestSignal.reason);
          return;
        }
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
      });
    }));
    const controller = new AbortController();
    const reason = new DOMException("webSearch timed out", "TimeoutError");

    const pending = fetchDeepseekSearchLinks(
      "查询",
      "key",
      3,
      "deepseek-v4-flash",
      { sessionId: "session-search", keyOrigin: "visitor" },
      controller.signal,
    );
    controller.abort(reason);

    await expect(pending).resolves.toEqual([]);
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toBe(reason);
    expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      reason: "provider_request_aborted",
    }));
  });
});

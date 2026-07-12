import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recordUsageEventMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@qingagent/db", () => ({ recordUsageEvent: recordUsageEventMock }));
const { fetchDeepseekSearchLinks } = await import("../search/deepseekWebSearch.js");

describe("DeepSeek webSearch usage 留痕", () => {
  beforeEach(() => recordUsageEventMock.mockClear());
  afterEach(() => vi.unstubAllGlobals());

  it("拿到搜索链接后主动掐流，记 missing 而不伪造 token", async () => {
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
      usageState: "missing",
      reason: "search_links_early_abort",
      sessionId: "session-search",
    }));
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
});

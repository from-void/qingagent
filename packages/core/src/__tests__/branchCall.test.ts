import { RequestContext } from "@mastra/core/request-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ recordUsageEvent: vi.fn() }));
vi.mock("../db/usageRepo.js", () => ({ recordUsageEvent: mocks.recordUsageEvent }));

import {
  advanceSessionSnapshotEpoch,
  beginSessionSnapshotTurn,
  branchCall,
  clearSessionSnapshot,
  createSnapshottingQingagentModel,
  getSessionSnapshot,
  normalizeReplayMessages,
} from "../llm/modelConfig.js";

const originalApiKey = process.env.DEEPSEEK_API_KEY;

function context(sessionId: string, streamId: string): RequestContext {
  return new RequestContext([
    ["sessionId", sessionId],
    ["streamId", streamId],
    ["runId", `run-${streamId}`],
  ] as never) as RequestContext;
}

function emptySse(): Response {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function triggerProviderFetch(requestContext: RequestContext, marker: string): Promise<void> {
  const model = createSnapshottingQingagentModel(requestContext);
  await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: marker }] }],
    tools: [{
      type: "function",
      name: "planDraft",
      description: "test tool",
      inputSchema: { type: "object", properties: {} },
    }],
    toolChoice: { type: "auto" },
  } as never);
}

function jsonResponse(message: Record<string, unknown>, usage: Record<string, number>): Response {
  return Response.json({
    id: "branch-test",
    model: "deepseek-v4-flash",
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
    usage,
  });
}

describe("BranchCall provider 快照与 raw 回放", () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "sk-branch-call-test";
    mocks.recordUsageEvent.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalApiKey;
    for (const id of ["snapshot-basic", "snapshot-race", "snapshot-schema", "snapshot-lease", "snapshot-aba", "branch-success", "branch-tool", "branch-sse", "branch-ledger", "branch-abort", "branch-inflight", "branch-callback-race", "branch-http-error", "branch-parse-error"]) {
      clearSessionSnapshot(id);
    }
  });

  it("只在已领取 generation 的主链 fetch 边界留快照，且不保存授权头", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => emptySse());
    vi.stubGlobal("fetch", fetchMock);
    const requestContext = context("snapshot-basic", "stream-a");

    await triggerProviderFetch(requestContext, "before-begin");
    expect(getSessionSnapshot(requestContext)).toBeNull();

    beginSessionSnapshotTurn(requestContext);
    await triggerProviderFetch(requestContext, "after-begin");
    const snapshot = getSessionSnapshot(requestContext);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.streamId).toBe("stream-a");
    expect(snapshot?.safeHeaders.authorization).toBeUndefined();
    expect(snapshot?.bodyText).not.toContain("sk-branch-call-test");
    const body = JSON.parse(snapshot!.bodyText);
    expect(body.tools[0].function.name).toBe("planDraft");
    expect(body.tool_choice).toBe("auto");
  });

  it("同会话旧 turn 的迟到 fetch 不能覆盖新 generation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => emptySse()));
    const oldContext = context("snapshot-race", "stream-old");
    const newContext = context("snapshot-race", "stream-new");
    beginSessionSnapshotTurn(oldContext);
    beginSessionSnapshotTurn(newContext);

    await triggerProviderFetch(oldContext, "stale");
    expect(getSessionSnapshot("snapshot-race")).toBeNull();
    await triggerProviderFetch(newContext, "fresh");
    const snapshot = getSessionSnapshot("snapshot-race");
    expect(snapshot?.streamId).toBe("stream-new");
    expect(snapshot?.bodyText).toContain("fresh");
    expect(snapshot?.bodyText).not.toContain("stale");
    expect(getSessionSnapshot(oldContext)).toBeNull();
    const fetchMock = vi.mocked(globalThis.fetch);
    const staleReplay = await branchCall({
      sessionSnapshot: snapshot!,
      steeringTail: "旧 turn 不得借用新快照",
      callSite: "planDraft",
      requestContext: oldContext,
    });
    expect(staleReplay).toEqual({
      ok: false,
      reason: "stale_snapshot",
      attempts: 0,
      toolCallRetries: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("新主轮领取 lease 后，旧快照立即失效且不能发 raw 请求", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => emptySse());
    vi.stubGlobal("fetch", fetchMock);
    const oldContext = context("snapshot-lease", "stream-old");
    beginSessionSnapshotTurn(oldContext);
    await triggerProviderFetch(oldContext, "old-prefix");
    const oldSnapshot = getSessionSnapshot(oldContext)!;

    const newContext = context("snapshot-lease", "stream-new");
    beginSessionSnapshotTurn(newContext);
    expect(getSessionSnapshot("snapshot-lease")).toBeNull();
    await expect(branchCall({
      sessionSnapshot: oldSnapshot,
      steeringTail: "不得回放",
      callSite: "writeDraft",
      requestContext: oldContext,
    })).resolves.toMatchObject({ reason: "stale_snapshot", attempts: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("OM 压缩边界推进 epoch 后未来主干不再取得旧快照", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => emptySse()));
    const requestContext = context("snapshot-lease", "stream-epoch");
    beginSessionSnapshotTurn(requestContext);
    await triggerProviderFetch(requestContext, "epoch-zero");
    expect(getSessionSnapshot(requestContext)?.epoch).toBe(0);

    expect(advanceSessionSnapshotEpoch("snapshot-lease")).toBe(1);
    expect(getSessionSnapshot("snapshot-lease")).toBeNull();
  });

  it("clear 后复用同一 sessionId，旧 context 的迟到 fetch 不形成 ABA 覆盖", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => emptySse());
    vi.stubGlobal("fetch", fetchMock);
    const oldContext = context("snapshot-aba", "stream-old");
    beginSessionSnapshotTurn(oldContext);
    const delayedOldModel = createSnapshottingQingagentModel(oldContext);

    clearSessionSnapshot("snapshot-aba");
    const newContext = context("snapshot-aba", "stream-new");
    beginSessionSnapshotTurn(newContext);
    await triggerProviderFetch(newContext, "new-prefix");
    await delayedOldModel.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "late-old-prefix" }] }],
    } as never);

    const snapshot = getSessionSnapshot("snapshot-aba");
    expect(snapshot?.streamId).toBe("stream-new");
    expect(snapshot?.bodyText).toContain("new-prefix");
    expect(snapshot?.bodyText).not.toContain("late-old-prefix");
  });

  it("带 schema 的响应格式降为 json_object，不向 flash 发送 json_schema", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => emptySse());
    vi.stubGlobal("fetch", fetchMock);
    const requestContext = context("snapshot-schema", "stream-schema");
    beginSessionSnapshotTurn(requestContext);
    const model = createSnapshottingQingagentModel(requestContext);
    await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "输出对象" }] }],
      responseFormat: {
        type: "json",
        schema: { type: "object", properties: { answer: { type: "string" } } },
      },
    } as never);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain("json_schema");
  });

  it("回放保留原 tools/tool_choice，只 append 尾巴并完整记录缓存 usage", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(emptySse());
    vi.stubGlobal("fetch", fetchMock);
    const requestContext = context("branch-success", "stream-main");
    beginSessionSnapshotTurn(requestContext);
    await triggerProviderFetch(requestContext, "main-prefix");
    const snapshot = getSessionSnapshot(requestContext)!;
    fetchMock.mockResolvedValueOnce(jsonResponse(
      { role: "assistant", content: "分支答案" },
      {
        prompt_tokens: 105,
        completion_tokens: 7,
        prompt_cache_hit_tokens: 100,
        prompt_cache_miss_tokens: 5,
      },
    ));

    const result = await branchCall({
      sessionSnapshot: snapshot,
      steeringTail: "不要调用任何工具，直接回答。",
      callSite: "planDraft",
      requestContext,
      thinking: false,
      temperature: 0.35,
      maxTokens: 4096,
    });

    expect(result).toMatchObject({ ok: true, text: "分支答案", attempts: 1, toolCallRetries: 0 });
    const replayBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    const sourceBody = JSON.parse(snapshot.bodyText);
    expect(replayBody.tools).toEqual(sourceBody.tools);
    expect(replayBody.tool_choice).toBe(sourceBody.tool_choice);
    expect(replayBody.messages.slice(0, -1)).toEqual(sourceBody.messages);
    expect(replayBody.messages.at(-1)).toEqual({ role: "user", content: "不要调用任何工具，直接回答。" });
    expect(replayBody.thinking).toEqual({ type: "disabled" });
    expect(replayBody.temperature).toBe(0.35);
    expect(replayBody.max_tokens).toBe(4096);
    expect(replayBody.stream).toBe(true);
    expect(replayBody.stream_options).toEqual({ include_usage: true });
    expect(replayBody.tool_choice).toBe(sourceBody.tool_choice);
    expect(result).toMatchObject({ finishReason: "stop" });
    expect(mocks.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      callSite: "planDraft",
      cacheHitTokens: 100,
      cacheMissTokens: 5,
    }));
  });

  it("raw 请求飞行中被新主轮抢占时丢弃结果且不派发文本", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(emptySse());
    vi.stubGlobal("fetch", fetchMock);
    const requestContext = context("branch-inflight", "stream-old");
    beginSessionSnapshotTurn(requestContext);
    await triggerProviderFetch(requestContext, "main-prefix");
    const snapshot = getSessionSnapshot(requestContext)!;
    let resolveResponse!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    const deltas: string[] = [];
    const pending = branchCall({
      sessionSnapshot: snapshot,
      steeringTail: "直接回答",
      callSite: "askMore",
      requestContext,
      onTextDelta: (delta) => { deltas.push(delta); },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    beginSessionSnapshotTurn(context("branch-inflight", "stream-new"));
    resolveResponse(jsonResponse(
      { role: "assistant", content: "必须丢弃" },
      { prompt_tokens: 10, completion_tokens: 2 },
    ));

    await expect(pending).resolves.toMatchObject({ reason: "stale_snapshot", attempts: 1 });
    expect(deltas).toEqual([]);
  });

  it("文本回调挂起期间切换 generation，回调返回后结果仍判 stale", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(emptySse());
    vi.stubGlobal("fetch", fetchMock);
    const requestContext = context("branch-callback-race", "stream-old");
    beginSessionSnapshotTurn(requestContext);
    await triggerProviderFetch(requestContext, "main-prefix");
    const snapshot = getSessionSnapshot(requestContext)!;
    fetchMock.mockResolvedValueOnce(jsonResponse(
      { role: "assistant", content: "旧轮结果" },
      { prompt_tokens: 10, completion_tokens: 2 },
    ));
    let releaseCallback!: () => void;
    const callbackEntered = new Promise<void>((resolve) => { releaseCallback = resolve; });
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const pending = branchCall({
      sessionSnapshot: snapshot,
      steeringTail: "直接回答",
      callSite: "writeDraft",
      requestContext,
      onTextDelta: async () => {
        releaseCallback();
        await blocked;
      },
    });
    await callbackEntered;
    beginSessionSnapshotTurn(context("branch-callback-race", "stream-new"));
    unblock();

    await expect(pending).resolves.toMatchObject({ reason: "stale_snapshot", attempts: 1 });
  });

  it("遇到 tool_call 立即失败，不原样重试阻塞降级", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(emptySse());
    vi.stubGlobal("fetch", fetchMock);
    const requestContext = context("branch-tool", "stream-main");
    beginSessionSnapshotTurn(requestContext);
    await triggerProviderFetch(requestContext, "main-prefix");
    const snapshot = getSessionSnapshot(requestContext)!;
    const toolResponse = () => jsonResponse(
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "planDraft", arguments: "{}" } }],
      },
      { prompt_tokens: 20, completion_tokens: 2, prompt_cache_hit_tokens: 16, prompt_cache_miss_tokens: 4 },
    );
    fetchMock.mockResolvedValueOnce(toolResponse());

    const result = await branchCall({
      sessionSnapshot: snapshot,
      steeringTail: "不要调用任何工具。",
      callSite: "askMore",
      requestContext,
    });

    expect(result).toEqual({ ok: false, reason: "tool_call", attempts: 1, toolCallRetries: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.recordUsageEvent).toHaveBeenCalledTimes(1);
  });

  it("可解析跨 chunk SSE，并在无 usage 时写 missing 事件", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(emptySse());
    vi.stubGlobal("fetch", fetchMock);
    const requestContext = context("branch-sse", "stream-main");
    beginSessionSnapshotTurn(requestContext);
    await triggerProviderFetch(requestContext, "main-prefix");
    const snapshot = getSessionSnapshot(requestContext)!;
    const encoder = new TextEncoder();
    const pieces = [
      'data: {"choices":[{"delta":{"content":"甲"},"finish_reason":null}]}\n',
      '\ndata: {"choices":[{"delta":{"content":"乙"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      pull(controller) {
        const next = pieces.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(encoder.encode(next));
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const deltas: string[] = [];
    let activities = 0;

    const result = await branchCall({
      sessionSnapshot: snapshot,
      steeringTail: "不要调用任何工具。",
      callSite: "planDraft",
      requestContext,
      onActivity: () => { activities += 1; },
      onTextDelta: (delta) => { deltas.push(delta); },
    });

    expect(result).toMatchObject({ ok: true, text: "甲乙" });
    expect(deltas).toEqual(["甲乙"]);
    expect(activities).toBeGreaterThanOrEqual(3);
    expect(mocks.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      usageState: "missing",
      reason: "provider_usage_missing",
    }));
  });

  it("流式消费逐帧派发文本并解析 SSE 末帧 usage", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(emptySse());
    vi.stubGlobal("fetch", fetchMock);
    const requestContext = context("branch-sse", "stream-progress");
    beginSessionSnapshotTurn(requestContext);
    await triggerProviderFetch(requestContext, "main-prefix");
    const snapshot = getSessionSnapshot(requestContext)!;
    fetchMock.mockResolvedValueOnce(new Response([
      'data: {"choices":[{"delta":{"content":"甲"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"乙"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2,"prompt_cache_hit_tokens":10,"prompt_cache_miss_tokens":2}}',
      "data: [DONE]",
      "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } }));
    const deltas: string[] = [];

    const result = await branchCall({
      sessionSnapshot: snapshot,
      steeringTail: "直接回答",
      callSite: "planDraft",
      requestContext,
      streamTextDeltas: true,
      onTextDelta: (delta) => { deltas.push(delta); },
    });

    expect(result).toMatchObject({ ok: true, text: "甲乙" });
    expect(deltas).toEqual(["甲", "乙"]);
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    // 定稿(260712 spike):回放保留快照原 tool_choice,禁止改写为 none(会把 tools 块挤出前缀)。
    expect(body.tool_choice).toBe("auto");
    expect(mocks.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      cacheHitTokens: 10,
      cacheMissTokens: 2,
    }));
  });

  it("HTTP 200 SSE error 帧按脱敏 provider_error 入账", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(emptySse());
    vi.stubGlobal("fetch", fetchMock);
    const requestContext = context("branch-sse", "stream-error");
    beginSessionSnapshotTurn(requestContext);
    await triggerProviderFetch(requestContext, "main-prefix");
    const snapshot = getSessionSnapshot(requestContext)!;
    fetchMock.mockResolvedValueOnce(new Response(
      'data: {"error":{"message":"rate limited Bearer sk-secret-value"}}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));

    await expect(branchCall({
      sessionSnapshot: snapshot,
      steeringTail: "直接回答",
      callSite: "planDraft",
      requestContext,
    })).resolves.toMatchObject({
      reason: "provider_error",
      error: "HTTP 200 SSE: rate limited Bearer ***",
    });
    expect(mocks.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      usageState: "missing",
      reason: "HTTP 200 SSE: rate limited Bearer ***",
    }));
  });

  it("规范化 webSearch 历史 tool 消息，补 arguments 并丢弃孤儿结果", () => {
    expect(normalizeReplayMessages([
      { role: "user", content: "搜索" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-web", type: "function", function: { name: "webSearch" } }],
      },
      { role: "tool", tool_call_id: "call-web", content: "{\"ok\":true}" },
      { role: "tool", tool_call_id: "orphan", content: "bad" },
    ])).toEqual([
      { role: "user", content: "搜索" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call-web",
          type: "function",
          function: { name: "webSearch", arguments: "{}" },
        }],
      },
      { role: "tool", tool_call_id: "call-web", content: "{\"ok\":true}" },
    ]);
  });

  it("账本慢写不会阻塞分支结果交付", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(emptySse());
    vi.stubGlobal("fetch", fetchMock);
    const requestContext = context("branch-ledger", "stream-main");
    beginSessionSnapshotTurn(requestContext);
    await triggerProviderFetch(requestContext, "main-prefix");
    const snapshot = getSessionSnapshot(requestContext)!;
    fetchMock.mockResolvedValueOnce(jsonResponse(
      { role: "assistant", content: "不等账本" },
      { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 2 },
    ));
    mocks.recordUsageEvent.mockImplementationOnce(() => new Promise(() => {}));

    const delivered = await Promise.race([
      branchCall({
        sessionSnapshot: snapshot,
        steeringTail: "直接回答",
        callSite: "planDraft",
        requestContext,
      }),
      new Promise<"timeout">((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 100)),
    ]);

    expect(delivered).toMatchObject({ ok: true, text: "不等账本" });
  });

  it("raw HTTP 错误写入一笔 missing usage", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(emptySse());
    vi.stubGlobal("fetch", fetchMock);
    const requestContext = context("branch-http-error", "stream-main");
    beginSessionSnapshotTurn(requestContext);
    await triggerProviderFetch(requestContext, "main-prefix");
    const snapshot = getSessionSnapshot(requestContext)!;
    fetchMock.mockResolvedValueOnce(Response.json({
      error: { message: "upstream unavailable Authorization: Bearer sk-private-value" },
    }, { status: 502 }));

    await expect(branchCall({
      sessionSnapshot: snapshot,
      steeringTail: "直接回答",
      callSite: "planDraft",
      requestContext,
    })).resolves.toMatchObject({ reason: "provider_error", attempts: 1 });
    await vi.waitFor(() => expect(mocks.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      usageState: "missing",
      reason: "HTTP 502: upstream unavailable Authorization: Bearer ***",
      attempt: 1,
    })));
  });

  it("raw 流解析错误写入一笔 missing usage", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(emptySse());
    vi.stubGlobal("fetch", fetchMock);
    const requestContext = context("branch-parse-error", "stream-main");
    beginSessionSnapshotTurn(requestContext);
    await triggerProviderFetch(requestContext, "main-prefix");
    const snapshot = getSessionSnapshot(requestContext)!;
    fetchMock.mockResolvedValueOnce(new Response("data: {broken-json}\n\n", {
      headers: { "content-type": "text/event-stream" },
    }));

    await expect(branchCall({
      sessionSnapshot: snapshot,
      steeringTail: "直接回答",
      callSite: "planDraft",
      requestContext,
    })).resolves.toMatchObject({ reason: "provider_error", attempts: 1 });
    await vi.waitFor(() => expect(mocks.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      usageState: "missing",
      reason: "provider_request_error",
    })));
  });

  it("将取消信号传给 raw fetch，并把中止写成 missing usage", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(emptySse());
    vi.stubGlobal("fetch", fetchMock);
    const requestContext = context("branch-abort", "stream-main");
    beginSessionSnapshotTurn(requestContext);
    await triggerProviderFetch(requestContext, "main-prefix");
    const snapshot = getSessionSnapshot(requestContext)!;
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      expect(init?.signal).toBe(controller.signal);
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));

    const pending = branchCall({
      sessionSnapshot: snapshot,
      steeringTail: "直接回答",
      callSite: "planDraft",
      requestContext,
      abortSignal: controller.signal,
    });
    controller.abort();

    await expect(pending).resolves.toMatchObject({ ok: false, reason: "provider_error" });
    await vi.waitFor(() => expect(mocks.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      usageState: "missing",
      reason: "provider_request_aborted",
    })));
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_REQUEST_DEADLINE_MS,
  ApiClient,
  detectQaClient,
} from "../apiClient.js";
import { QaCliError } from "../errors.js";

vi.mock("../discovery.js", () => ({
  discoverInstance: vi.fn(async () => ({
    port: 45678,
    pid: process.pid,
    version: "test",
    token: "secret-token",
    startedAt: "2026-07-09T00:00:00.000Z",
  })),
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ApiClient", () => {
  it("检测 Claude Code 环境优先于其他标记", () => {
    expect(detectQaClient({ CLAUDECODE: "1", CODEX_SANDBOX: "1" })).toBe("claudecode");
    expect(detectQaClient({ AI_AGENT: "claude-code_1.2.3_agent" })).toBe("claudecode");
  });

  it("检测 CODEX_ 前缀环境变量", () => {
    expect(detectQaClient({ CODEX_SANDBOX: "seatbelt" })).toBe("codex");
  });

  it("没有已知环境变量时回退外部 Agent", () => {
    expect(detectQaClient({ AI_AGENT: "other-agent" })).toBe("agent");
  });

  it("非 JSON 5xx 归类为中性服务故障且不暴露内部错误", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("server exploded", { status: 500, statusText: "Internal Server Error" }),
    ) as typeof fetch;
    const client = await ApiClient.create();

    await expect(client.request("/boom")).rejects.toMatchObject({
      name: "QaCliError",
      code: "SERVICE_UNAVAILABLE",
      message: "青简服务暂时不可用",
    } satisfies Partial<QaCliError>);
  });

  it("JSON 5xx 不信任服务端业务分类，统一归类为服务故障", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        code: "VALIDATION",
        error: "database exploded",
        nextStep: "修改提案",
      }), { status: 503 }),
    ) as typeof fetch;
    const client = await ApiClient.create();

    await expect(client.request("/boom")).rejects.toMatchObject({
      name: "QaCliError",
      code: "SERVICE_UNAVAILABLE",
      message: "青简服务暂时不可用",
    } satisfies Partial<QaCliError>);
  });

  it("普通 API 网络异常归类为实例不可达", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const client = await ApiClient.create();

    await expect(client.request("/sessions")).rejects.toMatchObject({
      name: "QaCliError",
      code: "NO_INSTANCE",
      message: "实例不可达",
    } satisfies Partial<QaCliError>);
  });

  it("200 + 非法 JSON 归类为实例响应无效并保留排障上下文", async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"sessions":[')) as typeof fetch;
    const client = await ApiClient.create();

    await expect(client.request("/invalid-json")).rejects.toMatchObject({
      name: "QaCliError",
      code: "INVALID_RESPONSE",
      message: "实例响应无效(非 JSON)",
      details: {
        endpoint: "/invalid-json",
        bodySnippet: '{"sessions":[',
      },
    });
  });

  it.each([
    ["尾随散文", '{}\n处理完成'],
    ["JSON fence", '```json\n{}\n```'],
    ["前导文本", '响应如下: {}'],
    ["截断对象", '{"message":"unterminated'],
  ])("200 + %s 不被宽松提取为成功 JSON", async (_label, body) => {
    globalThis.fetch = vi.fn(async () => new Response(body)) as typeof fetch;
    const client = await ApiClient.create();

    await expect(client.request("/dirty-json")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      details: { endpoint: "/dirty-json", bodySnippet: body.replace(/\s+/g, " ").trim() },
    });
  });

  it("合法 JSON 字符串中的括号与转义引号不干扰解析", async () => {
    const body = { message: '正文含 ]} 与 "引号"' };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body))) as typeof fetch;
    const client = await ApiClient.create();

    await expect(client.request("/valid-json")).resolves.toEqual(body);
  });

  it("非法 JSON 的排障片段会截断", async () => {
    const body = `{"value":"${"x".repeat(240)}`;
    globalThis.fetch = vi.fn(async () => new Response(body)) as typeof fetch;
    const client = await ApiClient.create();

    await expect(client.request("/long-invalid-json")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      details: {
        endpoint: "/long-invalid-json",
        bodySnippet: `${body.slice(0, 200)}...`,
      },
    });
  });

  it.each([null, [], "ok", 1])("200 + 非对象 JSON %j 归类为实例响应无效", async (body) => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body))) as typeof fetch;
    const client = await ApiClient.create();

    await expect(client.request("/invalid-shape")).rejects.toMatchObject({
      name: "QaCliError",
      code: "INVALID_RESPONSE",
      message: "实例响应无效(响应体必须是 JSON 对象)",
      details: {
        endpoint: "/invalid-shape",
        bodySnippet: JSON.stringify(body),
      },
    });
  });

  it("响应解码异常不误归因为实例不可达", async () => {
    const response = new Response("{}");
    vi.spyOn(response, "text").mockRejectedValue(new TypeError("decoder bug"));
    globalThis.fetch = vi.fn(async () => response) as typeof fetch;
    const client = await ApiClient.create();

    await expect(client.request("/decoder-error")).rejects.toMatchObject({
      name: "QaCliError",
      code: "INVALID_RESPONSE",
      message: "实例响应读取失败",
      details: { endpoint: "/decoder-error" },
    });
  });

  it("普通 API 悬挂到 deadline 后归类为实例不可达", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    ) as typeof fetch;
    const client = await ApiClient.create();
    const request = client.request("/sessions");
    const rejected = expect(request).rejects.toMatchObject({
      name: "QaCliError",
      code: "NO_INSTANCE",
      message: "实例请求超时",
    } satisfies Partial<QaCliError>);

    await vi.advanceTimersByTimeAsync(API_REQUEST_DEADLINE_MS);

    await rejected;
  });

  it.each([
    [401, "AUTH_FAILED"],
    [404, "NOT_FOUND"],
  ])("非 JSON HTTP %i 按状态归类为 %s", async (status, code) => {
    globalThis.fetch = vi.fn(async () =>
      new Response("", { status }),
    ) as typeof fetch;
    const client = await ApiClient.create();

    await expect(client.request("/failure")).rejects.toMatchObject({
      name: "QaCliError",
      code,
    });
  });

  it("仅 proposal 请求带上调用方身份", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    globalThis.fetch = fetchMock as typeof fetch;
    const client = await ApiClient.create();

    await client.propose("session id", { expectedDocVersion: 1, ops: [] });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:45678/api/v1/external/sessions/session%20id/proposals",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-QA-Client": detectQaClient(process.env) }),
      }),
    );
  });

  it("429 时读取 Retry-After 并指数退避后自动重试成功", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ code: "RATE_LIMITED", error: "稍后重试" }),
        { status: 429, headers: { "Retry-After": "1" } },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({ queued: true })));
    globalThis.fetch = fetchMock as typeof fetch;
    const client = await ApiClient.create();

    const request = client.request("/sessions/s1/chat", {
      method: "POST",
      body: JSON.stringify({ text: "批量写" }),
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(request).resolves.toEqual({ queued: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

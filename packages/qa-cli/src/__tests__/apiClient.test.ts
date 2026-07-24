import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, detectQaClient } from "../apiClient.js";
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

  it("非 JSON 错误体降级为 VALIDATION 并保留文本摘要", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("server exploded", { status: 500, statusText: "Internal Server Error" }),
    ) as typeof fetch;
    const client = await ApiClient.create();

    await expect(client.request("/boom")).rejects.toMatchObject({
      name: "QaCliError",
      code: "VALIDATION",
      message: "server exploded",
    } satisfies Partial<QaCliError>);
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
});

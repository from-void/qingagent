import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../apiClient.js";
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
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadAuthGate() {
  vi.resetModules();
  return import("../authGate");
}

function response(status: number): Response {
  return new Response(status === 200 ? "ok" : "unauthorized", { status });
}

describe("authGate fetch 拦截器", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = window.fetch;
  });

  afterEach(() => {
    window.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("未触发 401 时 fetch 直通", async () => {
    const fetchMock = vi.fn(async () => response(200));
    window.fetch = fetchMock as unknown as typeof fetch;
    const authGate = await loadAuthGate();
    const events = vi.fn();
    window.addEventListener("qa-auth-required", events);

    authGate.installAuthFetchInterceptor();
    const res = await fetch("/api/v1/home");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).not.toHaveBeenCalled();
    window.removeEventListener("qa-auth-required", events);
  });

  it("同源 /api 401 会弹 token 卡、换 cookie 后重试原请求", async () => {
    let protectedCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path === "/api/v1/auth/session") return response(200);
      protectedCalls += 1;
      return response(protectedCalls === 1 ? 401 : 200);
    });
    window.fetch = fetchMock as unknown as typeof fetch;
    const authGate = await loadAuthGate();
    const events = vi.fn();
    window.addEventListener("qa-auth-required", events);

    authGate.installAuthFetchInterceptor();
    const pending = fetch("/api/v1/home");
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toHaveBeenCalledTimes(1);
    await expect(authGate.submitAuthToken("secret-xyz")).resolves.toBe(true);
    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/auth/session", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ token: "secret-xyz" }),
    }));
    window.removeEventListener("qa-auth-required", events);
  });

  it("并发两个 401 只弹一次 token 卡", async () => {
    let protectedCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path === "/api/v1/auth/session") return response(200);
      protectedCalls += 1;
      return response(protectedCalls <= 2 ? 401 : 200);
    });
    window.fetch = fetchMock as unknown as typeof fetch;
    const authGate = await loadAuthGate();
    const events = vi.fn();
    window.addEventListener("qa-auth-required", events);

    authGate.installAuthFetchInterceptor();
    const one = fetch("/api/v1/home");
    const two = fetch("/api/v1/capabilities");
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toHaveBeenCalledTimes(1);
    await expect(authGate.submitAuthToken("secret-xyz")).resolves.toBe(true);
    await expect(Promise.all([one, two])).resolves.toEqual([
      expect.objectContaining({ status: 200 }),
      expect.objectContaining({ status: 200 }),
    ]);
    window.removeEventListener("qa-auth-required", events);
  });

  it("非 /api 路径 401 不拦截", async () => {
    const fetchMock = vi.fn(async () => response(401));
    window.fetch = fetchMock as unknown as typeof fetch;
    const authGate = await loadAuthGate();
    const events = vi.fn();
    window.addEventListener("qa-auth-required", events);

    authGate.installAuthFetchInterceptor();
    const res = await fetch("/assets/app.js");

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).not.toHaveBeenCalled();
    window.removeEventListener("qa-auth-required", events);
  });

  it("auth/session 自身 401 不递归弹卡", async () => {
    const fetchMock = vi.fn(async () => response(401));
    window.fetch = fetchMock as unknown as typeof fetch;
    const authGate = await loadAuthGate();
    const events = vi.fn();
    window.addEventListener("qa-auth-required", events);

    authGate.installAuthFetchInterceptor();
    const res = await fetch("/api/v1/auth/session", { method: "POST" });

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).not.toHaveBeenCalled();
    window.removeEventListener("qa-auth-required", events);
  });
});

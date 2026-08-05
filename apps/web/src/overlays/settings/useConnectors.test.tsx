// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getConnectorAuthSessions,
  resetConnectorAuthSessionsForTests,
  saveConnectorAuthSession,
} from "./connectorAuthSession";
import { useConnectors } from "./useConnectors";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let hook!: ReturnType<typeof useConnectors>;

function Harness() {
  hook = useConnectors();
  return null;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetConnectorAuthSessionsForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useConnectors", () => {
  it("检查中状态会自动重试，并在拿到 needs_reauth 后停止", async () => {
    vi.useFakeTimers();
    let state: "checking" | "needs_reauth" = "checking";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      connectors: [{
        id: "feishu", name: "飞书", icon: "feishu", official: true,
        authPresentation: "scan", riskNote: null, usedBySkills: ["feishu"],
        status: {
          state,
          reasonCode: state === "checking" ? "LARK_CLI_VERSION_TIMEOUT" : "LARK_AUTH_EXPIRED",
          account: null, scopes: [], lastCheckedAt: null,
          statusFreshness: state === "checking" ? "unknown" : "fresh",
          canProbe: state === "needs_reauth",
        },
      }],
    })));
    vi.stubGlobal("fetch", fetchMock);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root?.render(<Harness />); });
    expect(hook.connectors[0]?.status.state).toBe("checking");

    state = "needs_reauth";
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(hook.connectors[0]?.status.state).toBe("needs_reauth");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("start 失败展示服务端实际返回的 message 与 reasonCode", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/connectors") {
        return new Response(JSON.stringify({ connectors: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        error: "INVALID_ARGUMENT",
        message: "至少选择一个飞书授权域",
        reasonCode: "INVALID_ARGUMENT",
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root?.render(<Harness />); });

    let error: unknown;
    await act(async () => {
      try {
        await hook.start("feishu", {});
      } catch (cause) {
        error = cause;
      }
    });

    expect(error).toEqual(new Error("至少选择一个飞书授权域 (400)：INVALID_ARGUMENT"));
  });

  it("pending 授权在聚焦与轮询时刷新，完成后停止轮询", async () => {
    vi.useFakeTimers();
    let statusState: "pending" | "connected" = "pending";
    const connector = (state: "pending" | "connected") => ({
      id: "feishu", name: "飞书", icon: "feishu", official: true, riskNote: null,
      usedBySkills: [], status: {
        state, reasonCode: null, account: null, scopes: [], lastCheckedAt: null,
        statusFreshness: "fresh", canProbe: false,
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/connectors") return new Response(JSON.stringify({ connectors: [connector("disconnected" as never)] }));
      if (url === "/api/v1/connectors/feishu/start") {
        return new Response(JSON.stringify({ pendingId: "fs-pending" }));
      }
      if (url === "/api/v1/connectors/feishu?pendingId=fs-pending") {
        return new Response(JSON.stringify(connector(statusState)));
      }
      throw new Error(`未预期请求: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root?.render(<Harness />); });
    await act(async () => { await hook.start("feishu"); });
    act(() => {
      saveConnectorAuthSession({
        connectorId: "feishu",
        pendingId: "fs-pending",
        startedAt: Date.now(),
        card: {
          presentation: "scan",
          connectorId: "feishu",
          pendingId: "fs-pending",
          title: "扫码授权飞书",
          content: "https://feishu.test/auth",
          code: "ABCD-EFGH",
          note: null,
          expiresAt: Date.now() + 300_000,
          refreshQuery: "重新授权飞书",
          confirmQuery: null,
        },
      });
    });
    await act(async () => { await Promise.resolve(); });

    fetchMock.mockClear();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/connectors");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/connectors/feishu?pendingId=fs-pending");

    fetchMock.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/connectors");

    statusState = "connected";
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { await Promise.resolve(); });
    fetchMock.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("会话级 pending 在连接 tab 连续卸载重挂五次后仍用同一 pendingId 恢复轮询", async () => {
    const connector = {
      id: "github", name: "GitHub", icon: "github", official: true, riskNote: null,
      authPresentation: "device-code", usedBySkills: [], status: {
        state: "pending", reasonCode: null, account: null, scopes: [],
        lastCheckedAt: null, statusFreshness: "fresh", canProbe: false,
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/connectors") {
        return new Response(JSON.stringify({
          connectors: [{ ...connector, status: { ...connector.status, state: "disconnected" } }],
        }));
      }
      if (url === "/api/v1/connectors/github?pendingId=gh-stable") {
        return new Response(JSON.stringify(connector));
      }
      throw new Error(`未预期请求: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    act(() => {
      saveConnectorAuthSession({
        connectorId: "github",
        pendingId: "gh-stable",
        startedAt: 1234,
        card: {
          presentation: "device-code",
          connectorId: "github",
          pendingId: "gh-stable",
          title: "连接 GitHub",
          content: "https://github.test/device",
          code: "ABCD-EFGH",
          note: null,
          expiresAt: Date.now() + 300_000,
          refreshQuery: "重新连接 GitHub",
          confirmQuery: null,
        },
      });
    });

    host = document.createElement("div");
    document.body.appendChild(host);
    for (let index = 0; index < 5; index += 1) {
      fetchMock.mockClear();
      root = createRoot(host);
      await act(async () => { root?.render(<Harness />); });
      await act(async () => { await Promise.resolve(); });

      expect(getConnectorAuthSessions().github).toMatchObject({
        pendingId: "gh-stable",
        startedAt: 1234,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/connectors/github?pendingId=gh-stable",
      );

      act(() => root?.unmount());
      root = null;
    }
  });

  it("cancel 成功后清理会话快照并更新连接状态", async () => {
    const disconnected = {
      id: "wechat-mp", name: "微信公众号", icon: "wechat", official: false,
      authPresentation: "scan", riskNote: null, usedBySkills: [], status: {
        state: "disconnected", reasonCode: "USER_CANCELLED", account: null,
        scopes: [], lastCheckedAt: null, statusFreshness: "fresh", canProbe: false,
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/connectors") {
        return new Response(JSON.stringify({ connectors: [disconnected] }));
      }
      if (url === "/api/v1/connectors/wechat-mp?pendingId=wx-pending") {
        return new Response(JSON.stringify({
          ...disconnected,
          status: { ...disconnected.status, state: "pending" },
        }));
      }
      if (url === "/api/v1/connectors/wechat-mp/pending/wx-pending") {
        expect(init?.method).toBe("DELETE");
        return new Response(JSON.stringify(disconnected));
      }
      throw new Error(`未预期请求: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    act(() => {
      saveConnectorAuthSession({
        connectorId: "wechat-mp",
        pendingId: "wx-pending",
        startedAt: Date.now(),
        card: {
          presentation: "scan",
          connectorId: "wechat-mp",
          pendingId: "wx-pending",
          title: "扫码登录微信公众平台",
          content: "",
          imageDataUri: "data:image/png;base64,AA",
          code: null,
          note: null,
          expiresAt: Date.now() + 300_000,
          refreshQuery: "重新登录微信公众号",
          confirmQuery: null,
        },
      });
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root?.render(<Harness />); });

    await act(async () => {
      await hook.cancel("wechat-mp", "wx-pending");
    });

    expect(getConnectorAuthSessions()["wechat-mp"]).toBeUndefined();
    expect(hook.connectors.find((item) => item.id === "wechat-mp")?.status.state)
      .toBe("disconnected");
  });
});

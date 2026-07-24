// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.unstubAllGlobals();
});

describe("useConnectors", () => {
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
});

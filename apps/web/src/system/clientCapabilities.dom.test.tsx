import type { ClientCapabilities } from "@qingagent/contract-ts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClientCapabilities } from "./clientCapabilities";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const capabilities: ClientCapabilities = {
  folderSources: {
    desktopLocal: { enabled: false },
    browserFsAccess: { enabled: true },
  },
  skills: { mutationEnabled: true },
  connectors: {
    mutationEnabled: true,
    reasonCode: null,
  },
};

let host: HTMLDivElement;
let root: Root | null;

function Probe({ label }: { label: string }) {
  const snapshot = useClientCapabilities();
  return (
    <output data-testid={label}>
      {snapshot?.skills.mutationEnabled ? "ready" : "waiting"}
    </output>
  );
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useClientCapabilities 共享缓存与恢复", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("共享请求可取消，失败后指数退避并在 focus/可见时重试，成功同步所有订阅者", async () => {
    let firstSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const call = fetchMock.mock.calls.length;
        if (call === 1) {
          firstSignal = init?.signal ?? undefined;
          return await new Promise<Response>((_resolve, reject) => {
            firstSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
        }
        if (call < 5) throw new Error("temporary failure");
        return new Response(JSON.stringify(capabilities), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root?.render(
        <>
          <Probe label="first" />
          <Probe label="second" />
        </>,
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => root?.unmount());
    root = null;
    expect(firstSignal?.aborted).toBe(true);
    await flushPromises();

    root = createRoot(host);
    await act(async () => {
      root?.render(
        <>
          <Probe label="first" />
          <Probe label="second" />
        </>,
      );
    });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      vi.advanceTimersByTime(1_999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    window.dispatchEvent(new Event("focus"));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    let visibilityState: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibilityState,
    );
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(
      host.querySelector('[data-testid="first"]')?.textContent,
    ).toBe("ready");
    expect(
      host.querySelector('[data-testid="second"]')?.textContent,
    ).toBe("ready");

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

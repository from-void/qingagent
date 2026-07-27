// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetClientPersistCacheForTests } from "../overlays/settings/clientPersist";
import {
  setSelectedModelProvider,
  setVisitorModelKey,
  visitorKeyHeaders,
} from "../overlays/settings/visitorKeyStore";
import { NoKeyTip, useModelKeyConfigured } from "./modelKeyGate";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("modelKeyGate", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetClientPersistCacheForTests();
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    window.localStorage.clear();
    __resetClientPersistCacheForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("已验证服务端有 key 后，后续 fetch 失败不误弹门禁", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(modelSettings({
        activeProvider: "deepseek",
        deepseek: true,
        kimi: false,
      })))
      .mockRejectedValueOnce(new Error("temporary network failure"));
    vi.stubGlobal("fetch", fetchMock);

    await renderGate();
    expectGate(false);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectGate(false);
  });

  it("服务端确认无 key 时仍显示门禁并禁用发送", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(modelSettings({
        activeProvider: "deepseek",
        deepseek: false,
        kimi: false,
      }))),
    );

    await renderGate();

    expectGate(true);
  });

  it("当前 provider 为 Kimi 时读取 Kimi 本地 key，不误用 DeepSeek 槽位", async () => {
    await setSelectedModelProvider("kimi");
    await setVisitorModelKey("kimi", "kimi-local-key");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await renderGate();

    expectGate(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("用户选择 Kimi 且仅 DeepSeek 有服务端 key 时仍启用门禁", async () => {
    await setSelectedModelProvider("kimi");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(modelSettings({
      activeProvider: "deepseek",
      deepseek: true,
      kimi: false,
    })));
    vi.stubGlobal("fetch", fetchMock);

    await renderGate();

    expectGate(true);
    expect(visitorKeyHeaders()["x-model-provider"]).toBe("kimi");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/settings/model");
  });

  it("用户选择 Kimi 且仅 Kimi 有服务端 key 时不被活动 DeepSeek 状态误拦", async () => {
    await setSelectedModelProvider("kimi");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(modelSettings({
        activeProvider: "deepseek",
        deepseek: false,
        kimi: true,
      }))),
    );

    await renderGate();

    expectGate(false);
  });
});

function GateHarness() {
  const configured = useModelKeyConfigured();
  return (
    <NoKeyTip active={!configured} onConfigure={() => undefined}>
      <button type="button" disabled={!configured}>
        发送
      </button>
    </NoKeyTip>
  );
}

async function renderGate(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<GateHarness />);
  });
}

function expectGate(active: boolean): void {
  expect(host?.querySelector(".nokey-gate") !== null).toBe(active);
  expect(host?.querySelector("button")?.disabled).toBe(active);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function modelSettings(input: {
  activeProvider: "deepseek" | "kimi";
  deepseek: boolean;
  kimi: boolean;
}) {
  return {
    provider: input.activeProvider,
    apiKeyConfigured: input[input.activeProvider],
    providers: {
      deepseek: { apiKeyConfigured: input.deepseek },
      kimi: { apiKeyConfigured: input.kimi },
    },
  };
}

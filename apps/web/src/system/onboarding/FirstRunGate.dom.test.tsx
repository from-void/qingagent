// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetClientPersistCacheForTests } from "../../overlays/settings/clientPersist";
import { setVisitorModelKey } from "../../overlays/settings/visitorKeyStore";
import { OnboardingSettingsProvider } from "./OnboardingSettingsContext";
import { FirstRunGate } from "./FirstRunGate";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

describe("FirstRunGate", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetClientPersistCacheForTests();
    setElectron(undefined);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setElectron(undefined);
    window.localStorage.clear();
    __resetClientPersistCacheForTests();
  });

  it("两家均未配置且无历史状态时显示首启页", async () => {
    vi.stubGlobal("fetch", settingsFetch({ onboardingState: null }));
    await renderGate();
    await vi.waitFor(() => expect(host.querySelector("[data-onboarding]")).not.toBeNull());
    expect(host.querySelector("[data-home]")).toBeNull();
  });

  it("服务端任一家已配置时直接进入首页", async () => {
    vi.stubGlobal("fetch", settingsFetch({ onboardingState: null, kimiConfigured: true }));
    await renderGate();
    await vi.waitFor(() => expect(host.querySelector("[data-home]")).not.toBeNull());
    expect(host.querySelector("[data-onboarding]")).toBeNull();
  });

  it("本机 visitor key 已可用时直接进入首页且不等待服务端 provider", async () => {
    await setVisitorModelKey("deepseek", "sk-local-visitor-key");
    const fetchMock = settingsFetch({ onboardingState: null });
    vi.stubGlobal("fetch", fetchMock);
    await renderGate();
    expect(host.querySelector("[data-home]")).not.toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/settings/model"))).toBe(false);
  });

  it("已跳过时直接进入首页", async () => {
    vi.stubGlobal("fetch", settingsFetch({ onboardingState: "skipped" }));
    await renderGate();
    await vi.waitFor(() => expect(host.querySelector("[data-home]")).not.toBeNull());
  });

  it("桌面持久层已就绪但密钥 getter 均不可用时继续服务端判定并显示首启页", async () => {
    setElectron(unavailableDesktopPersist());
    vi.stubGlobal("fetch", settingsFetch({ onboardingState: null }));

    await renderGate();

    await vi.waitFor(() => expect(host.querySelector("[data-onboarding]")).not.toBeNull());
    expect(host.querySelector("[data-loading]")).toBeNull();
    expect(host.querySelector("[data-home]")).toBeNull();
  });

  it("桌面持久层已就绪但不可用且服务端判定失败时 fail-open 进入首页", async () => {
    setElectron(unavailableDesktopPersist());
    vi.stubGlobal("fetch", settingsFetch({
      onboardingState: null,
      modelSettingsError: true,
    }));

    await renderGate();

    await vi.waitFor(() => expect(host.querySelector("[data-home]")).not.toBeNull());
    expect(host.querySelector("[data-loading]")).toBeNull();
    expect(host.querySelector("[data-onboarding]")).toBeNull();
  });

  it("web localStorage 不可读时按 unavailable 继续服务端判定", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("localStorage unavailable");
    });
    vi.stubGlobal("fetch", settingsFetch({ onboardingState: null }));

    await renderGate();

    await vi.waitFor(() => expect(host.querySelector("[data-onboarding]")).not.toBeNull());
    expect(host.querySelector("[data-loading]")).toBeNull();
  });

  it("attach 模式绝不触发首启页且不请求设置", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    setElectron({
      isDesktop: true,
      platform: "linux",
      getBackendConnection: () => ({
        mode: "attach",
        status: "attached",
        conflictKind: null,
        effectiveCapabilities: {},
      } as ElectronBackendConnectionSnapshot),
    });
    await renderGate();
    expect(host.querySelector("[data-home]")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

async function renderGate() {
  await act(async () => {
    root.render(
      <OnboardingSettingsProvider>
        <FirstRunGate
          onboarding={<div data-onboarding />}
          loading={<div data-loading />}
        >
          <div data-home />
        </FirstRunGate>
      </OnboardingSettingsProvider>,
    );
    await Promise.resolve();
  });
}

function settingsFetch(input: {
  onboardingState: "done" | "skipped" | null;
  deepseekConfigured?: boolean;
  kimiConfigured?: boolean;
  modelSettingsError?: boolean;
}) {
  return vi.fn<typeof fetch>(async (request) => {
    const url = String(request);
    if (url.endsWith("/settings/onboarding")) {
      return Response.json({
        state: input.onboardingState
          ? { status: input.onboardingState, completedAt: "2026-08-17T00:00:00.000Z" }
          : null,
        coachSeen: [],
      });
    }
    if (url.endsWith("/settings/model")) {
      if (input.modelSettingsError) throw new Error("model settings unavailable");
      return Response.json({
        provider: "deepseek",
        providers: {
          deepseek: { apiKeyConfigured: input.deepseekConfigured ?? false },
          kimi: { apiKeyConfigured: input.kimiConfigured ?? false },
        },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

function unavailableDesktopPersist(): NonNullable<Window["electron"]> {
  const unavailable = () => {
    throw new Error("desktop client config read failed");
  };
  const rejectWrite = async () => false;
  return {
    isDesktop: true,
    platform: "linux",
    isClientConfigReady: () => true,
    getModelProvider: unavailable,
    setModelProvider: rejectWrite,
    getDeepseekApiKey: unavailable,
    setDeepseekApiKey: rejectWrite,
    getCustomProvider: unavailable,
    setCustomProvider: rejectWrite,
    getKimiApiKey: unavailable,
    setKimiApiKey: rejectWrite,
    getKimiCustomProvider: unavailable,
    setKimiCustomProvider: rejectWrite,
  };
}

function setElectron(value: Window["electron"] | undefined) {
  Object.defineProperty(window, "electron", { configurable: true, writable: true, value });
}

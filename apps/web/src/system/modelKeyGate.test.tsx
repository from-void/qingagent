// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetClientPersistCacheForTests } from "../overlays/settings/clientPersist";
import {
  getStoredModelProvider,
  setSelectedModelProvider,
  setVisitorModelKey,
  visitorKeyHeaders,
  type ModelProvider,
} from "../overlays/settings/visitorKeyStore";
import { ToastProvider } from "./ToastProvider";
import {
  NoKeyTip,
  useModelKeyGate,
  type ModelKeyGateSnapshot,
} from "./modelKeyGate";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let configureSpy = vi.fn<(provider: ModelProvider) => void>();

describe("modelKeyGate", () => {
  beforeEach(() => {
    setElectron(undefined);
    window.localStorage.clear();
    window.sessionStorage.clear();
    __resetClientPersistCacheForTests();
    configureSpy = vi.fn();
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    setElectron(undefined);
    window.localStorage.clear();
    window.sessionStorage.clear();
    __resetClientPersistCacheForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("desktop accessor 缺失时保持 loading，不读 localStorage 也不弹无 key 门禁", async () => {
    window.localStorage.setItem("qingagent.deepseek_api_key", "wrong-origin-key");
    setElectron({ platform: "win32", isDesktop: true });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await renderGate();

    expectGateSnapshot("loading");
    expectGate(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ready 后 accessor 读到既有 DeepSeek key，无需 focus 自动 configured", async () => {
    let ready = false;
    let notifyReady: (() => void) | undefined;
    const store = { "qingagent.deepseek_api_key": "existing-deepseek-key" };
    const bridge = desktopBridge(store);
    bridge.isClientConfigReady = () => ready;
    bridge.onClientConfigReady = (cb) => {
      notifyReady = cb;
      return () => {
        if (notifyReady === cb) notifyReady = undefined;
      };
    };
    setElectron(bridge);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await renderGate();
    expectGateSnapshot("loading");

    await act(async () => {
      ready = true;
      notifyReady?.();
      await Promise.resolve();
    });

    expectGateSnapshot("configured");
    expectGate(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("当前 Kimi 无 key、DeepSeek 有本地 key：明确提示并一键持久化切换", async () => {
    const store = {
      "qingagent.model_provider": "kimi",
      "qingagent.deepseek_api_key": "deepseek-local-key",
    };
    setElectron(desktopBridge(store));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(modelSettings({
        activeProvider: "deepseek",
        deepseek: false,
        kimi: false,
      }))),
    );

    await renderGate();
    expectGate(true);
    expect(host?.textContent).toContain("当前使用中的 Kimi 还没配置 key");
    const cta = findCta("切到 DeepSeek");

    await act(async () => {
      cta.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(store["qingagent.model_provider"]).toBe("deepseek");
    // 清空 renderer 镜像模拟重启后的首次读取：必须从 desktop IPC 落盘值恢复，不再回到污染态。
    __resetClientPersistCacheForTests();
    expect(getStoredModelProvider()).toBe("deepseek");
    expect(visitorKeyHeaders()).toMatchObject({
      "x-model-provider": "deepseek",
      "x-model-key": "deepseek-local-key",
    });
    expectGate(false);
    expect(host?.textContent).toContain("已切到 DeepSeek");
  });

  it("当前 Kimi 无 key、两家都无 key：定向去配置 Kimi", async () => {
    await setSelectedModelProvider("kimi");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(modelSettings({
        activeProvider: "deepseek",
        deepseek: false,
        kimi: false,
      }))),
    );

    await renderGate();
    expect(host?.textContent).toContain("当前使用中的 Kimi 还没配置 key，无法开始写作");

    await act(async () => {
      findCta("去配置 Kimi").click();
    });

    expect(configureSpy).toHaveBeenCalledWith("kimi");
  });

  it("一键切换落盘失败时保留 Kimi 门禁并走唯一 qa-toast", async () => {
    const store = {
      "qingagent.model_provider": "kimi",
      "qingagent.deepseek_api_key": "deepseek-local-key",
    };
    setElectron(desktopBridge(store, async () => false));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(modelSettings({
        activeProvider: "deepseek",
        deepseek: false,
        kimi: false,
      }))),
    );
    await renderGate();

    await act(async () => {
      findCta("切到 DeepSeek").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(store["qingagent.model_provider"]).toBe("kimi");
    expectGate(true);
    expect(host?.textContent).toContain("本机保存失败，请重试");
  });

  it("同窗口 key 写入成功立即重算；desktop 写入失败回滚后不误放行", async () => {
    await setSelectedModelProvider("deepseek");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(modelSettings({
        activeProvider: "deepseek",
        deepseek: false,
        kimi: false,
      }))),
    );
    await renderGate();
    expectGate(true);

    await act(async () => {
      await setVisitorModelKey("deepseek", "new-local-key");
    });
    expectGate(false);

    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    window.localStorage.clear();
    const store = { "qingagent.model_provider": "deepseek" };
    setElectron(desktopBridge(store, async () => false));
    __resetClientPersistCacheForTests();
    await renderGate();
    await waitForGateSnapshot("unconfigured");
    expectGate(true);

    await act(async () => {
      await expect(setVisitorModelKey("deepseek", "must-not-stick")).resolves.toBe(false);
    });
    expectGate(true);
    expect(visitorKeyHeaders()["x-model-key"]).toBeUndefined();
  });

  it("慢 server false 与稍后本地写入交错时，旧响应不能打回 unconfigured", async () => {
    await setSelectedModelProvider("deepseek");
    let resolveServer!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>((resolve) => {
        resolveServer = resolve;
      })),
    );
    await renderGate();
    expectGateSnapshot("loading");

    await act(async () => {
      await setVisitorModelKey("deepseek", "newer-local-key");
    });
    expectGateSnapshot("configured");

    await act(async () => {
      resolveServer(jsonResponse(modelSettings({
        activeProvider: "deepseek",
        deepseek: false,
        kimi: false,
      })));
      await Promise.resolve();
    });
    expectGateSnapshot("configured");
    expectGate(false);
  });

  it("已验证服务端有 key 后，后续 fetch 失败保持 configured", async () => {
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
    expectGateSnapshot("configured");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectGateSnapshot("configured");
    expectGate(false);
  });

  it("当前 provider 为 Kimi 时读取 Kimi 本地 key，不误用 DeepSeek 槽位", async () => {
    await setSelectedModelProvider("kimi");
    await setVisitorModelKey("kimi", "kimi-local-key");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await renderGate();

    expectGateSnapshot("configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function GateHarness() {
  const gate = useModelKeyGate();
  const blocked = gate.status === "unconfigured";
  return (
    <div data-gate-status={gate.status}>
      <NoKeyTip gate={gate} onConfigure={configureSpy}>
        <button type="button" data-send disabled={blocked}>
          发送
        </button>
      </NoKeyTip>
    </div>
  );
}

async function renderGate(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ToastProvider>
        <GateHarness />
      </ToastProvider>,
    );
    await Promise.resolve();
  });
}

function expectGate(active: boolean): void {
  expect(host?.querySelector(".nokey-gate") !== null).toBe(active);
  expect(host?.querySelector<HTMLButtonElement>("[data-send]")?.disabled).toBe(active);
}

function expectGateSnapshot(status: ModelKeyGateSnapshot["status"]): void {
  expect(host?.querySelector<HTMLElement>("[data-gate-status]")?.dataset.gateStatus).toBe(status);
}

async function waitForGateSnapshot(status: ModelKeyGateSnapshot["status"]): Promise<void> {
  await vi.waitFor(() => expectGateSnapshot(status));
}

function findCta(label: string): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>(".nokey-tip-btn");
  expect(button?.textContent).toContain(label);
  return button!;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function modelSettings(input: {
  activeProvider: ModelProvider;
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

type TestElectronBridge = NonNullable<Window["electron"]>;

function desktopBridge(
  store: Record<string, string>,
  write: (key: string, value: string | null) => Promise<boolean> = async (key, value) => {
    if (value) store[key] = value;
    else delete store[key];
    return true;
  },
): TestElectronBridge {
  const get = (key: string) => store[key] ?? null;
  const set = (key: string, value: string | null) => write(key, value);
  return {
    platform: "win32",
    isDesktop: true,
    isClientConfigReady: () => true,
    getDeepseekApiKey: () => get("qingagent.deepseek_api_key"),
    setDeepseekApiKey: (value) => set("qingagent.deepseek_api_key", value),
    getCustomProvider: () => get("qingagent.custom_provider"),
    setCustomProvider: (value) => set("qingagent.custom_provider", value),
    getOfficialModel: () => get("qingagent.official_model"),
    setOfficialModel: (value) => set("qingagent.official_model", value),
    getKimiApiKey: () => get("qingagent.kimi_api_key"),
    setKimiApiKey: (value) => set("qingagent.kimi_api_key", value),
    getKimiCustomProvider: () => get("qingagent.kimi_custom_provider"),
    setKimiCustomProvider: (value) => set("qingagent.kimi_custom_provider", value),
    getKimiOfficialModel: () => get("qingagent.kimi_official_model"),
    setKimiOfficialModel: (value) => set("qingagent.kimi_official_model", value),
    getModelProvider: () => get("qingagent.model_provider"),
    setModelProvider: (value) => set("qingagent.model_provider", value),
  };
}

function setElectron(bridge: Partial<TestElectronBridge> | undefined): void {
  (window as Window).electron = bridge as TestElectronBridge | undefined;
  __resetClientPersistCacheForTests();
}

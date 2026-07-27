// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "../../system/ConfirmProvider";
import { ToastProvider } from "../../system/ToastProvider";
import { resetDesktopUpdateStoreForTest } from "../../system/desktopUpdateStore";
import { __resetClientPersistCacheForTests } from "./clientPersist";
import { AboutPanel } from "./AboutPanel";
import { ModelSettingsPanel } from "./ModelSettingsPanel";
import { SecretInput } from "./SecretInput";
import { VisionPanel } from "./VisionPanel";
import { readVisionProvider, writeVisionProvider } from "./visionProviderStore";
import { resetSettingsDialogA11yForTest, ensureSettingsDialogA11y } from "./settingsDialogA11y";
import {
  getSelectedModelProvider,
  getStoredModelProvider,
  getSelectedModelTier,
  getVisitorModelKey,
  getVisitorDeepseekKey,
  readCustomProvider,
  setSelectedModelProvider,
  setVisitorDeepseekKey,
  setVisitorModelKey,
  visitorKeyHeaders,
  writeCustomProvider,
} from "./visitorKeyStore";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const dayRows = [
  {
    ...usageRow("2026-06-24", "deepseek-v4-flash", 1000, 500, 0.001),
    documentId: "doc-a",
    documentTitle: "文档甲",
  },
  {
    ...usageRow("2026-06-24", "deepseek-v4-pro", 600, 300, 0.001),
    callSite: "writeDraft",
    documentId: "doc-a",
    documentTitle: "文档甲",
  },
  {
    ...usageRow("2026-06-24", "deepseek-v4-flash", 400, 200, 0.001),
    documentId: "doc-b",
    documentTitle: "文档乙",
  },
  {
    ...usageRow("2026-06-25", "deepseek-v4-pro", 2000, 800, 0.002),
    documentId: "doc-c",
    documentTitle: "文档丙",
  },
];

describe("Settings Track B", () => {
  beforeEach(() => {
    __resetClientPersistCacheForTests();
    Object.defineProperty(window, "electron", { configurable: true, value: undefined });
    window.localStorage.clear();
    vi.stubGlobal("fetch", makeFetchMock());
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    document.body.innerHTML = "";
    window.localStorage.clear();
    __resetClientPersistCacheForTests();
    Object.defineProperty(window, "electron", { configurable: true, value: undefined });
    resetSettingsDialogA11yForTest();
    vi.restoreAllMocks();
  });

  it("SecretInput 默认遮挡,眼睛按钮可切明文且保留 data-wf", async () => {
    await render(
      <SecretInput
        className="sm-field-input"
        value="sk-secret"
        onChange={() => undefined}
        data-wf="SecretUnderTest"
      />,
    );

    const input = getInputByWf("SecretUnderTest");
    const toggle = getButtonByWf("SecretUnderTestRevealToggle");
    expect(input.type).toBe("password");
    expect(input.classList.contains("sm-secret")).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    await click(toggle);
    expect(input.type).toBe("text");
    expect(input.classList.contains("sm-secret")).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("Model 自定义模型测试保存成功走全局 toast,并清掉旧 sm-message", async () => {
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );

    await click(getButtonByText("接入其他云厂商 / 模型"));
    setInput(getInputByPlaceholder("https://your-endpoint/v1"), "https://proxy.example/v1");
    setInput(getInputByPlaceholder("sk-…"), "sk-custom");
    await click(getButtonByText("测试并保存"));
    await flush();

    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent).toContain("接口测试通过");
    expect(host?.querySelector(".sm-message")?.textContent ?? "").not.toContain("接口测试通过");
  });

  it("Model 自定义 baseURL 非法时「测试并保存」按钮被禁用(#15 proactive 阻止)", async () => {
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );

    await click(getButtonByText("接入其他云厂商 / 模型"));
    const saveBtn = getButtonByText("测试并保存");
    expect(saveBtn.hasAttribute("disabled")).toBe(false);
    setInput(getInputByPlaceholder("https://your-endpoint/v1"), "not-a-url");
    expect(saveBtn.hasAttribute("disabled")).toBe(true);
    expect(saveBtn.getAttribute("aria-disabled")).toBe("true");
    setInput(getInputByPlaceholder("https://your-endpoint/v1"), "https://proxy.example/v1");
    expect(saveBtn.hasAttribute("disabled")).toBe(false);
  });

  it("Model 自定义配置变更后丢弃旧测试成功响应且不清现有 key", async () => {
    setVisitorDeepseekKey("sk-current");
    let resolveTest!: (response: Response) => void;
    const deferredTest = new Promise<Response>((resolve) => {
      resolveTest = resolve;
    });
    const fallbackFetch = makeFetchMock();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      String(input).includes("/api/v1/settings/model/test-custom")
        ? deferredTest
        : fallbackFetch(input),
    ));

    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );
    await click(getButtonByText("修改配置"));
    await click(getButtonByText("接入其他云厂商 / 模型"));
    setInput(getInputByPlaceholder("https://your-endpoint/v1"), "https://a.example/v1");
    setInput(getInputByPlaceholder("sk-…"), "sk-a");
    await click(getButtonByText("测试并保存"));

    setInput(getInputByPlaceholder("sk-…"), "sk-b");
    await act(async () => {
      resolveTest(json({ ok: true }));
      await deferredTest;
    });
    await flush();

    expect(readCustomProvider()).toBeNull();
    expect(getVisitorDeepseekKey()).toBe("sk-current");
  });

  it("Model 档位默认 Flash,切 Pro 后持久化并随请求 header 透传", async () => {
    setVisitorDeepseekKey(`sk-${"A".repeat(32)}`);
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );

    expect(getButtonByWf("ModelTierFlash").getAttribute("aria-checked")).toBe("true");
    expect(getButtonByWf("ModelTierPro").getAttribute("aria-checked")).toBe("false");
    expect(getSelectedModelTier()).toBe("flash");
    expect(visitorKeyHeaders()["x-model-tier"]).toBeUndefined();

    await click(getButtonByWf("ModelTierPro"));
    expect(getButtonByWf("ModelTierPro").getAttribute("aria-checked")).toBe("true");
    expect(getSelectedModelTier()).toBe("pro");
    expect(visitorKeyHeaders()["x-model-tier"]).toBe("pro");
    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent).toContain("Pro");

    await click(getButtonByWf("ModelTierFlash"));
    expect(getSelectedModelTier()).toBe("flash");
    expect(visitorKeyHeaders()["x-model-tier"]).toBeUndefined();
  });

  it("provider 切换保留 DeepSeek/Kimi 各自 key，并透传 Kimi 双档 header", async () => {
    await setVisitorDeepseekKey("deepseek-local-key");
    await setVisitorModelKey("kimi", "kimi-local-key");
    setSelectedModelProvider("deepseek");
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );

    expect(getButtonByWf("ProviderDeepSeek").getAttribute("aria-checked")).toBe("true");
    await click(getButtonByWf("ProviderKimi"));
    expect(getSelectedModelProvider()).toBe("kimi");
    expect(getVisitorModelKey("deepseek")).toBe("deepseek-local-key");
    expect(getVisitorModelKey("kimi")).toBe("kimi-local-key");
    expect(visitorKeyHeaders()).toMatchObject({
      "x-model-provider": "kimi",
      "x-model-key": "kimi-local-key",
    });
    expect(visitorKeyHeaders()["x-deepseek-key"]).toBeUndefined();
    expect(host?.textContent).toContain("K2.7 / K3");

    await click(getButtonByWf("ProviderDeepSeek"));
    expect(getSelectedModelProvider()).toBe("deepseek");
    expect(visitorKeyHeaders()).toMatchObject({
      "x-model-provider": "deepseek",
      "x-model-key": "deepseek-local-key",
      "x-deepseek-key": "deepseek-local-key",
    });
  });

  it("未显式选择且无本地配置时保留 server 优先级；旧 DeepSeek key 仍锁定 DeepSeek", async () => {
    expect(getStoredModelProvider()).toBeNull();
    expect(getSelectedModelProvider()).toBe("deepseek");
    expect(visitorKeyHeaders()["x-model-provider"]).toBeUndefined();

    await setVisitorDeepseekKey("legacy-deepseek-key");
    expect(visitorKeyHeaders()).toMatchObject({
      "x-model-provider": "deepseek",
      "x-model-key": "legacy-deepseek-key",
      "x-deepseek-key": "legacy-deepseek-key",
    });
  });

  it("DeepSeek/Kimi 各自记忆第三方 baseUrl、key 与模型别名", async () => {
    await writeCustomProvider({
      protocol: "anthropic",
      baseUrl: "https://deepseek-proxy.example/v1",
      apiKey: "deepseek-proxy-key",
      modelFlash: "glm-flash",
      modelPro: "glm-pro",
    }, "deepseek");
    await writeCustomProvider({
      protocol: "anthropic",
      baseUrl: "https://kimi-proxy.example/v1",
      apiKey: "kimi-proxy-key",
      modelFlash: "proxy-k2.7",
      modelPro: "proxy-k3",
    }, "kimi");

    setSelectedModelProvider("kimi");
    expect(readCustomProvider("kimi")).toMatchObject({
      protocol: "openai",
      baseUrl: "https://kimi-proxy.example/v1",
      modelFlash: "proxy-k2.7",
      modelPro: "proxy-k3",
    });
    expect(visitorKeyHeaders()).toMatchObject({
      "x-model-provider": "kimi",
      "x-model-base-url": "https://kimi-proxy.example/v1",
      "x-model-flash": "proxy-k2.7",
      "x-model-pro": "proxy-k3",
    });

    setSelectedModelProvider("deepseek");
    expect(readCustomProvider("deepseek")).toMatchObject({
      protocol: "anthropic",
      baseUrl: "https://deepseek-proxy.example/v1",
      modelFlash: "glm-flash",
      modelPro: "glm-pro",
    });
  });

  it("Kimi key 不做输入自动调用，只在用户显式点测试连接时发一条请求", async () => {
    setSelectedModelProvider("kimi");
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );

    setInput(getInputByWf("ModelKeyInput"), "kimi-explicit-test-key");
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 650));
    });
    expect(
      fetchMock.mock.calls.filter((call) =>
        String(call[0]).includes("/api/v1/settings/model/balance")).length,
    ).toBe(0);

    await click(getButtonByText("测试连接"));
    const testCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/api/v1/settings/model/balance"));
    expect(testCalls).toHaveLength(1);
    expect(testCalls[0]?.[1]).toMatchObject({
      headers: {
        "x-model-provider": "kimi",
        "x-model-key": "kimi-explicit-test-key",
      },
    });
    expect(host?.textContent).toContain("Kimi 短对话测试已连通");
  });

  it("DeepSeek 余额检测在途切到 Kimi 时复位 loading 并丢弃迟到结果", async () => {
    await setVisitorDeepseekKey("deepseek-balance-key");
    await setVisitorModelKey("kimi", "kimi-balance-key");
    let resolveBalance!: (response: Response) => void;
    const deferredBalance = new Promise<Response>((resolve) => {
      resolveBalance = resolve;
    });
    const fallbackFetch = makeFetchMock();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      String(input).includes("/api/v1/settings/model/balance")
        ? deferredBalance
        : fallbackFetch(input),
    ));

    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );
    await waitForCondition(
      () => (host?.textContent ?? "").includes("正在检测连接"),
      "DeepSeek 余额检测开始",
    );
    await click(getButtonByWf("ProviderKimi"));

    expect(host?.textContent ?? "").not.toContain("正在检测连接");
    await act(async () => {
      resolveBalance(json({ ok: false, error: "迟到的 DeepSeek 结果" }));
      await deferredBalance;
    });
    await flush();
    expect(host?.textContent ?? "").not.toContain("迟到的 DeepSeek 结果");
  });

  it("Kimi 测试连接在途切到 DeepSeek 时中止并丢弃迟到结果", async () => {
    setSelectedModelProvider("kimi");
    let resolveVerify!: (response: Response) => void;
    const deferredVerify = new Promise<Response>((resolve) => {
      resolveVerify = resolve;
    });
    const fallbackFetch = makeFetchMock();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      String(input).includes("/api/v1/settings/model/balance")
        ? deferredVerify
        : fallbackFetch(input),
    ));

    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );
    setInput(getInputByWf("ModelKeyInput"), "kimi-late-key");
    await click(getButtonByText("测试连接"));
    await click(getButtonByWf("ProviderDeepSeek"));

    await act(async () => {
      resolveVerify(json({ ok: true }));
      await deferredVerify;
    });
    await flush();
    expect(getButtonByWf("ProviderDeepSeek").getAttribute("aria-checked")).toBe("true");
    expect(host?.textContent ?? "").not.toContain("Kimi 短对话测试已连通");
  });

  it("Kimi 测试连接在途修改 key 时作废旧请求并丢弃迟到成功", async () => {
    setSelectedModelProvider("kimi");
    let resolveVerify!: (response: Response) => void;
    const deferredVerify = new Promise<Response>((resolve) => {
      resolveVerify = resolve;
    });
    const fallbackFetch = makeFetchMock();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      String(input).includes("/api/v1/settings/model/balance")
        ? deferredVerify
        : fallbackFetch(input),
    ));

    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );
    setInput(getInputByWf("ModelKeyInput"), "kimi-key-a");
    await click(getButtonByText("测试连接"));
    setInput(getInputByWf("ModelKeyInput"), "kimi-key-b");

    await act(async () => {
      resolveVerify(json({ ok: true }));
      await deferredVerify;
    });
    await flush();
    expect(getInputByWf("ModelKeyInput").value).toBe("kimi-key-b");
    expect(getButtonByText("测试连接").hasAttribute("disabled")).toBe(false);
    expect(host?.textContent ?? "").not.toContain("Kimi 短对话测试已连通");
  });

  it("Kimi 测试连接在途切换档位时作废旧请求并丢弃迟到成功", async () => {
    setSelectedModelProvider("kimi");
    let resolveVerify!: (response: Response) => void;
    const deferredVerify = new Promise<Response>((resolve) => {
      resolveVerify = resolve;
    });
    const fallbackFetch = makeFetchMock();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      String(input).includes("/api/v1/settings/model/balance")
        ? deferredVerify
        : fallbackFetch(input),
    ));

    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );
    setInput(getInputByWf("ModelKeyInput"), "kimi-tier-key");
    await click(getButtonByText("测试连接"));
    await click(getButtonByWf("ModelTierPro"));

    await act(async () => {
      resolveVerify(json({ ok: true }));
      await deferredVerify;
    });
    await flush();
    expect(getButtonByWf("ModelTierPro").getAttribute("aria-checked")).toBe("true");
    expect(getButtonByText("测试连接").hasAttribute("disabled")).toBe(false);
    expect(host?.textContent ?? "").not.toContain("Kimi 短对话测试已连通");
  });

  it.each([
    [false, "未配置"],
    [true, "自动启用"],
  ])("Kimi 原生识图按 key 配置状态显示徽标：configured=%s", async (configured, badge) => {
    setSelectedModelProvider("kimi");
    if (configured) await setVisitorModelKey("kimi", "kimi-vision-key");

    await render(<VisionPanel />);

    expect(host?.querySelector(".ss-card .ss-badge")?.textContent).toContain(badge);
  });

  it("N7: 非标准长度 key 仍会自动验证并可保存", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    await render(
      <ConfirmProvider>
        <ToastProvider>
          <ModelSettingsPanel />
        </ToastProvider>
      </ConfirmProvider>,
    );

    const key = "sk-short_key.with-symbol";
    setInput(getInputByWf("ModelKeyInput"), key);
    await waitForCondition(
      () => fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/v1/settings/model/balance")),
      "非标准 key 自动验证",
    );
    await click(getButtonByText("保存"));

    expect(getVisitorDeepseekKey()).toBe(key);
    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent).toContain("已验证并保存");
  });

  it("N7: 验证失败时仍可确认保存", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/v1/settings/model/balance")) {
        return json({ ok: false, error: "验证失败" }, 401);
      }
      return makeFetchMock()(input);
    }));
    await render(
      <ConfirmProvider>
        <ToastProvider>
          <ModelSettingsPanel />
        </ToastProvider>
      </ConfirmProvider>,
    );

    const key = "sk-another_nonstandard-key";
    setInput(getInputByWf("ModelKeyInput"), key);
    await waitForCondition(
      () => (host?.textContent ?? "").includes("验证失败"),
      "验证失败提示",
    );
    await click(getButtonByText("保存"));
    expect(host?.querySelector('[data-wf="GlobalConfirm"]')?.textContent).toContain("仍要保存这个 key");
    await click(getButtonByText("仍要保存"));

    expect(getVisitorDeepseekKey()).toBe(key);
  });

  it("Vision 测试保存成功走全局 toast,失败提示位置不被成功文案占用", async () => {
    await render(
      <ToastProvider>
        <VisionPanel />
      </ToastProvider>,
    );

    setInput(getInputByPlaceholder("https://your-endpoint/v1"), "https://vision.example/v1");
    setInput(getInputByPlaceholder("sk-…"), "sk-vision");
    setInput(getInputByPlaceholder("如 qwen-vl-max / gpt-4o / claude-3-5-sonnet"), "qwen-vl-max");
    await click(getButtonByText("测试并保存"));
    await flush();

    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent).toContain("图像识别已启用");
    expect(host?.querySelector(".sm-message")?.textContent ?? "").not.toContain("测试通过");
  });

  it("Vision 配置变更后丢弃旧测试成功响应", async () => {
    let resolveTest!: (response: Response) => void;
    const deferredTest = new Promise<Response>((resolve) => {
      resolveTest = resolve;
    });
    const fallbackFetch = makeFetchMock();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      String(input).includes("/api/v1/settings/vision/test")
        ? deferredTest
        : fallbackFetch(input),
    ));

    await render(
      <ToastProvider>
        <VisionPanel />
      </ToastProvider>,
    );
    setInput(getInputByPlaceholder("https://your-endpoint/v1"), "https://a.example/v1");
    setInput(getInputByPlaceholder("sk-…"), "sk-a");
    setInput(getInputByPlaceholder("如 qwen-vl-max / gpt-4o / claude-3-5-sonnet"), "vision-a");
    await click(getButtonByText("测试并保存"));

    setInput(getInputByPlaceholder("https://your-endpoint/v1"), "https://b.example/v1");
    await act(async () => {
      resolveTest(json({ ok: true }));
      await deferredTest;
    });
    await flush();

    expect(readVisionProvider()).toBeNull();
  });

  it("F3: Vision 落盘期间输入变更后不提交旧配置或假成功", async () => {
    let resolvePersist!: (ok: boolean) => void;
    const setVisionProvider = vi.fn(() => new Promise<boolean>((resolve) => {
      resolvePersist = resolve;
    }));
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: { isDesktop: true, getVisionProvider: () => null, setVisionProvider },
    });
    __resetClientPersistCacheForTests();

    await render(
      <ToastProvider>
        <VisionPanel />
      </ToastProvider>,
    );
    const baseInput = getInputByPlaceholder("https://your-endpoint/v1");
    setInput(baseInput, "https://old.example/v1");
    setInput(getInputByPlaceholder("sk-…"), "sk-old");
    setInput(getInputByPlaceholder("如 qwen-vl-max / gpt-4o / claude-3-5-sonnet"), "vision-old");
    await click(getButtonByText("测试并保存"));
    await waitForCondition(() => setVisionProvider.mock.calls.length === 1, "Vision 开始落盘");

    expect(baseInput.disabled).toBe(true);
    baseInput.disabled = false;
    setInput(baseInput, "https://new.example/v1");
    await act(async () => resolvePersist(true));
    await flush();

    expect(baseInput.value).toBe("https://new.example/v1");
    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent ?? "").not.toContain("图像识别已启用");
  });

  it("F3: Model 落盘期间输入变更后不关编辑态或报假成功", async () => {
    let resolvePersist!: (ok: boolean) => void;
    const setCustomProvider = vi.fn(() => new Promise<boolean>((resolve) => {
      resolvePersist = resolve;
    }));
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: { isDesktop: true, getCustomProvider: () => null, setCustomProvider },
    });
    __resetClientPersistCacheForTests();

    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );
    await click(getButtonByText("接入其他云厂商 / 模型"));
    const baseInput = getInputByPlaceholder("https://your-endpoint/v1");
    setInput(baseInput, "https://old.example/v1");
    setInput(getInputByPlaceholder("sk-…"), "sk-old");
    await click(getButtonByText("测试并保存"));
    await waitForCondition(() => setCustomProvider.mock.calls.length === 1, "Model 开始落盘");

    expect(baseInput.disabled).toBe(true);
    baseInput.disabled = false;
    setInput(baseInput, "https://new.example/v1");
    await act(async () => resolvePersist(true));
    await flush();

    expect(baseInput.value).toBe("https://new.example/v1");
    expect(getButtonByText("测试并保存")).toBeTruthy();
    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent ?? "").not.toContain("接口测试通过");
  });

  it("Vision 测试期间停用后丢弃旧成功响应且不重新启用", async () => {
    writeVisionProvider({
      enabled: true,
      protocol: "openai",
      baseUrl: "https://vision.example/v1",
      apiKey: "sk-current",
      model: "vision-current",
    });
    let resolveTest!: (response: Response) => void;
    const deferredTest = new Promise<Response>((resolve) => {
      resolveTest = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(() => deferredTest));

    await render(
      <ToastProvider>
        <VisionPanel />
      </ToastProvider>,
    );
    await click(getButtonByText("测试并保存"));
    await click(getButtonByText("已启用"));
    expect(readVisionProvider()?.enabled).toBe(false);

    await act(async () => {
      resolveTest(json({ ok: true }));
      await deferredTest;
    });
    await flush();

    expect(readVisionProvider()?.enabled).toBe(false);
    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent ?? "").not.toContain(
      "图像识别已启用",
    );
  });

  it("Vision 测试期间清除后丢弃旧成功响应且不写回配置", async () => {
    writeVisionProvider({
      enabled: true,
      protocol: "openai",
      baseUrl: "https://vision.example/v1",
      apiKey: "sk-current",
      model: "vision-current",
    });
    let resolveTest!: (response: Response) => void;
    const deferredTest = new Promise<Response>((resolve) => {
      resolveTest = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(() => deferredTest));

    await render(
      <ConfirmProvider>
        <ToastProvider>
          <VisionPanel />
        </ToastProvider>
      </ConfirmProvider>,
    );
    await click(getButtonByText("测试并保存"));
    await click(getButtonByText("清除"));
    await click(getButtonByText("清除配置"));
    expect(readVisionProvider()).toBeNull();

    await act(async () => {
      resolveTest(json({ ok: true }));
      await deferredTest;
    });
    await flush();

    expect(readVisionProvider()).toBeNull();
    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent ?? "").not.toContain(
      "图像识别已启用",
    );
  });

  it("baseURL 即时校验显示字段错误,空值仍可点击并给就近 message", async () => {
    await render(<VisionPanel />);

    const base = getInputByPlaceholder("https://your-endpoint/v1");
    setInput(base, "vision.example/v1");
    expect(base.getAttribute("aria-invalid")).toBe("true");
    expect(host?.textContent).toContain("需以 http(s):// 开头");

    setInput(base, "");
    expect(base.getAttribute("aria-invalid")).toBe("false");
    await click(getButtonByText("测试并保存"));
    expect(host?.querySelector(".sm-message")?.textContent).toContain("请填写 API 地址");
  });

  it("用量明细日期选择器只客户端过滤 day rows,不向服务端追加 date 参数", async () => {
    setVisitorDeepseekKey(`sk-${"A".repeat(32)}`);
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    await render(<ModelSettingsPanel />);
    await flush();

    const tableBefore = getTable();
    expect(tableBefore.textContent).toContain("2026-06-24");
    expect(tableBefore.textContent).toContain("2026-06-25");

    await click(getDateTrigger());
    await click(getButtonByLabel("上个月"));
    const consumedDay = getButtonByLabel("2026-06-24");
    const idleDay = getButtonByLabel("2026-06-23");
    expect(consumedDay.querySelector(".skin-calendar__mark")).not.toBeNull();
    expect(consumedDay.disabled).toBe(false);
    expect(idleDay.disabled).toBe(true);
    await click(consumedDay);
    const filteredTable = getTable();
    expect(filteredTable.textContent).toContain("2026-06-24");
    expect(filteredTable.textContent).not.toContain("2026-06-25");

    await click(getButtonByText("总计"));
    await flush();
    expect(host?.textContent).toContain("日期筛选仅支持按天视图");
    expect(fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.includes("date="))).toBe(false);
  });

  it("用量明细默认小白模式只展示聚合列", async () => {
    setVisitorDeepseekKey(`sk-${"A".repeat(32)}`);
    await render(<ModelSettingsPanel />);
    await flush();

    const headers = Array.from(getTable().querySelectorAll("th")).map(
      (cell) => cell.textContent?.replace(/\?/g, "").replace(/\s+/g, " ").trim(),
    );
    expect(headers).toEqual(["日期", "输入", "输出", "缓存命中率", "估算费用"]);
    expect(getTable().textContent).not.toContain("调用点");
    expect(getTable().textContent).not.toContain("请求覆盖");
    expect(getButtonByWf("UsageModeToggle").textContent?.trim()).toBe("用量明细");
    expect(getButtonByWf("UsageModeToggle").getAttribute("aria-label")).toContain("小白模式");
    expect(getButtonByWf("UsageModeToggle").querySelector("small")).toBeNull();
  });

  it("点击用量明细标题切换专家模式并披露完整列", async () => {
    setVisitorDeepseekKey(`sk-${"A".repeat(32)}`);
    await render(<ModelSettingsPanel />);
    await flush();

    const toggle = getButtonByWf("UsageModeToggle");
    await click(toggle);

    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.textContent?.trim()).toBe("用量明细");
    expect(toggle.getAttribute("aria-label")).toContain("专家模式");
    expect(getTable().parentElement?.classList.contains("md-table-scroll")).toBe(true);
    const headerText = Array.from(getTable().querySelectorAll("th"))
      .map((cell) => cell.textContent ?? "")
      .join(" ");
    expect(headerText).toContain("模型");
    expect(headerText).toContain("调用点");
    expect(headerText).toContain("请求覆盖");
  });

  it("专家模式按文档分组，默认收起且可展开收起调用点", async () => {
    setVisitorDeepseekKey(`sk-${"A".repeat(32)}`);
    const fallbackFetch = makeFetchMock();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/v1/usage/summary?view=session")) {
        return json({
          rows: [
            { ...usageRow("session-1", "deepseek-v4-flash", 1200, 500, 0.001), label: "测试文档" },
            {
              ...usageRow("session-1", "deepseek-v4-pro", 800, 300, 0.002),
              callSite: "writeDraft",
              label: "测试文档",
            },
          ],
        });
      }
      return fallbackFetch(input, init);
    }));
    await render(<ModelSettingsPanel />);
    await click(getButtonByWf("UsageModeToggle"));
    await click(getButtonByText("按文档"));
    await flush();

    expect(getTable().querySelectorAll('[data-wf="UsageGroupRow"]')).toHaveLength(1);
    expect(getTable().querySelectorAll('[data-wf="UsageDetailRow"]')).toHaveLength(0);
    const groupToggle = getTable().querySelector<HTMLButtonElement>(".md-usage-group-toggle");
    expect(groupToggle?.textContent).toContain("测试文档");
    expect(groupToggle?.getAttribute("aria-expanded")).toBe("false");

    await click(groupToggle!);
    expect(groupToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(getTable().querySelectorAll('[data-wf="UsageDetailRow"]')).toHaveLength(2);
    expect(getTable().textContent).toContain("writeDraft");

    await click(groupToggle!);
    expect(getTable().querySelectorAll('[data-wf="UsageDetailRow"]')).toHaveLength(0);
  });

  it("专家按天视图按天→文档→调用点三层展开，且各层默认收起", async () => {
    setVisitorDeepseekKey(`sk-${"A".repeat(32)}`);
    await render(<ModelSettingsPanel />);
    await click(getButtonByWf("UsageModeToggle"));
    await flush();

    expect(getTable().querySelectorAll('[data-wf="UsageGroupRow"]')).toHaveLength(2);
    expect(getTable().querySelectorAll('[data-wf="UsageDocumentRow"]')).toHaveLength(0);
    expect(getTable().querySelectorAll('[data-wf="UsageDetailRow"]')).toHaveLength(0);

    const dayToggle = getTable().querySelector<HTMLButtonElement>(".md-usage-group-toggle");
    expect(dayToggle?.textContent).toContain("2026-06-24");
    await click(dayToggle!);

    expect(getTable().querySelectorAll('[data-wf="UsageDocumentRow"]')).toHaveLength(2);
    expect(getTable().querySelectorAll('[data-wf="UsageDetailRow"]')).toHaveLength(0);
    const documentToggle = getTable().querySelector<HTMLButtonElement>(
      ".md-usage-group-toggle--document",
    );
    expect(documentToggle?.textContent).toContain("文档甲");
    expect(documentToggle?.getAttribute("aria-expanded")).toBe("false");

    await click(documentToggle!);
    expect(documentToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(getTable().querySelectorAll('[data-wf="UsageDetailRow"]')).toHaveLength(2);
    expect(getTable().textContent).toContain("writeDraft");

    await click(documentToggle!);
    expect(getTable().querySelectorAll('[data-wf="UsageDetailRow"]')).toHaveLength(0);
    await click(dayToggle!);
    expect(getTable().querySelectorAll('[data-wf="UsageDocumentRow"]')).toHaveLength(0);
  });

  it("用量明细模式持久化到本地并在重新挂载后恢复", async () => {
    setVisitorDeepseekKey(`sk-${"A".repeat(32)}`);
    await render(<ModelSettingsPanel />);
    await click(getButtonByWf("UsageModeToggle"));
    expect(window.localStorage.getItem("qingagent:model-usage-mode")).toBe("expert");

    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    await render(<ModelSettingsPanel />);
    await flush();

    expect(getButtonByWf("UsageModeToggle").getAttribute("aria-pressed")).toBe("true");
    expect(getButtonByWf("UsageModeToggle").textContent?.trim()).toBe("用量明细");
    expect(getButtonByWf("UsageModeToggle").getAttribute("aria-label")).toContain("专家模式");
  });

  it("缓存 hit+miss 均缺失时展示未知而不是 0%", async () => {
    setVisitorDeepseekKey(`sk-${"A".repeat(32)}`);
    await render(<ModelSettingsPanel />);
    await click(getButtonByText("总计"));
    await click(getButtonByWf("UsageModeToggle"));
    await flush();
    await click(getTable().querySelector<HTMLButtonElement>(".md-usage-group-toggle")!);
    expect(getTable().textContent).toContain("未知");
    expect(getTable().textContent).toContain("100% · 1/1");
  });

  it("设置弹层初始焦点落关闭按钮,Tab 循环留在弹层内,关闭后恢复触发焦点", async () => {
    resetSettingsDialogA11yForTest();
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.textContent = "打开设置";
    document.body.appendChild(trigger);
    trigger.focus();

    const sheet = document.createElement("div");
    sheet.className = "qj-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.innerHTML = `
      <button type="button" class="qj-sheet-close">关闭</button>
      <button type="button" role="tab" aria-selected="true">模型</button>
      <button type="button" data-danger="true">危险操作</button>
    `;
    document.body.appendChild(sheet);
    const close = sheet.querySelector<HTMLButtonElement>(".qj-sheet-close");
    const danger = sheet.querySelector<HTMLButtonElement>("[data-danger]");
    expect(close).not.toBeNull();
    expect(danger).not.toBeNull();

    ensureSettingsDialogA11y();
    await waitForA11yState(
      () => document.activeElement === close,
      "settings dialog close button focus",
    );

    expect(document.activeElement).toBe(close);
    expect(document.activeElement).not.toBe(danger);

    danger?.focus();
    await keyDown(danger!, "Tab");
    expect(document.activeElement).toBe(close);

    sheet.remove();
    await waitForA11yState(
      () => document.activeElement === trigger,
      "settings dialog trigger focus restore",
    );
    expect(document.activeElement).toBe(trigger);
  });
});

let aboutPushCallbacks: Array<(payload: AboutUpdateStatus) => void> = [];

type AboutUpdateStatus = {
  kind: "soft-ready" | "soft-available" | "force" | "mac-manual" | "none" | "error";
  version?: string;
  notesUrl?: string;
};

describe("About Panel", () => {
  beforeEach(() => {
    aboutPushCallbacks = [];
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    document.body.innerHTML = "";
    aboutPushCallbacks = [];
    resetDesktopUpdateStoreForTest();
    Object.defineProperty(window, "electron", { configurable: true, value: undefined });
    vi.restoreAllMocks();
  });

  it("桌面端点「检查更新」→ 已是最新时状态显示已是最新版本", async () => {
    installAboutElectron({ checkForUpdate: vi.fn(async () => ({ kind: "none" as const })) });
    await renderAbout();

    expect(getAboutVersion().textContent).toContain("v1.2.0");
    await click(getButtonByWf("AboutUpdateButton"));
    expect(getAboutStatus().textContent).toContain("已是最新版本");
  });

  it("发现新版本(win 自动下载)状态显示正在下载", async () => {
    installAboutElectron({
      checkForUpdate: vi.fn(async () => ({ kind: "soft-available" as const, version: "1.3.0" })),
    });
    await renderAbout();

    await click(getButtonByWf("AboutUpdateButton"));
    const status = getAboutStatus().textContent ?? "";
    expect(status).toContain("发现新版本 v1.3.0");
    expect(status).toContain("正在下载");
  });

  it("断网检查失败显示失败文案(不假报已是最新)", async () => {
    installAboutElectron({ checkForUpdate: vi.fn(async () => ({ kind: "error" as const })) });
    await renderAbout();

    await click(getButtonByWf("AboutUpdateButton"));
    const status = getAboutStatus().textContent ?? "";
    expect(status).toContain("检查更新失败");
    expect(status).not.toContain("已是最新");
  });

  it("mac 手动更新按钮变前往下载页并调用 openDownloadPage", async () => {
    const openDownloadPage = vi.fn(async () => undefined);
    installAboutElectron({
      platform: "darwin",
      openDownloadPage,
      checkForUpdate: vi.fn(async () => ({ kind: "mac-manual" as const, version: "1.3.0" })),
    });
    await renderAbout();

    await click(getButtonByWf("AboutUpdateButton"));
    const btn = getButtonByWf("AboutUpdateButton");
    expect(btn.textContent).toContain("前往下载页");
    await click(btn);
    expect(openDownloadPage).toHaveBeenCalledTimes(1);
  });

  it("下载就绪推送到达后按钮变重启更新并调用 quitAndInstall", async () => {
    const quitAndInstall = vi.fn(async () => undefined);
    installAboutElectron({ quitAndInstall });
    await renderAbout();

    await emitAboutPush({ kind: "soft-ready", version: "1.3.0" });
    const btn = getButtonByWf("AboutUpdateButton");
    expect(btn.textContent).toContain("重启更新");
    await click(btn);
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("挂载订阅后查询到下载就绪态会立即显示重启更新", async () => {
    const getUpdateStatus = vi.fn(async () => ({ kind: "soft-ready" as const, version: "1.3.0" }));
    installAboutElectron({ getUpdateStatus });
    await renderAbout();

    await vi.waitFor(() => expect(getButtonByWf("AboutUpdateButton").textContent).toContain("重启更新"));
    expect(getUpdateStatus).toHaveBeenCalledTimes(1);
  });

  it("开发构建按钮禁用且提示不参与更新", async () => {
    installAboutElectron({ appVersion: "1.2.0-dev.3" });
    await renderAbout();

    const btn = getButtonByWf("AboutUpdateButton");
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(getAboutStatus().textContent).toContain("开发构建不参与更新");
  });

  it("web 端降级:显示网页版、无更新按钮、无内核信息", async () => {
    Object.defineProperty(window, "electron", { configurable: true, value: undefined });
    await renderAbout();

    expect(getAboutVersion().textContent).toContain("网页版");
    expect(host?.querySelector('[data-wf="AboutUpdateButton"]')).toBeNull();
    expect(host?.querySelector('[data-wf="AboutKernel"]')).toBeNull();
  });

  it("点击版本号复制版本信息并走全局 toast", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    installAboutElectron({});
    await renderAbout();

    await click(getAboutVersion());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent).toContain("版本信息已复制");
  });
});

function installAboutElectron(overrides: Record<string, unknown>): void {
  const electron = {
    platform: "win32",
    isDesktop: true,
    appVersion: "1.2.0",
    versions: { electron: "33.4.11", chrome: "130.0.0", node: "20.18.0" },
    onUpdateStatus: (cb: (payload: AboutUpdateStatus) => void) => {
      aboutPushCallbacks.push(cb);
      return () => {
        aboutPushCallbacks = aboutPushCallbacks.filter((item) => item !== cb);
      };
    },
    getUpdateStatus: vi.fn(async () => ({ kind: "none" as const })),
    quitAndInstall: vi.fn(async () => undefined),
    openDownloadPage: vi.fn(async () => undefined),
    checkForUpdate: vi.fn(async () => ({ kind: "none" as const })),
    getThirdPartyNotices: vi.fn(async () => null),
    ...overrides,
  };
  Object.defineProperty(window, "electron", { configurable: true, value: electron });
}

async function renderAbout(): Promise<void> {
  await render(
    <ToastProvider>
      <AboutPanel />
    </ToastProvider>,
  );
}

async function emitAboutPush(payload: AboutUpdateStatus): Promise<void> {
  const cb = aboutPushCallbacks[0];
  if (!cb) throw new Error("about update push listener not registered");
  await act(async () => {
    cb(payload);
  });
  await flush();
}

function getAboutVersion(): HTMLButtonElement {
  const el = host?.querySelector<HTMLButtonElement>('[data-wf="AboutVersion"]');
  if (!el) throw new Error("about version not found");
  return el;
}

function getAboutStatus(): HTMLElement {
  const el = host?.querySelector<HTMLElement>('[data-wf="AboutUpdateStatus"]');
  if (!el) throw new Error("about update status not found");
  return el;
}

async function render(element: ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
  });
  await flush();
}

function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/v1/settings/model/test-custom")) return json({ ok: true });
    if (url.includes("/api/v1/settings/vision/test")) return json({ ok: true });
    if (url.includes("/api/v1/settings/model/balance")) {
      return json({
        ok: true,
        isAvailable: true,
        balances: [{ currency: "CNY", total: "20", granted: "0", toppedUp: "20" }],
      });
    }
    if (url.includes("/api/v1/settings/model")) {
      return json({ apiKeyConfigured: false, maskedTail: null, source: "none", params: null });
    }
    if (url.includes("/api/v1/usage/summary?view=day")) return json({ rows: dayRows });
    if (url.includes("/api/v1/usage/summary?view=total")) {
      return json({
        rows: [
          usageRow("total", "deepseek-v4-flash", 3000, 900, 0.003),
          usageRow("total", "deepseek-v4-pro", 2000, 800, 0.002, false),
        ],
      });
    }
    if (url.includes("/api/v1/usage/summary?view=session")) {
      return json({ rows: [{ ...usageRow("session-1", "deepseek-v4-flash", 1200, 500, 0.001), label: "测试文档" }] });
    }
    if (url.includes("/api/v1/usage/docstats")) return json({ docs: 2, words: 1200 });
    return json({});
  });
}

function usageRow(
  bucket: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  costCny: number,
  cacheKnown = true,
) {
  return {
    bucket,
    callSite: "agent",
    modelId,
    inputTokens,
    outputTokens,
    cacheHitTokens: cacheKnown ? Math.floor(inputTokens / 2) : 0,
    cacheMissTokens: cacheKnown ? Math.ceil(inputTokens / 2) : 0,
    cacheCreationTokens: 0,
    cacheHitRate: cacheKnown ? 0.5 : null,
    calls: 1,
    recordedCalls: 1,
    missingCalls: 0,
    coverageRate: 1,
    costCny,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getInputByWf(dataWf: string): HTMLInputElement {
  const input = host?.querySelector<HTMLInputElement>(`input[data-wf="${dataWf}"]`);
  if (!input) throw new Error(`${dataWf} input not found`);
  return input;
}

function getButtonByWf(dataWf: string): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>(`button[data-wf="${dataWf}"]`);
  if (!button) throw new Error(`${dataWf} button not found`);
  return button;
}

function getButtonByText(text: string): HTMLButtonElement {
  const button = Array.from(host?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
    (node) => {
      const normalized = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
      return normalized === text || normalized.includes(text);
    },
  );
  if (!button) throw new Error(`${text} button not found`);
  return button;
}

function getInputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = Array.from(host?.querySelectorAll<HTMLInputElement>("input") ?? []).find(
    (node) => node.placeholder === placeholder,
  );
  if (!input) throw new Error(`${placeholder} input not found`);
  return input;
}

function getDateTrigger(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>('button[aria-label="筛选用量日期"]');
  if (!button) throw new Error("date trigger not found");
  return button;
}

function getButtonByLabel(label: string): HTMLButtonElement {
  const button = document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`${label} button not found`);
  return button;
}

function getTable(): HTMLTableElement {
  const table = host?.querySelector<HTMLTableElement>(".md-table");
  if (!table) throw new Error("usage table not found");
  return table;
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function keyDown(target: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForA11y(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 5));
  });
}

async function waitForA11yState(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() <= deadline) {
    await waitForA11y();
    if (predicate()) return;
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
  // 全量并发测试时 worker 可能长时间被其他包抢占；这里还覆盖 600ms 防抖链路，
  // 放宽失败窗口以避免把调度抖动误判成产品回归。
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    await flush();
    if (predicate()) return;
  }
  throw new Error(`Timed out waiting for ${label}`);
}

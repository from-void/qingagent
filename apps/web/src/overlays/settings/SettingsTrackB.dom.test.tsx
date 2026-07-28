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

  it("状态一 · 初装零配置:引导条 + 两张介绍卡(DeepSeek 带推荐标),不出档位", async () => {
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );

    const onboard = host?.querySelector('[data-wf="ModelOnboardHint"]');
    expect(onboard?.textContent).toContain("推荐先接 DeepSeek");
    expect(host?.querySelectorAll(".vd-card")).toHaveLength(2);
    expect(host?.querySelector('[data-wf="ModelVendorCardDeepseek"]')?.textContent)
      .toContain("推 荐");
    expect(host?.querySelector('[data-wf="ModelVendorCardDeepseek"]')?.textContent)
      .toContain("写作成本最低");
    expect(host?.querySelector('[data-wf="ModelVendorCardKimi"]')?.textContent)
      .toContain("能看图理解配图");
    // 没配置就没有档位、没有使用中
    expect(host?.querySelector('[data-wf="ModelTierChipDeepseek"]')).toBeNull();
    expect(host?.textContent).not.toContain("使用中");
    expect(getButtonByWf("ModelConfigDeepseek").textContent).toContain("去配置");
    // 看板仍在,走既有空态文案
    expect(host?.textContent).toContain("用量看板");
  });

  it("状态二 · 单家已配:DeepSeek 金描边使用中,Kimi 仍是介绍卡", async () => {
    await setVisitorDeepseekKey("deepseek-local-key");
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );

    expect(host?.querySelector('[data-wf="ModelOnboardHint"]')).toBeNull();
    const deepseekCard = host?.querySelector('[data-wf="ModelVendorCardDeepseek"]');
    expect(deepseekCard?.classList.contains("vd-card--on")).toBe(true);
    expect(getButtonByWf("ModelUsingDeepseek").textContent).toContain("使用中");
    expect(getButtonByWf("ModelTierChipDeepseek").textContent).toBe("Flash");
    // 卡面不展示密钥
    expect(deepseekCard?.textContent).not.toContain("••••");
    expect(deepseekCard?.textContent).not.toContain("deepseek-local-key");
    const kimiCard = host?.querySelector('[data-wf="ModelVendorCardKimi"]');
    expect(kimiCard?.classList.contains("vd-card--on")).toBe(false);
    expect(getButtonByWf("ModelConfigKimi").textContent).toContain("去配置");
    // 余额只在 DeepSeek 卡出现
    await waitForCondition(
      () => (deepseekCard?.textContent ?? "").includes("余额"),
      "DeepSeek 卡余额",
    );
    expect(kimiCard?.textContent).not.toContain("余额");
  });

  it("状态三 · 两家都已配:非使用卡出「启 用」,两卡都有档位与配置入口", async () => {
    await setVisitorDeepseekKey("deepseek-local-key");
    await setVisitorModelKey("kimi", "kimi-local-key");
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );

    expect(getButtonByWf("ModelUsingDeepseek")).toBeTruthy();
    expect(getButtonByWf("ModelEnableKimi").textContent).toContain("启 用");
    expect(getButtonByWf("ModelTierChipDeepseek")).toBeTruthy();
    expect(getButtonByWf("ModelTierChipKimi")).toBeTruthy();
    expect(getButtonByWf("ModelConfigDeepseek").textContent).toContain("配 置");
    expect(getButtonByWf("ModelConfigKimi").textContent).toContain("配 置");

    await click(getButtonByWf("ModelEnableKimi"));
    expect(getButtonByWf("ModelUsingKimi")).toBeTruthy();
    expect(getButtonByWf("ModelEnableDeepseek").textContent).toContain("启 用");
  });

  it("二级配置页:卡片进入、← 返回回主视图,官方/其他两 tab 与提示文案齐备", async () => {
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );

    await openVendorConfig();
    const page = host?.querySelector('[data-wf="ModelConfigPage"]');
    expect(page).not.toBeNull();
    expect(page?.textContent).toContain("如何配置 DeepSeek");
    expect(page?.textContent).toContain("接入 DeepSeek 官方 API");
    expect(page?.textContent).toContain("接入其他云厂商 / 模型");
    expect(page?.textContent).toContain("Key 只保存在本机");
    expect(page?.textContent).not.toContain("本浏览器");
    // 主视图元素在二级页里不出现(同弹层内视图切换)
    expect(host?.querySelector(".vd-grid")).toBeNull();
    expect(host?.textContent).not.toContain("用量看板");

    await click(getButtonByWf("ModelConfigBack"));
    expect(host?.querySelector('[data-wf="ModelConfigPage"]')).toBeNull();
    expect(host?.querySelector(".vd-grid")).not.toBeNull();
  });

  it("二级页保存 key 后回主视图并直接成为使用中", async () => {
    await render(
      <ConfirmProvider>
        <ToastProvider>
          <ModelSettingsPanel />
        </ToastProvider>
      </ConfirmProvider>,
    );

    await openVendorConfig("kimi");
    setInput(getInputByWf("ModelKeyInput"), "kimi-fresh-key");
    await click(getButtonByText("保存"));
    await click(getButtonByText("仍要保存"));

    expect(getVisitorModelKey("kimi")).toBe("kimi-fresh-key");
    expect(host?.querySelector('[data-wf="ModelConfigPage"]')).toBeNull();
    expect(getSelectedModelProvider()).toBe("kimi");
    expect(getButtonByWf("ModelUsingKimi")).toBeTruthy();
  });

  // —— 「使用中」不变式:只要存在已配置的厂商,必须有且恰好一家在使用中 ——

  it("不变式 · 仅一家已配:那家必然使用中,不出现无处可切的「启 用」", async () => {
    await setVisitorDeepseekKey("deepseek-local-key");
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );

    expect(getButtonByWf("ModelUsingDeepseek").textContent).toContain("使用中");
    expect(host?.querySelector('[data-wf="ModelEnableDeepseek"]')).toBeNull();
    expect(host?.querySelector('[data-wf="ModelEnableKimi"]')).toBeNull();
    expect(getButtonByWf("ModelConfigKimi").textContent).toContain("去配置");
  });

  it("不变式 · 使用中指向未配置那家时自动回落到有配置的一家并落盘", async () => {
    // 非法态复现:modelProvider=kimi(如早前启用过后又清了 kimi key),但只有 DeepSeek 有配置
    await setSelectedModelProvider("kimi");
    await setVisitorDeepseekKey("deepseek-local-key");
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );

    expect(getButtonByWf("ModelUsingDeepseek").textContent).toContain("使用中");
    expect(host?.querySelector('[data-wf="ModelEnableDeepseek"]')).toBeNull();
    expect(host?.querySelector('[data-wf="ModelUsingKimi"]')).toBeNull();
    // 与「启 用」同一条持久化通道,回落结果要落盘
    expect(getStoredModelProvider()).toBe("deepseek");
  });

  it("不变式 · 清掉使用中那家的 key 后,当场回落到另一家而不是无人使用", async () => {
    await setVisitorDeepseekKey("deepseek-local-key");
    await setVisitorModelKey("kimi", "kimi-local-key");
    await setSelectedModelProvider("kimi");
    await render(
      <ConfirmProvider>
        <ToastProvider>
          <ModelSettingsPanel />
        </ToastProvider>
      </ConfirmProvider>,
    );

    expect(getButtonByWf("ModelUsingKimi")).toBeTruthy();
    await openVendorConfig("kimi");
    await click(getButtonByWf("ModelClearKey"));
    await click(getButtonByText("清除 key"));
    await click(getButtonByWf("ModelConfigBack"));

    expect(getVisitorModelKey("kimi")).toBeNull();
    expect(getButtonByWf("ModelUsingDeepseek").textContent).toContain("使用中");
    expect(host?.querySelector('[data-wf="ModelEnableDeepseek"]')).toBeNull();
    expect(getStoredModelProvider()).toBe("deepseek");
  });

  it("不变式 · 两家都已配时正常切换不受归一化干扰", async () => {
    await setVisitorDeepseekKey("deepseek-local-key");
    await setVisitorModelKey("kimi", "kimi-local-key");
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );

    expect(getButtonByWf("ModelUsingDeepseek")).toBeTruthy();
    await click(getButtonByWf("ModelEnableKimi"));
    expect(getButtonByWf("ModelUsingKimi")).toBeTruthy();
    expect(getStoredModelProvider()).toBe("kimi");

    await click(getButtonByWf("ModelEnableDeepseek"));
    expect(getButtonByWf("ModelUsingDeepseek")).toBeTruthy();
    expect(getStoredModelProvider()).toBe("deepseek");
  });

  it("首拉在途:模型面板不渲染任何空态/错误占位文案(切 tab 闪帧根治)", async () => {
    // 所有首拉都挂着不回:此刻面板对"有没有配置/有没有用量"都还没有结论,
    // 不许渲染任何会被数据顶掉的空态或错误文案(<250ms 连「加载中…」也不显形)。
    const pending = new Promise<Response>(() => {});
    vi.stubGlobal("fetch", vi.fn(() => pending));
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );

    const text = host?.textContent ?? "";
    for (const flash of [
      "还没有可用的模型",
      "去配置",
      "加载失败或暂不可用",
      "用量数据加载失败或暂不可用",
      "还没有用量记录",
      "暂无记录",
      "需有消耗与文档",
      "正在检测连接",
      "加载中…",
    ]) {
      expect(text, flash).not.toContain(flash);
    }
    // 卡片骨架仍在(不是整块空白),只是先不下结论
    expect(host?.querySelectorAll(".vd-card")).toHaveLength(2);
    expect(host?.querySelector('[data-wf="ModelVendorCardDeepseek"]')?.getAttribute("aria-busy"))
      .toBe("true");
  });

  it("已配厂商的二级页:清除 key 与模型名前缀都在,且不外露本机分层", async () => {
    await setVisitorDeepseekKey("deepseek-local-key");
    await render(
      <ConfirmProvider>
        <ToastProvider>
          <ModelSettingsPanel />
        </ToastProvider>
      </ConfirmProvider>,
    );

    await openVendorConfig();
    const page = host?.querySelector('[data-wf="ModelConfigPage"]');
    expect(page?.textContent).toContain("切换 / 修改模型配置 · DeepSeek");
    expect(page?.textContent).toContain("当前使用 已配置密钥");
    expect(page?.textContent).toContain("••••-key");
    expect(page?.textContent).not.toContain("本机 的 key");
    expect(getInputByPlaceholder("deepseek-v4-flash")).toBeTruthy();
    expect(getInputByPlaceholder("deepseek-v4-pro")).toBeTruthy();

    expect(getButtonByWf("ModelClearKey").textContent).toContain("清除密钥");
    await click(getButtonByWf("ModelClearKey"));
    await click(getButtonByText("清除 key"));
    expect(getVisitorDeepseekKey()).toBeNull();
  });

  it("看板:三瓦片进看板卡,饼图按费用占比且 0 费用模型不进饼", async () => {
    await setVisitorDeepseekKey("deepseek-local-key");
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );

    const usageCard = host?.querySelector(".md-usage");
    expect(usageCard?.textContent).toContain("近 7 天花费");
    expect(usageCard?.textContent).toContain("近 7 天产出");
    expect(usageCard?.textContent).toContain("平均每篇");
    // 账户余额瓦片已从看板撤出,归 DeepSeek 卡
    expect(usageCard?.textContent).not.toContain("账户余额");
    expect(usageCard?.textContent).toContain("累计费用占比");

    const legend = Array.from(host?.querySelectorAll(".md-legend-item") ?? [])
      .map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "");
    // total 数据:Flash ¥0.003 / PRO ¥0.002 → 按费用降序、百分比按费用算
    expect(legend[0]).toContain("V4 Flash");
    expect(legend[0]).toContain("60%");
    expect(legend[0]).toContain("¥0.003");
    expect(legend[1]).toContain("V4 PRO");
    expect(legend[1]).toContain("40%");
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

    await openVendorConfig();
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

    await openVendorConfig();
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
    await openVendorConfig();
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

  // 缺陷回归:填完整 endpoint 时"自动处理"要做到底——存的、显示的都必须是服务端归一化后的地址。
  it("Model 自定义保存服务端归一化地址,并回填输入框 + 明确告知已修正", async () => {
    const fallbackFetch = makeFetchMock();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/api/v1/settings/model/test-custom")
        ? Promise.resolve(json({ ok: true, normalizedBaseUrl: "https://api.example.com/v1" }))
        : fallbackFetch(input, init),
    ));

    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );
    await openVendorConfig();
    await click(getButtonByText("接入其他云厂商 / 模型"));
    setInput(
      getInputByPlaceholder("https://your-endpoint/v1"),
      "https://api.example.com/v1/chat/completions",
    );
    setInput(getInputByPlaceholder("sk-…"), "sk-testkey");
    await click(getButtonByText("测试并保存"));

    expect(readCustomProvider("deepseek")?.baseUrl).toBe("https://api.example.com/v1");
    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent)
      .toContain("已自动修正为标准地址 https://api.example.com/v1");
    // 回填:再进配置页看到的就是真正存下来的地址
    await openVendorConfig();
    expect(getInputByPlaceholder("https://your-endpoint/v1").value)
      .toBe("https://api.example.com/v1");
  });

  it("Model 自定义地址缺 http(s):// 时转成提示,按补齐地址测试并保存", async () => {
    let resolveTest!: (response: Response) => void;
    const deferredTest = new Promise<Response>((resolve) => {
      resolveTest = resolve;
    });
    const fallbackFetch = makeFetchMock();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/api/v1/settings/model/test-custom")
        ? deferredTest
        : fallbackFetch(input, init),
    );
    vi.stubGlobal("fetch", fetchMock);

    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );
    await openVendorConfig();
    await click(getButtonByText("接入其他云厂商 / 模型"));
    setInput(getInputByPlaceholder("https://your-endpoint/v1"), "api.example.com/v1");
    setInput(getInputByPlaceholder("sk-…"), "sk-testkey");

    // 可修复 → 不判非法:按钮不禁用、不出红字
    const saveBtn = getButtonByText("测试并保存");
    expect(saveBtn.hasAttribute("disabled")).toBe(false);
    expect(host?.querySelector(".sm-field-err")).toBeNull();

    await click(saveBtn);
    expect(host?.querySelector(".sm-message")?.textContent ?? "")
      .toContain("将按 https://api.example.com/v1 测试并保存");
    const testCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/api/v1/settings/model/test-custom"));
    expect(JSON.parse(String((testCall?.[1] as RequestInit | undefined)?.body)).baseUrl)
      .toBe("https://api.example.com/v1");

    await act(async () => {
      resolveTest(json({ ok: true, normalizedBaseUrl: "https://api.example.com/v1" }));
      await deferredTest;
    });
    await flush();
    expect(readCustomProvider("deepseek")?.baseUrl).toBe("https://api.example.com/v1");
  });

  it("Model 自定义地址真格式错时照旧判非法,不放行保存", async () => {
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );
    await openVendorConfig();
    await click(getButtonByText("接入其他云厂商 / 模型"));
    setInput(getInputByPlaceholder("https://your-endpoint/v1"), "not-a-url");

    expect(getButtonByText("测试并保存").hasAttribute("disabled")).toBe(true);
    expect(host?.querySelector(".sm-field-err")?.textContent).toContain("http(s)://");
  });

  it("Model 档位 chip 默认 Flash,选 Pro 后持久化并随请求 header 透传", async () => {
    setVisitorDeepseekKey(`sk-${"A".repeat(32)}`);
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );

    // 收起态只显示档名,说明与价格要点开浮层才出现
    const chip = getButtonByWf("ModelTierChipDeepseek");
    expect(chip.textContent).toBe("Flash");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector(".md-tier-menu")).toBeNull();
    expect(getSelectedModelTier()).toBe("flash");
    expect(visitorKeyHeaders()["x-model-tier"]).toBeUndefined();

    await click(chip);
    expect(document.body.querySelector(".md-tier-menu")?.textContent).toContain("便宜、速度快");
    await click(getBodyButtonByWf("ModelTierDeepseekPro"));

    expect(getButtonByWf("ModelTierChipDeepseek").textContent).toBe("Pro");
    expect(getSelectedModelTier()).toBe("pro");
    expect(visitorKeyHeaders()["x-model-tier"]).toBe("pro");
    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent).toContain("Pro");

    await pickTier("deepseek", "flash");
    expect(getSelectedModelTier()).toBe("flash");
    expect(visitorKeyHeaders()["x-model-tier"]).toBeUndefined();
  });

  it("档位浮层点外关闭、Esc 关闭,Enter 可选中", async () => {
    setVisitorDeepseekKey("deepseek-tier-key");
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );
    const chip = getButtonByWf("ModelTierChipDeepseek");

    await click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(getButtonByWf("ModelTierChipDeepseek").getAttribute("aria-expanded")).toBe("false");

    await keyDown(chip, "Enter");
    expect(getButtonByWf("ModelTierChipDeepseek").getAttribute("aria-expanded")).toBe("true");
    await keyDown(getButtonByWf("ModelTierChipDeepseek"), "Escape");
    expect(getButtonByWf("ModelTierChipDeepseek").getAttribute("aria-expanded")).toBe("false");

    await keyDown(getButtonByWf("ModelTierChipDeepseek"), "ArrowDown");
    await keyDown(getButtonByWf("ModelTierChipDeepseek"), "Enter");
    expect(getSelectedModelTier()).toBe("pro");
    expect(getButtonByWf("ModelTierChipDeepseek").textContent).toBe("Pro");
  });

  it("两家档位各记各的,互不串档", async () => {
    await setVisitorDeepseekKey("deepseek-key");
    await setVisitorModelKey("kimi", "kimi-key");
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );

    expect(getButtonByWf("ModelTierChipKimi").textContent).toBe("K2.7");
    await pickTier("kimi", "pro");
    expect(getButtonByWf("ModelTierChipKimi").textContent).toBe("K3");
    expect(getButtonByWf("ModelTierChipDeepseek").textContent).toBe("Flash");
    expect(getSelectedModelTier("kimi")).toBe("pro");
    expect(getSelectedModelTier("deepseek")).toBe("flash");
    // 使用中的是 DeepSeek,透传的档位跟随 DeepSeek 而不是 Kimi
    expect(visitorKeyHeaders()["x-model-tier"]).toBeUndefined();

    await click(getButtonByWf("ModelEnableKimi"));
    expect(visitorKeyHeaders()["x-model-tier"]).toBe("pro");
  });

  it("「启 用」切换保留 DeepSeek/Kimi 各自 key，并透传 Kimi 双档 header", async () => {
    await setVisitorDeepseekKey("deepseek-local-key");
    await setVisitorModelKey("kimi", "kimi-local-key");
    setSelectedModelProvider("deepseek");
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );

    // 使用中那张卡只有不可点的「使用中」,另一张才有「启 用」
    expect(getButtonByWf("ModelUsingDeepseek").hasAttribute("disabled")).toBe(true);
    await click(getButtonByWf("ModelEnableKimi"));
    expect(getSelectedModelProvider()).toBe("kimi");
    expect(getVisitorModelKey("deepseek")).toBe("deepseek-local-key");
    expect(getVisitorModelKey("kimi")).toBe("kimi-local-key");
    expect(visitorKeyHeaders()).toMatchObject({
      "x-model-provider": "kimi",
      "x-model-key": "kimi-local-key",
    });
    expect(visitorKeyHeaders()["x-deepseek-key"]).toBeUndefined();
    expect(getButtonByWf("ModelUsingKimi").hasAttribute("disabled")).toBe(true);
    expect(getButtonByWf("ModelTierChipKimi").textContent).toBe("K2.7");

    await click(getButtonByWf("ModelEnableDeepseek"));
    expect(getSelectedModelProvider()).toBe("deepseek");
    expect(visitorKeyHeaders()).toMatchObject({
      "x-model-provider": "deepseek",
      "x-model-key": "deepseek-local-key",
      "x-deepseek-key": "deepseek-local-key",
    });
  });

  it("启用与档位落盘失败时保持原选择并通过全局 toast 告知未保存", async () => {
    await setVisitorDeepseekKey("deepseek-local-key");
    await setVisitorModelKey("kimi", "kimi-local-key");
    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );
    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "qingagent.model_provider" || key === "qingagent.model_tier") {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      nativeSetItem.call(this, key, value);
    });

    await click(getButtonByWf("ModelEnableKimi"));
    expect(getButtonByWf("ModelUsingDeepseek")).toBeTruthy();
    expect(getSelectedModelProvider()).toBe("deepseek");
    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent).toContain("未保存");

    await pickTier("deepseek", "pro");
    expect(getButtonByWf("ModelTierChipDeepseek").textContent).toBe("Flash");
    expect(getSelectedModelTier()).toBe("flash");
    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent).toContain("未保存");
  });

  it("官方配置第一段 key 落盘失败时重同步持久层并安全收敛", async () => {
    const setDeepseekApiKey = vi.fn(async () => false);
    const setCustomProvider = vi.fn(async () => true);
    const setOfficialModel = vi.fn(async () => true);
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {
        isDesktop: true,
        getDeepseekApiKey: () => null,
        setDeepseekApiKey,
        getCustomProvider: () => null,
        setCustomProvider,
        getOfficialModel: () => null,
        setOfficialModel,
      },
    });
    __resetClientPersistCacheForTests();

    await render(
      <ConfirmProvider>
        <ToastProvider>
          <ModelSettingsPanel />
        </ToastProvider>
      </ConfirmProvider>,
    );
    await openVendorConfig();
    setInput(getInputByWf("ModelKeyInput"), "attempted-new-key");
    await click(getButtonByText("保存"));
    await click(getButtonByText("仍要保存"));

    expect(setDeepseekApiKey).toHaveBeenCalledWith("attempted-new-key");
    expect(setCustomProvider).not.toHaveBeenCalled();
    expect(setOfficialModel).not.toHaveBeenCalled();
    expect(getVisitorDeepseekKey()).toBeNull();
    expect(getInputByWf("ModelKeyInput").value).toBe("");
    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent).toContain("未保存");
  });

  it("官方配置第二段旧自定义配置清除失败时从持久化层重同步 UI", async () => {
    const previousCustom = JSON.stringify({
      protocol: "openai",
      baseUrl: "https://old-proxy.example/v1",
      apiKey: "old-custom-key",
      modelFlash: "old-custom-flash",
      modelPro: "old-custom-pro",
    });
    const setDeepseekApiKey = vi.fn(async () => true);
    const setCustomProvider = vi.fn(async () => false);
    const setOfficialModel = vi.fn(async () => true);
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {
        isDesktop: true,
        getDeepseekApiKey: () => null,
        setDeepseekApiKey,
        getCustomProvider: () => previousCustom,
        setCustomProvider,
        getOfficialModel: () => null,
        setOfficialModel,
      },
    });
    __resetClientPersistCacheForTests();

    await render(
      <ConfirmProvider>
        <ToastProvider>
          <ModelSettingsPanel />
        </ToastProvider>
      </ConfirmProvider>,
    );
    await openVendorConfig();
    await click(getButtonByText("接入 DeepSeek 官方 API"));
    setInput(getInputByWf("ModelKeyInput"), "deepseek-official-new");
    await click(getButtonByText("保存"));
    await click(getButtonByText("仍要保存"));

    expect(setDeepseekApiKey).toHaveBeenCalledWith("deepseek-official-new");
    expect(setCustomProvider).toHaveBeenCalledWith(null);
    expect(setOfficialModel).not.toHaveBeenCalled();
    expect(getVisitorDeepseekKey()).toBe("deepseek-official-new");
    expect(readCustomProvider()).toMatchObject({
      baseUrl: "https://old-proxy.example/v1",
      apiKey: "old-custom-key",
    });
    expect(host?.textContent).toContain("自定义模型");
    expect(host?.textContent).toContain("https://old-proxy.example/v1");
    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent).toContain(
      "旧的自定义模型配置未清除",
    );
  });

  it("官方配置前两段成功而别名落盘失败时从持久化层重同步 UI", async () => {
    const previousCustom = JSON.stringify({
      protocol: "openai",
      baseUrl: "https://old-proxy.example/v1",
      apiKey: "old-custom-key",
      modelFlash: "old-custom-flash",
      modelPro: "old-custom-pro",
    });
    const setDeepseekApiKey = vi.fn(async () => true);
    const setCustomProvider = vi.fn(async () => true);
    const setOfficialModel = vi.fn(async () => false);
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {
        isDesktop: true,
        getDeepseekApiKey: () => null,
        setDeepseekApiKey,
        getCustomProvider: () => previousCustom,
        setCustomProvider,
        getOfficialModel: () => JSON.stringify({ flash: "persisted-official-flash" }),
        setOfficialModel,
      },
    });
    __resetClientPersistCacheForTests();

    await render(
      <ConfirmProvider>
        <ToastProvider>
          <ModelSettingsPanel />
        </ToastProvider>
      </ConfirmProvider>,
    );
    expect(host?.textContent).toContain("自定义模型");

    await openVendorConfig();
    await click(getButtonByText("接入 DeepSeek 官方 API"));
    setInput(getInputByWf("ModelKeyInput"), "deepseek-official-new");
    setInput(getInputByPlaceholder("deepseek-v4-flash"), "attempted-new-flash");
    await click(getButtonByText("保存"));
    await click(getButtonByText("仍要保存"));

    expect(setDeepseekApiKey).toHaveBeenCalledWith("deepseek-official-new");
    expect(setCustomProvider).toHaveBeenCalledWith(null);
    expect(setOfficialModel).toHaveBeenCalledWith(JSON.stringify({ flash: "attempted-new-flash" }));
    expect(getVisitorDeepseekKey()).toBe("deepseek-official-new");
    expect(readCustomProvider()).toBeNull();
    expect(visitorKeyHeaders()).toMatchObject({
      "x-model-key": "deepseek-official-new",
      "x-model-flash": "persisted-official-flash",
    });
    expect(host?.textContent).toContain("当前使用 已配置密钥");
    expect(host?.textContent).toContain("••••-new");
    expect(host?.textContent).not.toContain("https://old-proxy.example/v1");
    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent).toContain("模型别名未保存");
  });

  it("保存失败后重同步 getter 也异常时保持现有 UI 并走统一错误提示", async () => {
    const getDeepseekApiKey = vi.fn(() => {
      throw new Error("desktop getter failed");
    });
    const setDeepseekApiKey = vi.fn(async () => true);
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {
        isDesktop: true,
        getDeepseekApiKey,
        setDeepseekApiKey,
        getCustomProvider: () => null,
        setCustomProvider: vi.fn(async () => true),
        getOfficialModel: () => null,
        setOfficialModel: vi.fn(async () => true),
      },
    });
    __resetClientPersistCacheForTests();

    await render(
      <ConfirmProvider>
        <ToastProvider>
          <ModelSettingsPanel />
        </ToastProvider>
      </ConfirmProvider>,
    );
    await openVendorConfig();
    setInput(getInputByWf("ModelKeyInput"), "keep-current-input");
    await click(getButtonByText("保存"));
    await click(getButtonByText("仍要保存"));

    expect(getDeepseekApiKey).toHaveBeenCalled();
    expect(setDeepseekApiKey).not.toHaveBeenCalled();
    expect(getInputByWf("ModelKeyInput").value).toBe("keep-current-input");
    const toastText = host?.querySelector('[data-wf="GlobalToast"]')?.textContent ?? "";
    expect(toastText).toContain("未保存");
    expect(toastText).not.toContain("desktop getter failed");
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

    await openVendorConfig("kimi");
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

  it("DeepSeek 余额检测在途进二级页时中止并丢弃迟到结果", async () => {
    await setVisitorDeepseekKey("deepseek-balance-key");
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
    await openVendorConfig();

    expect(host?.textContent ?? "").not.toContain("正在检测连接");
    await act(async () => {
      resolveBalance(json({ ok: false, error: "迟到的 DeepSeek 结果" }));
      await deferredBalance;
    });
    await flush();
    expect(host?.textContent ?? "").not.toContain("迟到的 DeepSeek 结果");
  });

  it("DeepSeek 余额检测不跟随使用中厂商:用着 Kimi 也照发 DeepSeek 自己的 key", async () => {
    await setVisitorDeepseekKey("deepseek-balance-key");
    await setVisitorModelKey("kimi", "kimi-local-key");
    setSelectedModelProvider("kimi");
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );
    await waitForCondition(
      () => fetchMock.mock.calls.some((call) =>
        String(call[0]).includes("/api/v1/settings/model/balance")),
      "DeepSeek 余额检测发出",
    );
    const balanceCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/api/v1/settings/model/balance"));
    expect(balanceCall?.[1]).toMatchObject({
      headers: { "x-model-provider": "deepseek", "x-deepseek-key": "deepseek-balance-key" },
    });
    expect(host?.textContent).toContain("余额");
  });

  it("Kimi 测试连接在途启用 DeepSeek 时作废旧请求并丢弃迟到成功", async () => {
    await setVisitorModelKey("kimi", "kimi-local-key");
    await setVisitorDeepseekKey("deepseek-local-key");
    setSelectedModelProvider("kimi");
    let resolveVerify!: (response: Response) => void;
    const deferredVerify = new Promise<Response>((resolve) => {
      resolveVerify = resolve;
    });
    const fallbackFetch = makeFetchMock();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      (init?.headers as Record<string, string> | undefined)?.["x-model-provider"] === "kimi"
        ? deferredVerify
        : fallbackFetch(input),
    ));

    await render(
      <ToastProvider>
        <ModelSettingsPanel />
      </ToastProvider>,
    );
    await openVendorConfig("kimi");
    setInput(getInputByWf("ModelKeyInput"), "kimi-late-key");
    await click(getButtonByText("测试连接"));
    await click(getButtonByWf("ModelConfigBack"));
    await click(getButtonByWf("ModelEnableDeepseek"));

    await act(async () => {
      resolveVerify(json({ ok: true }));
      await deferredVerify;
    });
    await flush();
    expect(getSelectedModelProvider()).toBe("deepseek");
    expect(host?.textContent ?? "").not.toContain("Kimi 短对话测试已连通");
  });

  it("Kimi 测试连接在途修改 key 时作废旧请求并丢弃迟到成功", async () => {
    setSelectedModelProvider("kimi");
    await setVisitorModelKey("kimi", "kimi-local-key");
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
    await openVendorConfig("kimi");
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

  it("Kimi 测试连接在途返回主视图切档位时作废旧请求并丢弃迟到成功", async () => {
    setSelectedModelProvider("kimi");
    await setVisitorModelKey("kimi", "kimi-local-key");
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
    await openVendorConfig("kimi");
    setInput(getInputByWf("ModelKeyInput"), "kimi-tier-key");
    await click(getButtonByText("测试连接"));
    await click(getButtonByWf("ModelConfigBack"));
    await pickTier("kimi", "pro");

    await act(async () => {
      resolveVerify(json({ ok: true }));
      await deferredVerify;
    });
    await flush();
    expect(getButtonByWf("ModelTierChipKimi").textContent).toBe("K3");
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

    await openVendorConfig();
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

    await openVendorConfig();
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

  it("Vision 同样保存服务端归一化地址并回填输入框", async () => {
    const fallbackFetch = makeFetchMock();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/api/v1/settings/vision/test")
        ? Promise.resolve(json({ ok: true, normalizedBaseUrl: "https://vision.example/v1" }))
        : fallbackFetch(input, init),
    ));

    await render(
      <ToastProvider>
        <VisionPanel />
      </ToastProvider>,
    );
    setInput(
      getInputByPlaceholder("https://your-endpoint/v1"),
      "https://vision.example/v1/chat/completions",
    );
    setInput(getInputByPlaceholder("sk-…"), "sk-vision");
    setInput(getInputByPlaceholder("如 qwen-vl-max / gpt-4o / claude-3-5-sonnet"), "qwen-vl-max");
    await click(getButtonByText("测试并保存"));
    await flush();

    expect(readVisionProvider()?.baseUrl).toBe("https://vision.example/v1");
    expect(getInputByPlaceholder("https://your-endpoint/v1").value)
      .toBe("https://vision.example/v1");
    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent)
      .toContain("已自动修正为标准地址");
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

  it("F3: Model 落盘期间输入变更后不退出配置页或报假成功", async () => {
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
    await openVendorConfig();
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

  it("用量明细头部:日期控件只在按天视图出现,模型多选三视图常驻", async () => {
    setVisitorDeepseekKey(`sk-${"A".repeat(32)}`);
    await render(<ModelSettingsPanel />);
    await flush();

    // 按天:日期 + 模型多选都在
    expect(host?.querySelector('[data-wf="UsageDateFilter"]')).not.toBeNull();
    expect(host?.querySelector('[data-wf="UsageModelFilter"]')).not.toBeNull();
    // 头部不再有独立「清除」按钮(清除并入日历浮层内部)
    expect(host?.querySelector(".md-date-clear")).toBeNull();
    // 「日期」文字标签已撤:容器里只剩日历控件本体
    expect(host?.querySelector('[data-wf="UsageDateFilter"]')?.children).toHaveLength(1);
    expect(host?.querySelector('[data-wf="UsageDateFilter"]')?.firstElementChild?.className)
      .toContain("skin-date");

    await click(getButtonByText("按文档"));
    expect(host?.querySelector('[data-wf="UsageDateFilter"]')).toBeNull();
    expect(host?.querySelector('[data-wf="UsageModelFilter"]')).not.toBeNull();

    await click(getButtonByText("总计"));
    expect(host?.querySelector('[data-wf="UsageDateFilter"]')).toBeNull();
    expect(host?.querySelector('[data-wf="UsageModelFilter"]')).not.toBeNull();

    await click(getButtonByText("按天"));
    expect(host?.querySelector('[data-wf="UsageDateFilter"]')).not.toBeNull();
  });

  it("用量明细模型多选:默认全部,取消一档后聚合口径变局部,重新全选复原", async () => {
    setVisitorDeepseekKey(`sk-${"A".repeat(32)}`);
    await render(<ModelSettingsPanel />);
    await flush();

    const trigger = getButtonByWf("UsageModelFilter");
    expect(trigger.textContent).toContain("全部");
    // 2026-06-24 三行:flash 1000 + pro 600 + flash 400 = 2.0k 输入
    expect(getTable().textContent).toContain("2.0k");

    await click(trigger);
    await click(getMenuOption("V4 PRO"));
    // 取消 PRO 后该天只剩两条 flash:1000 + 400 = 1.4k
    expect(getTable().textContent).toContain("1.4k");
    expect(getTable().textContent).not.toContain("2.0k");
    expect(getButtonByWf("UsageModelFilter").textContent).toContain("1 个模型");

    // 「全部」项回到全选
    await click(getMenuOption("全部"));
    expect(getButtonByWf("UsageModelFilter").textContent).toContain("全部");
    expect(getTable().textContent).toContain("2.0k");
  });

  it("用量明细模型多选:切到按文档视图后筛选仍生效", async () => {
    setVisitorDeepseekKey(`sk-${"A".repeat(32)}`);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/usage/summary?view=session")) {
        return json({
          rows: [
            { ...usageRow("session-1", "deepseek-v4-flash", 1200, 500, 0.001), label: "测试文档" },
            { ...usageRow("session-1", "k3", 800, 300, 0.002), label: "测试文档" },
          ],
        });
      }
      return makeFetchMock()(input);
    }));
    await render(<ModelSettingsPanel />);
    await flush();

    await click(getButtonByText("按文档"));
    await flush();
    // 1200 + 800 = 2.0k
    expect(getTable().textContent).toContain("2.0k");

    await click(getButtonByWf("UsageModelFilter"));
    await click(getMenuOption("K3"));
    expect(getTable().textContent).toContain("1.2k");
    expect(getTable().textContent).not.toContain("2.0k");
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

  it("用量视图切换立即清除旧行，非 2xx 后显示中性失败态", async () => {
    setVisitorDeepseekKey(`sk-${"A".repeat(32)}`);
    let resolveSession!: (response: Response) => void;
    const sessionRequest = new Promise<Response>((resolve) => {
      resolveSession = resolve;
    });
    const fallbackFetch = makeFetchMock();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/v1/usage/summary?view=session")) {
        return sessionRequest;
      }
      return fallbackFetch(input, init);
    }));
    await render(<ModelSettingsPanel />);
    expect(getTable().textContent).toContain("2026-06-24");

    await click(getButtonByText("按文档"));
    expect(host?.textContent).toContain("正在加载用量数据");
    expect(host?.querySelector(".md-table")).toBeNull();
    expect(host?.textContent).not.toContain("2026-06-24");

    await act(async () => {
      resolveSession(json({ error: "temporary unavailable" }, 503));
      await sessionRequest;
    });
    await flush();

    expect(host?.textContent).toContain("用量数据暂时无法加载，请稍后重试");
    expect(host?.querySelector(".md-table")).toBeNull();
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

// 新面板:主视图是两张厂商卡,key 表单在二级配置页,先点卡上的「配 置 / 去配置」进去
async function openVendorConfig(vendor: "deepseek" | "kimi" = "deepseek"): Promise<void> {
  await click(getButtonByWf(vendor === "kimi" ? "ModelConfigKimi" : "ModelConfigDeepseek"));
}

// 档位浮层 portal 到 body,不在 host 子树里
function getBodyButtonByWf(dataWf: string): HTMLButtonElement {
  const button = document.body.querySelector<HTMLButtonElement>(`button[data-wf="${dataWf}"]`);
  if (!button) throw new Error(`${dataWf} button not found in body`);
  return button;
}

async function pickTier(vendor: "deepseek" | "kimi", tier: "flash" | "pro"): Promise<void> {
  const wf = vendor === "kimi" ? "Kimi" : "Deepseek";
  await click(getButtonByWf(`ModelTierChip${wf}`));
  await click(getBodyButtonByWf(`ModelTier${wf}${tier === "pro" ? "Pro" : "Flash"}`));
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

// 多选浮层 portal 到 body:按可见文案取选项
function getMenuOption(label: string): HTMLButtonElement {
  const option = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="option"]'))
    .find((node) => (node.textContent ?? "").replace(/[✓\s]/g, "") === label.replace(/\s/g, ""));
  if (!option) throw new Error(`${label} option not found`);
  return option;
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

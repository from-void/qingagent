// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetClientPersistCacheForTests } from "../../overlays/settings/clientPersist";
import { getVisitorModelKey } from "../../overlays/settings/visitorKeyStore";
import { OnboardingSettingsProvider } from "../../system/onboarding/OnboardingSettingsContext";
import { OnboardingPage } from "./OnboardingPage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

describe("OnboardingPage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    __resetClientPersistCacheForTests();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    __resetClientPersistCacheForTests();
  });

  it("厂商卡使用品牌 SVG，推荐标签完整留在 DeepSeek 卡内", async () => {
    vi.stubGlobal("fetch", onboardingFetch());
    await renderPage();

    const deepseekIcon = host.querySelector<SVGSVGElement>('[data-brand-icon="deepseek"]');
    const kimiIcon = host.querySelector<SVGSVGElement>('[data-brand-icon="kimi"]');
    expect(deepseekIcon?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(deepseekIcon?.querySelector("path")?.getAttribute("fill")).toBe("#4D6BFE");
    expect(kimiIcon?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(Array.from(kimiIcon?.querySelectorAll("path") ?? []).map((path) => path.getAttribute("fill")))
      .toEqual(["#1783FF", "#fff"]);

    const recommended = host.querySelector(".onboarding-provider-recommended");
    expect(recommended?.textContent).toBe("推荐");
    expect(recommended?.closest(".onboarding-provider-card")?.textContent).toContain("DeepSeek");
  });

  it("DeepSeek 如何获取直达图文教程，Kimi 仍保留原折叠说明", async () => {
    vi.stubGlobal("fetch", onboardingFetch());
    await renderPage();

    const deepseekHelp = Array.from(host.querySelectorAll<HTMLAnchorElement>("a")).find((item) =>
      item.textContent?.trim() === "如何获取?",
    );
    expect(deepseekHelp?.href).toBe("https://qingagent.com/blog/setup-deepseek");
    expect(deepseekHelp?.target).toBe("_blank");
    expect(deepseekHelp?.rel).toBe("noopener noreferrer");
    expect(deepseekHelp?.closest("details")).toBeNull();
    expect(host.textContent).not.toContain("进入 API keys，创建并复制密钥");
    expect(host.textContent).not.toContain("按量计费，小额充值即可开始使用");

    clickButton("Kimi");
    const kimiHelp = Array.from(host.querySelectorAll("summary")).find((item) =>
      item.textContent?.trim() === "如何获取?",
    );
    expect(kimiHelp?.closest("details")).not.toBeNull();
    expect(kimiHelp?.closest("details")?.querySelector("a")?.href).toBe("https://platform.moonshot.cn/");
    expect(host.textContent).toContain("进入 API Key 管理，新建并复制密钥");
    expect(host.textContent).toContain("确认套餐已开通 K3 / K2.7 Code 权限");
  });

  it("厂商与官方/自定义切换分别保留已填内容", async () => {
    vi.stubGlobal("fetch", onboardingFetch());
    await renderPage();

    inputByLabel("DeepSeek 官方 API Key", "sk-deepseek-remember-this-key");
    clickButton("想使用自定义 API key?");
    inputByLabel("API 地址(Base URL)", "https://example.com/v1");
    clickButton("Kimi");
    clickButton("DeepSeek");

    expect(inputValue("API 地址(Base URL)")).toBe("https://example.com/v1");
    clickButton("返回官方 API");
    expect(inputValue("DeepSeek 官方 API Key")).toBe("sk-deepseek-remember-this-key");
  });

  it("自动验证成功前开始使用保持禁用，成功后保存同一 visitor 链路", async () => {
    vi.stubGlobal("fetch", onboardingFetch({ balanceOk: true }));
    await renderPage();
    const start = button("开始使用");
    expect(start.disabled).toBe(true);

    inputByLabel("DeepSeek 官方 API Key", "sk-deepseek-valid-long-key");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(host.textContent).toContain("密钥可用");
    expect(host.querySelector(".onboarding-validation.is-ok svg")).not.toBeNull();
    expect(host.textContent).not.toContain("✓");
    expect(start.disabled).toBe(false);

    await act(async () => {
      start.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getVisitorModelKey("deepseek")).toBe("sk-deepseek-valid-long-key");
  });

  it("自定义 Base URL 非 http(s) 时就近报错且不发连接测试", async () => {
    const fetchMock = onboardingFetch();
    vi.stubGlobal("fetch", fetchMock);
    await renderPage();
    clickButton("想使用自定义 API key?");
    inputByLabel("API 地址(Base URL)", "ftp://example.com/v1");
    inputByLabel("API key", "sk-custom-long-key");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(host.textContent).toContain("需以 http(s):// 开头");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("test-custom"))).toBe(false);
  });

  it("官方 Key 输入框 Enter 立即验证，验证通过后再次 Enter 开始使用；Esc 不退出", async () => {
    const fetchMock = onboardingFetch({ balanceOk: true });
    vi.stubGlobal("fetch", fetchMock);
    await renderPage();
    const keyInput = labelledInput("DeepSeek 官方 API Key");

    inputByLabel("DeepSeek 官方 API Key", "sk-deepseek-enter-valid-key");
    await act(async () => {
      keyInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(host.querySelector('[data-view="onboarding"]')).not.toBeNull();

    await act(async () => {
      keyInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/settings/model/balance"))).toHaveLength(1);
    expect(host.textContent).toContain("密钥可用");

    await act(async () => {
      keyInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getVisitorModelKey("deepseek")).toBe("sk-deepseek-enter-valid-key");
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/settings/onboarding") && init?.method === "PUT",
    )).toBe(true);
  });
});

async function renderPage() {
  await act(async () => {
    root.render(
      <OnboardingSettingsProvider>
        <OnboardingPage />
      </OnboardingSettingsProvider>,
    );
    await Promise.resolve();
  });
}

function onboardingFetch(input: { balanceOk?: boolean } = {}) {
  return vi.fn<typeof fetch>(async (request, init) => {
    const url = String(request);
    if (url.endsWith("/settings/onboarding") && (!init?.method || init.method === "GET")) {
      return Response.json({ state: null, coachSeen: [] });
    }
    if (url.endsWith("/settings/onboarding") && init?.method === "PUT") {
      return Response.json({
        state: { status: "done", completedAt: "2026-08-17T00:00:00.000Z" },
      });
    }
    if (url.includes("/settings/model/balance")) {
      return Response.json(input.balanceOk
        ? { ok: true, balances: [{ currency: "CNY", total: "35.81", granted: "0", toppedUp: "35.81" }] }
        : { ok: false, keyInvalid: true, error: "API Key 无效" });
    }
    if (url.includes("/settings/model/test-custom")) {
      return Response.json({ ok: true, normalizedBaseUrl: "https://example.com/v1" });
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll("button")).find((item) =>
    item.textContent?.trim() === name ||
    (item.getAttribute("role") === "radio" && item.textContent?.includes(name)),
  );
  expect(found).toBeTruthy();
  return found!;
}

function clickButton(name: string) {
  act(() => button(name).click());
}

function labelledInput(label: string): HTMLInputElement {
  const found = Array.from(host.querySelectorAll("label")).find((item) => item.textContent?.includes(label));
  const input = found?.querySelector("input");
  expect(input).toBeTruthy();
  return input!;
}

function inputByLabel(label: string, value: string) {
  const input = labelledInput(label);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function inputValue(label: string) {
  return labelledInput(label).value;
}

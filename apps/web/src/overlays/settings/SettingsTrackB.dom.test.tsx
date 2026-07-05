// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../system/ToastProvider";
import { ModelSettingsPanel } from "./ModelSettingsPanel";
import { SecretInput } from "./SecretInput";
import { VisionPanel } from "./VisionPanel";
import { resetSettingsDialogA11yForTest, ensureSettingsDialogA11y } from "./settingsDialogA11y";
import { setVisitorDeepseekKey } from "./visitorKeyStore";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const dayRows = [
  usageRow("2026-06-24", "deepseek-v4-flash", 1000, 500, 0.001),
  usageRow("2026-06-25", "deepseek-v4-pro", 2000, 800, 0.002),
];

describe("Settings Track B", () => {
  beforeEach(() => {
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

    setInput(getDateInput(), "2026-06-24");
    const filteredTable = getTable();
    expect(filteredTable.textContent).toContain("2026-06-24");
    expect(filteredTable.textContent).not.toContain("2026-06-25");

    await click(getButtonByText("总计"));
    await flush();
    expect(host?.textContent).toContain("日期筛选仅支持按天视图");
    expect(fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.includes("date="))).toBe(false);
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
  return vi.fn(async (input: RequestInfo | URL) => {
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
          usageRow("total", "deepseek-v4-pro", 2000, 800, 0.002),
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

function usageRow(bucket: string, modelId: string, inputTokens: number, outputTokens: number, costCny: number) {
  return {
    bucket,
    modelId,
    inputTokens,
    outputTokens,
    cacheHitTokens: Math.floor(inputTokens / 2),
    cacheMissTokens: Math.ceil(inputTokens / 2),
    calls: 1,
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

function getDateInput(): HTMLInputElement {
  const input = host?.querySelector<HTMLInputElement>('input[type="date"]');
  if (!input) throw new Error("date input not found");
  return input;
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

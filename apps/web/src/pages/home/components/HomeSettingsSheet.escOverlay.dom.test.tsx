// @vitest-environment jsdom
// 设置弹层 Esc 单一出口回归:浮层开着时 Esc 只关最上层浮层(不看焦点在哪),栈空才关面板。
// 病灶复现:点开档位 chip 菜单后焦点掉回 body,老实现里菜单靠自身 keydown 才关、
// 面板守卫又"见浮层就放行",于是 Esc 完全无操作。

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../system/ToastProvider";
import { resetOverlayDismissStackForTest } from "../../../system/overlayDismissStack";
import { __resetClientPersistCacheForTests } from "../../../overlays/settings/clientPersist";
import { setVisitorDeepseekKey } from "../../../overlays/settings/visitorKeyStore";
import { resetSettingsDialogA11yForTest } from "../../../overlays/settings/settingsDialogA11y";
import { HomeSettingsSheet, type SettingsSheetTab } from "./HomeSettingsSheet";

vi.mock("./settingsInkVariants", () => ({
  SettingsInkBackdrop: () => <div data-testid="ink-backdrop" />,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const onClose = vi.fn();

describe("HomeSettingsSheet 浮层关闭栈", () => {
  beforeEach(() => {
    __resetClientPersistCacheForTests();
    resetOverlayDismissStackForTest();
    window.localStorage.clear();
    onClose.mockClear();
    Object.defineProperty(window, "electron", { configurable: true, value: undefined });
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
    resetOverlayDismissStackForTest();
    resetSettingsDialogA11yForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("档位 chip 菜单开着且焦点在 body:第一次 Esc 只关菜单,第二次才关设置面板", async () => {
    await setVisitorDeepseekKey("deepseek-esc-key");
    await render("model");

    await click(getChip());
    expect(document.body.querySelector(".md-tier-menu")).not.toBeNull();

    blurFocus();
    expect(document.activeElement).toBe(document.body);

    await escapeOn(document.body);
    expect(document.body.querySelector(".md-tier-menu")).toBeNull();
    expect(getChip().getAttribute("aria-expanded")).toBe("false");
    expect(isSheetClosing()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    blurFocus();
    await escapeOn(document.body);
    expect(isSheetClosing()).toBe(true);
  });

  it("焦点仍在档位 chip 上按 Esc:菜单关、设置面板留(不回归)", async () => {
    await setVisitorDeepseekKey("deepseek-esc-key");
    await render("model");

    await click(getChip());
    getChip().focus();
    expect(document.activeElement).toBe(getChip());

    await escapeOn(getChip());
    expect(document.body.querySelector(".md-tier-menu")).toBeNull();
    expect(getChip().getAttribute("aria-expanded")).toBe("false");
    expect(isSheetClosing()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("日历浮层开着且焦点在 body:第一次 Esc 只关日历,第二次才关设置面板", async () => {
    await render("model");

    const trigger = getButtonByLabel("筛选用量日期");
    await click(trigger);
    expect(document.body.querySelector(".skin-calendar")).not.toBeNull();

    blurFocus();
    await escapeOn(document.body);
    expect(document.body.querySelector(".skin-calendar")).toBeNull();
    expect(isSheetClosing()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    blurFocus();
    await escapeOn(document.body);
    expect(isSheetClosing()).toBe(true);
  });

  it("安全页下拉(SkinSelect)开着且焦点在 body:第一次 Esc 只关下拉,第二次才关设置面板", async () => {
    await render("security");

    const select = getButtonByLabel("同类操作的确认方式");
    await click(select);
    expect(document.body.querySelector(".skin-select__menu")).not.toBeNull();

    blurFocus();
    await escapeOn(document.body);
    expect(document.body.querySelector(".skin-select__menu")).toBeNull();
    expect(select.getAttribute("aria-expanded")).toBe("false");
    expect(isSheetClosing()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    blurFocus();
    await escapeOn(document.body);
    expect(isSheetClosing()).toBe(true);
  });

  it("没有浮层时 Esc 照旧直接关设置面板", async () => {
    await render("model");

    blurFocus();
    await escapeOn(document.body);
    expect(isSheetClosing()).toBe(true);
  });
});

async function render(tab: SettingsSheetTab): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ToastProvider>
        <HomeSettingsSheet
          initialTab={tab}
          inkVariant="paper"
          themeMode="paper"
          themeModeOptions={[{ id: "paper", label: "宣纸" }]}
          anim="none"
          animOptions={[{ id: "none", label: "无" }]}
          reduceMotion={false}
          primaryFont="song"
          secondaryFont="song"
          fontOptions={[{ id: "song", label: "宋体" }]}
          onThemeModeChange={vi.fn()}
          onAnimChange={vi.fn()}
          onReduceMotionToggle={vi.fn()}
          onPrimaryFontChange={vi.fn()}
          onSecondaryFontChange={vi.fn()}
          onClose={onClose}
        />
      </ToastProvider>,
    );
  });
  await flush();
}

function getChip(): HTMLButtonElement {
  const chip = host?.querySelector<HTMLButtonElement>('button[data-wf="ModelTierChipDeepseek"]');
  if (!chip) throw new Error("档位 chip 未找到");
  return chip;
}

function getButtonByLabel(label: string): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`${label} 按钮未找到`);
  return button;
}

// 设置面板是否已进入关闭流程(handleClose 先置 data-closing,700ms 后才真正 onClose)
function isSheetClosing(): boolean {
  const backdrop = host?.querySelector<HTMLElement>(".qj-sheet-backdrop");
  if (!backdrop) throw new Error("设置弹层未找到");
  return backdrop.dataset.closing === "true";
}

// 模拟真机:点开浮层后焦点掉回 BODY
function blurFocus(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function escapeOn(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/v1/settings/security")) {
      return json({
        categories: [
          { kind: "install", label: "安装", grantMode: "ask", grantModes: ["ask", "always"], present: false, grantId: null, version: 0 },
          { kind: "command", label: "同类操作", grantMode: "ask", grantModes: ["ask", "always"], present: false, grantId: null, version: 0 },
        ],
      });
    }
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
    if (url.includes("/api/v1/usage/summary")) return json({ rows: [] });
    if (url.includes("/api/v1/usage/docstats")) return json({ docs: 0, words: 0 });
    return json({});
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

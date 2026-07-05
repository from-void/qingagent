// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppUpdateWatcher } from "./AppUpdateWatcher";
import { ToastProvider } from "./ToastProvider";
import { resetDesktopUpdateStoreForTest } from "./desktopUpdateStore";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type UpdateStatus = {
  kind: "soft-ready" | "soft-available" | "force" | "mac-manual" | "none";
  version?: string;
  notesUrl?: string;
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let callbacks: Array<(payload: UpdateStatus) => void> = [];

describe("AppUpdateWatcher", () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    callbacks = [];
    // 共用 store 是模块级单例:清快照/监听,避免跨用例泄漏推送态。
    resetDesktopUpdateStoreForTest();
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: undefined,
    });
    vi.restoreAllMocks();
  });

  it("soft-ready 显示可手动关闭的重启更新 toast", async () => {
    const electron = installElectron();
    await renderWatcher();

    await emitUpdateStatus({ kind: "soft-ready", version: "1.2.3" });

    expect(host!.textContent).toContain("新版本已就绪");
    expect(host!.querySelector(".qa-toast-x")).not.toBeNull();

    await clickButton("重启更新");
    expect(electron.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("soft-available 显示前往下载页 toast", async () => {
    const electron = installElectron();
    await renderWatcher();

    await emitUpdateStatus({ kind: "soft-available", version: "1.2.3" });

    expect(host!.textContent).toContain("新版本可用");
    await clickButton("前往下载页");
    expect(electron.openDownloadPage).toHaveBeenCalledTimes(1);
  });

  it("mac-manual 显示前往下载页 toast", async () => {
    const electron = installElectron();
    await renderWatcher();

    await emitUpdateStatus({ kind: "mac-manual", version: "1.2.3" });

    expect(host!.textContent).toContain("新版本可用");
    await clickButton("前往下载页");
    expect(electron.openDownloadPage).toHaveBeenCalledTimes(1);
  });

  it("force 显示不可关闭的阻断更新弹窗", async () => {
    const electron = installElectron();
    await renderWatcher();

    await emitUpdateStatus({ kind: "force", version: "1.2.3" });

    expect(host!.querySelector(".wf-modal.open")).not.toBeNull();
    expect(host!.textContent).toContain("当前版本已停止支持,请更新后继续使用");
    expect(host!.querySelector('[aria-label="close"]')).toBeNull();

    await clickButton("前往下载页");
    expect(electron.openDownloadPage).toHaveBeenCalledTimes(1);
    expect(host!.querySelector(".wf-modal.open")).not.toBeNull();
  });
});

function installElectron() {
  const electron = {
    platform: "linux",
    isDesktop: true,
    onUpdateStatus: vi.fn((cb: (payload: UpdateStatus) => void) => {
      callbacks.push(cb);
      return () => {
        callbacks = callbacks.filter((item) => item !== cb);
      };
    }),
    quitAndInstall: vi.fn(async () => undefined),
    openDownloadPage: vi.fn(async () => undefined),
  };
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: electron,
  });
  return electron;
}

async function renderWatcher(): Promise<void> {
  await render(
    <ToastProvider>
      <AppUpdateWatcher />
    </ToastProvider>,
  );
}

async function render(element: ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
  });
}

async function emitUpdateStatus(payload: UpdateStatus): Promise<void> {
  const cb = callbacks[0];
  if (!cb) throw new Error("update status listener not registered");
  await act(async () => {
    cb(payload);
  });
}

async function clickButton(text: string): Promise<void> {
  const button = Array.from(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    .find((item) => item.textContent === text);
  if (!button) throw new Error(`button not found: ${text}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

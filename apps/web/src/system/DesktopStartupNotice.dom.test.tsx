// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopStartupNotice } from "./DesktopStartupNotice";
import { ToastProvider } from "./ToastProvider";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("DesktopStartupNotice", () => {
  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    delete window.electron;
    vi.restoreAllMocks();
  });

  it("跨系统绑定降级以 sticky qa-toast 告知，渲染不回执也不阻塞启动", async () => {
    const acknowledge = vi.fn(async () => true);
    window.electron = {
      platform: "win32",
      isDesktop: true,
      getPendingStartupNotice: () => "cross-namespace-library-demoted",
      acknowledgeStartupNotice: acknowledge,
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <ToastProvider>
          <DesktopStartupNotice />
        </ToastProvider>,
      );
    });

    const toast = document.querySelector<HTMLElement>(
      '[data-toast-key="cross-namespace-library-demoted"]',
    );
    expect(toast?.classList.contains("sticky")).toBe(true);
    expect(toast?.textContent).toContain("已改用本机文库");
    expect(toast?.textContent).toContain("原 WSL 文库数据仍在 WSL 中，未受影响");
    expect(acknowledge).not.toHaveBeenCalled();

    await act(async () => {
      toast?.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')?.click();
      await Promise.resolve();
    });
    expect(acknowledge).toHaveBeenCalledWith("cross-namespace-library-demoted");
  });
});

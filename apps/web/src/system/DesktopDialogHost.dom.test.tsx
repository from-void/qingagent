// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "./ConfirmProvider";
import { DesktopDialogHost } from "./DesktopDialogHost";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("DesktopDialogHost", () => {
  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    delete window.electron;
    vi.restoreAllMocks();
  });

  it("生成中退出走全局自绘确认卡，并把退出选择回传主进程", async () => {
    let onRequest: ((request: ElectronDesktopDialogRequest) => void) | undefined;
    const markReady = vi.fn();
    const respond = vi.fn();
    window.electron = {
      platform: "win32",
      isDesktop: true,
      onDesktopDialogRequest: (callback) => {
        onRequest = callback;
        return () => {
          onRequest = undefined;
        };
      },
      markDesktopDialogReady: markReady,
      respondToDesktopDialog: respond,
    };

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ConfirmProvider>
          <main id="web-app-shell" />
          <DesktopDialogHost />
        </ConfirmProvider>,
      );
    });

    expect(markReady).toHaveBeenCalledWith(["quit-during-generation"]);
    await act(async () => {
      onRequest?.({ id: 7, kind: "quit-during-generation" });
    });
    const card = document.querySelector<HTMLElement>('[data-wf="GlobalConfirm"]');
    expect(card?.textContent).toContain("正在生成，退出将中断");
    expect(card?.textContent).toContain("继续生成");
    expect(card?.textContent).toContain("退出应用");
    expect(document.activeElement?.textContent).toBe("继续生成");

    await act(async () => {
      buttonByText("退出应用").click();
      await Promise.resolve();
    });
    expect(respond).toHaveBeenCalledWith(7, "confirm");
  });
});

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent === text);
  if (!button) throw new Error(`按钮未找到：${text}`);
  return button;
}

// @vitest-environment jsdom
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileOpenOnDesktopNotice } from "./App";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("MobileOpenOnDesktopNotice", () => {
  it("Clipboard 与 execCommand 都失败时不报复制成功，并提示手动复制", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => Promise.reject(new Error("blocked"))) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    const onCopied = vi.fn();
    const onCopyFailed = vi.fn();
    await render(
      <MobileOpenOnDesktopNotice
        url="https://example.test/desktop"
        onCopied={onCopied}
        onCopyFailed={onCopyFailed}
      />,
    );

    await clickCopy();

    expect(onCopied).not.toHaveBeenCalled();
    expect(onCopyFailed).toHaveBeenCalledTimes(1);
  });

  it("Clipboard 失败但 execCommand 成功时只报复制成功", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => Promise.reject(new Error("blocked"))) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => true),
    });
    const onCopied = vi.fn();
    const onCopyFailed = vi.fn();
    await render(
      <MobileOpenOnDesktopNotice
        url="https://example.test/desktop"
        onCopied={onCopied}
        onCopyFailed={onCopyFailed}
      />,
    );

    await clickCopy();

    expect(onCopied).toHaveBeenCalledTimes(1);
    expect(onCopyFailed).not.toHaveBeenCalled();
  });
});

async function render(element: ReactElement): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
  });
}

async function clickCopy(): Promise<void> {
  const button = host?.querySelector<HTMLButtonElement>(".mobile-desktop-notice__button");
  if (!button) throw new Error("copy button not found");
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

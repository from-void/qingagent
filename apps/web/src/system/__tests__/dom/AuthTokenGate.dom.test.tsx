import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../authGate", () => ({
  AUTH_REQUIRED_EVENT: "qa-auth-required",
  cancelAuth: vi.fn(),
  hasPendingAuth: vi.fn(() => false),
  submitAuthToken: vi.fn(async () => true),
}));

import { AuthTokenGate } from "../../AuthTokenGate";
import { submitAuthToken } from "../../authGate";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("AuthTokenGate", () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.clearAllMocks();
  });

  it("收到 qa-auth-required 后渲染输入卡,输入并提交 token", async () => {
    await render(<AuthTokenGate />);

    act(() => {
      window.dispatchEvent(new CustomEvent("qa-auth-required"));
    });

    expect(host?.textContent).toContain("需要访问令牌");
    expect(host?.textContent).toContain("请输入 QINGAGENT_AUTH_TOKEN");

    const input = getInput();
    setInputValue(input, "secret-xyz");
    await act(async () => {
      getButton("解锁").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(submitAuthToken).toHaveBeenCalledWith("secret-xyz");
  });
});

async function render(element: ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
  });
}

function getInput(): HTMLInputElement {
  const input = host?.querySelector<HTMLInputElement>('input[aria-label="访问令牌"]');
  if (!input) throw new Error("auth token input not found");
  return input;
}

function getButton(text: string): HTMLButtonElement {
  const button = Array.from(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    .find((item) => item.textContent === text);
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./ToastProvider";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("ToastProvider", () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.restoreAllMocks();
  });

  it("普通 toast 不会把常驻错误从三条队列中挤掉", async () => {
    const onDismiss = vi.fn();
    await render(
      <ToastProvider>
        <ToastHarness onDismiss={onDismiss} />
      </ToastProvider>,
    );

    await click(buttonByText("sticky"));
    await click(buttonByText("info-a"));
    await click(buttonByText("info-b"));
    await click(buttonByText("info-c"));

    const toasts = Array.from(host!.querySelectorAll<HTMLElement>(".qa-toast"));
    expect(toasts).toHaveLength(3);
    expect(toasts.some((toast) => toast.textContent?.includes("常驻错误"))).toBe(true);
    expect(host!.textContent).not.toContain("普通 A");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("dedupeKey 更新同一条 toast,路由级清理可跳过 onDismiss", async () => {
    const onDismiss = vi.fn();
    await render(
      <ToastProvider>
        <ToastHarness onDismiss={onDismiss} />
      </ToastProvider>,
    );

    await click(buttonByText("sticky"));
    await click(buttonByText("sticky-update"));
    expect(host!.querySelectorAll("[data-toast-key='sticky-error']")).toHaveLength(1);
    expect(host!.textContent).toContain("常驻错误已更新");

    await click(buttonByText("clear-sticky"));

    expect(host!.querySelector("[data-toast-key='sticky-error']")).toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

function ToastHarness({ onDismiss }: { onDismiss: () => void }) {
  const toast = useToast();
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          toast.show({
            message: "常驻错误",
            tone: "error",
            sticky: true,
            dedupeKey: "sticky-error",
            onDismiss,
          })
        }
      >
        sticky
      </button>
      <button
        type="button"
        onClick={() =>
          toast.show({
            message: "常驻错误已更新",
            tone: "error",
            sticky: true,
            dedupeKey: "sticky-error",
            onDismiss,
          })
        }
      >
        sticky-update
      </button>
      <button type="button" onClick={() => toast.show("普通 A")}>info-a</button>
      <button type="button" onClick={() => toast.show("普通 B")}>info-b</button>
      <button type="button" onClick={() => toast.show("普通 C")}>info-c</button>
      <button type="button" onClick={() => toast.dismiss("sticky-error", { runOnDismiss: false })}>
        clear-sticky
      </button>
    </div>
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

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(host!.querySelectorAll("button")).find(
    (node) => node.textContent === text,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
  return button;
}

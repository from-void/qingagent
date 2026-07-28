// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTooltip } from "../../components/WorkspaceTooltip";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

describe("WorkspaceTooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    if (!window.requestAnimationFrame) {
      Object.defineProperty(window, "requestAnimationFrame", {
        configurable: true,
        writable: true,
        value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0),
      });
    }
    if (!window.cancelAnimationFrame) {
      Object.defineProperty(window, "cancelAnimationFrame", {
        configurable: true,
        writable: true,
        value: (id: number) => window.clearTimeout(id),
      });
    }
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 16),
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
      window.clearTimeout(id);
    });
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("hover æ—¶æ”¶èµ·åŽŸç”Ÿ title å¹¶æ˜¾ç¤ºç»Ÿä¸€æ ·å¼çš„æç¤º", () => {
    render(
      <button type="button" title="è¿”å›žé¦–é¡µ">
        â†
      </button>,
    );

    const button = host!.querySelector("button")!;

    act(() => {
      button.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: null }));
    });

    expect(button.hasAttribute("title")).toBe(false);
    expect(host!.querySelector(".workspace-tooltip")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(160);
    });

    expect(host!.querySelector(".workspace-tooltip")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(16);
    });

    const tooltip = host!.querySelector(".workspace-tooltip.is-visible");
    expect(tooltip?.textContent).toBe("è¿”å›žé¦–é¡µ");

    act(() => {
      button.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    });

    expect(button.getAttribute("title")).toBe("è¿”å›žé¦–é¡µ");
    expect(host!.querySelector(".workspace-tooltip")).toBeNull();
  });

  it("é”®ç›˜ focus ä¹Ÿèƒ½æ˜¾ç¤ºæç¤ºå¹¶åœ¨ç¦»å¼€åŽè¿˜åŽŸ title", () => {
    render(
      <button type="button" title="å¯¼å‡º">
        icon
      </button>,
    );

    const button = host!.querySelector("button")!;

    act(() => {
      button.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: null }));
    });

    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(button.hasAttribute("title")).toBe(false);
    expect(host!.querySelector(".workspace-tooltip.is-visible")?.textContent).toBe("å¯¼å‡º");

    act(() => {
      button.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    });

    expect(button.getAttribute("title")).toBe("å¯¼å‡º");
    expect(host!.querySelector(".workspace-tooltip")).toBeNull();
  });

  it("焦点目标被直接卸载时立即清除已显示的提示", async () => {
    render(
      <button type="button" title="导出">
        icon
      </button>,
    );
    const button = host!.querySelector("button")!;

    act(() => {
      button.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: null }));
    });
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(host!.querySelector(".workspace-tooltip.is-visible")?.textContent).toBe("导出");

    await act(async () => {
      button.remove();
      await Promise.resolve();
    });

    expect(host!.querySelector(".workspace-tooltip")).toBeNull();
  });

  it("æ²¡æœ‰ title çš„æŒ‰é’®ä¸ä¼šå‡º hover æç¤º", () => {
    render(
      <button type="button" className="block-handle-btn">
        +
      </button>,
    );

    const button = host!.querySelector("button")!;

    act(() => {
      button.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: null }));
      vi.advanceTimersByTime(200);
    });

    expect(host!.querySelector(".workspace-tooltip")).toBeNull();
  });
});

function render(child: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);

  act(() => {
    root!.render(
      <section id="view-workspace">
        {child}
        <WorkspaceTooltip />
      </section>,
    );
  });
}

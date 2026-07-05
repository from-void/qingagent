// @vitest-environment jsdom
import { act, useLayoutEffect, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoScroll } from "./useAutoScroll";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("useAutoScroll", () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.unstubAllGlobals();
  });

  it("enabled 在 layout 阶段同步关闭后,旧 observer 不再排队滚到底部", async () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    const observers: Array<() => void> = [];
    let rafCountDuringDisableLayout = 0;

    class FakeMutationObserver implements MutationObserver {
      constructor(private readonly callback: MutationCallback) {
        observers.push(() => this.callback([], this));
      }
      observe() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
      takeRecords() {
        return [];
      }
    }

    vi.stubGlobal("MutationObserver", FakeMutationObserver);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });

    function Harness({
      enabled,
      triggerQueuedMutation,
    }: {
      enabled: boolean;
      triggerQueuedMutation: boolean;
    }) {
      const ref = useRef<HTMLDivElement>(null);
      useAutoScroll(ref, { enabled });
      useLayoutEffect(() => {
        if (!triggerQueuedMutation) return;
        observers[0]?.();
        rafCountDuringDisableLayout = rafCallbacks.length;
      }, [triggerQueuedMutation]);
      return <div ref={ref}>content</div>;
    }

    await render(<Harness enabled triggerQueuedMutation={false} />);

    await act(async () => {
      root?.render(<Harness enabled={false} triggerQueuedMutation />);
    });

    expect(rafCountDuringDisableLayout).toBe(0);
    expect(rafCallbacks).toHaveLength(0);
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

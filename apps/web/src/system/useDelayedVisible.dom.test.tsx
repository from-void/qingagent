// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDelayedVisible } from "./useDelayedVisible";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function Probe({ active }: { active: boolean }) {
  const visible = useDelayedVisible(active);
  return <div data-testid="probe">{visible ? "加载中…" : ""}</div>;
}

describe("useDelayedVisible", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.useRealTimers();
  });

  it("加载不足 250ms 时占位从不出现(设置页不再闪一下加载中)", () => {
    act(() => root?.render(<Probe active />));
    expect(host?.textContent).toBe("");

    act(() => vi.advanceTimersByTime(240));
    expect(host?.textContent).toBe("");

    // 240ms 内数据就回来了:全程无占位
    act(() => root?.render(<Probe active={false} />));
    act(() => vi.advanceTimersByTime(1000));
    expect(host?.textContent).toBe("");
  });

  it("加载超过 250ms 才显形,结束后立即撤下", () => {
    act(() => root?.render(<Probe active />));
    act(() => vi.advanceTimersByTime(250));
    expect(host?.textContent).toBe("加载中…");

    act(() => root?.render(<Probe active={false} />));
    expect(host?.textContent).toBe("");
  });
});

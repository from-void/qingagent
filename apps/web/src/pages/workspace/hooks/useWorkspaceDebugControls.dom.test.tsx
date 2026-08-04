// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceDebugControls } from "./useWorkspaceDebugControls";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const controls = useWorkspaceDebugControls();
  return <>
    <output data-shown={controls.demoBarShown} data-input-out={controls.inputContentOut} />
    <button onClick={() => controls.setDevToolsOpen(true)}>打开</button>
    <button onClick={controls.handleMorphEnter}>演示</button>
    <button onClick={() => controls.setDevToolsOpen(false)}>关闭</button>
  </>;
}

describe("useWorkspaceDebugControls 定时器生命周期", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("关闭调试面板会取消待执行的形态进入", () => {
    const buttons = host.querySelectorAll<HTMLButtonElement>("button");
    act(() => buttons[0]!.click());
    act(() => buttons[1]!.click());
    act(() => buttons[2]!.click());
    act(() => vi.runAllTimers());

    const output = host.querySelector("output")!;
    expect(output.dataset.shown).toBe("false");
    expect(output.dataset.inputOut).toBe("false");
  });
});

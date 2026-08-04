import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QingLoading } from "./QingLoading";

describe("QingLoading rAF 调度", () => {
  let host: HTMLDivElement;
  let nextFrameId: number;
  let frames: Map<number, FrameRequestCallback>;
  let requestFrame: ReturnType<typeof vi.fn>;
  let cancelFrame: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    nextFrameId = 0;
    frames = new Map();
    requestFrame = vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    });
    cancelFrame = vi.fn((id: number) => {
      frames.delete(id);
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  });

  afterEach(() => {
    host.remove();
    vi.unstubAllGlobals();
  });

  it("静止态停止排帧，reasoning 切换时可靠重启和再停止", () => {
    const root = createRoot(host);
    act(() => root.render(<QingLoading reasoning={false} />));

    expect(host.querySelectorAll(".qing-ch").length).toBeGreaterThan(100);
    expect(flushUntilIdle(frames)).toBe(true);
    const staticRequestCount = requestFrame.mock.calls.length;
    expect(frames.size).toBe(0);

    act(() => root.render(<QingLoading reasoning />));
    flushNextFrame(frames);
    flushNextFrame(frames);
    flushNextFrame(frames);
    expect(requestFrame.mock.calls.length).toBeGreaterThan(staticRequestCount);
    expect(frames.size).toBeGreaterThan(0);

    act(() => root.render(<QingLoading reasoning={false} />));
    expect(flushUntilIdle(frames)).toBe(true);
    expect(frames.size).toBe(0);

    act(() => root.render(<QingLoading reasoning />));
    flushNextFrame(frames);
    const activeFrameIds = [...frames.keys()];
    act(() => root.unmount());
    expect(activeFrameIds.some((id) => cancelFrame.mock.calls.some(([cancelled]) => cancelled === id))).toBe(true);
  });
});

function flushNextFrame(frames: Map<number, FrameRequestCallback>): boolean {
  const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
  if (!next) return false;
  const [id, callback] = next;
  frames.delete(id);
  act(() => callback(id * 16));
  return true;
}

function flushUntilIdle(frames: Map<number, FrameRequestCallback>, limit = 20): boolean {
  for (let index = 0; index < limit && frames.size > 0; index += 1) {
    flushNextFrame(frames);
  }
  return frames.size === 0;
}

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVisibilityPausedInterval,
  createVisibilityPausedRaf,
} from "./visibilityScheduler";

const originalDocumentHidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");

function setDocumentHidden(value: boolean): void {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function createRafHarness() {
  let nextId = 1;
  const pendingFrames = new Map<number, FrameRequestCallback>();
  const requestAnimationFrameSpy = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback: FrameRequestCallback) => {
      const id = nextId;
      nextId += 1;
      pendingFrames.set(id, callback);
      return id;
    });
  const cancelAnimationFrameSpy = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((id: number) => {
      pendingFrames.delete(id);
    });

  return {
    cancelAnimationFrameSpy,
    pendingFrames,
    requestAnimationFrameSpy,
    runNextFrame: (timestamp = 16) => {
      const frame = pendingFrames.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!frame) {
        throw new Error("No pending RAF frame");
      }
      pendingFrames.delete(frame[0]);
      frame[1](timestamp);
    },
  };
}

describe("visibilityScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "hidden");
    if (originalDocumentHidden) {
      Object.defineProperty(Document.prototype, "hidden", originalDocumentHidden);
    }
  });

  it("pauses intervals while the document is hidden and resumes when visible", () => {
    vi.useFakeTimers();
    setDocumentHidden(false);
    const callback = vi.fn();

    const timer = createVisibilityPausedInterval(callback, 100);
    vi.advanceTimersByTime(250);
    expect(callback).toHaveBeenCalledTimes(2);

    setDocumentHidden(true);
    vi.advanceTimersByTime(500);
    expect(callback).toHaveBeenCalledTimes(2);

    setDocumentHidden(false);
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledTimes(3);

    timer.stop();
    vi.advanceTimersByTime(200);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("lets RAF callbacks return false to enter idle without another frame", () => {
    setDocumentHidden(false);
    const { pendingFrames, requestAnimationFrameSpy, runNextFrame } = createRafHarness();
    const callback = vi.fn(() => false);

    const loop = createVisibilityPausedRaf(callback);
    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);
    expect(pendingFrames.size).toBe(1);

    runNextFrame(16);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(pendingFrames.size).toBe(0);

    loop.stop();
  });

  it("wakes a RAF loop from idle", () => {
    setDocumentHidden(false);
    const { pendingFrames, requestAnimationFrameSpy, runNextFrame } = createRafHarness();
    const callback = vi.fn(() => false);

    const loop = createVisibilityPausedRaf(callback);
    runNextFrame(16);
    expect(pendingFrames.size).toBe(0);

    loop.wake();
    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(2);
    expect(pendingFrames.size).toBe(1);

    runNextFrame(32);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(pendingFrames.size).toBe(0);

    loop.stop();
  });

  it("pauses RAF work while hidden and wakes one idle frame on restore", () => {
    setDocumentHidden(false);
    const {
      cancelAnimationFrameSpy,
      pendingFrames,
      requestAnimationFrameSpy,
      runNextFrame,
    } = createRafHarness();
    const callback = vi.fn(() => false);

    const loop = createVisibilityPausedRaf(callback);
    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);
    expect(pendingFrames.size).toBe(1);

    setDocumentHidden(true);
    expect(cancelAnimationFrameSpy).toHaveBeenCalledTimes(1);
    expect(pendingFrames.size).toBe(0);

    setDocumentHidden(false);
    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(2);
    expect(pendingFrames.size).toBe(1);

    runNextFrame(32);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(pendingFrames.size).toBe(0);

    loop.stop();
  });

  it("keeps the existing void RAF callback loop behavior", () => {
    setDocumentHidden(false);
    const {
      cancelAnimationFrameSpy,
      pendingFrames,
      requestAnimationFrameSpy,
      runNextFrame,
    } = createRafHarness();
    const callback = vi.fn();

    const loop = createVisibilityPausedRaf(callback);
    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);
    expect(pendingFrames.size).toBe(1);

    runNextFrame(16);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(pendingFrames.size).toBe(1);

    setDocumentHidden(true);
    expect(cancelAnimationFrameSpy).toHaveBeenCalledTimes(1);
    expect(pendingFrames.size).toBe(0);

    setDocumentHidden(false);
    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(3);
    expect(pendingFrames.size).toBe(1);

    loop.stop();
    expect(pendingFrames.size).toBe(0);
  });
});

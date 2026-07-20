// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHomeTransitionStage } from "./homeStage";

describe("homeStage 深色桌面交接", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("is-dark-anim 只由 forward 加入，snapArrived 会恢复瞬时静帧", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const stage = createHomeTransitionStage(host);
    const rect = { left: 100, top: 80, width: 320, height: 420 };

    void stage.playForward(rect, rect, { x: 260, y: 290 });
    expect(host.classList.contains("is-dark-anim")).toBe(true);

    stage.snapArrived(rect);
    expect(host.classList.contains("is-dark-anim")).toBe(false);
    expect(host.classList.contains("is-ink-wipe")).toBe(true);
    expect(host.classList.contains("is-dark")).toBe(true);

    stage.dispose();
    expect(host.classList.contains("is-dark-anim")).toBe(false);
  });
});

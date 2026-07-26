// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHomeTransitionStage } from "./homeStage";

describe("ccx-stage-host 的归属", () => {
  it("必须写在 QingjianScroll 的 className 里,不能只靠 classList.add", () => {
    // 回归:该 class 原先只由 createHomeTransitionStage 用 classList.add 挂上,而 .qj-root 的
    // className 是 React 的整串模板 —— openingScroll 一变就把它擦掉。深底规则
    // .qj-root.ccx-stage-host.is-dark .ccx-space 随之永不匹配:is-dark 加了也没用,
    // .ccx-space 的 opacity 恒为 0 → 「纸已飞到落点、背景还是首页浅底」。
    // 实测(逐帧):擦掉后 op 恒 0;写进 className 后 op 在 0.32s 内 0 → 1。
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      path.resolve(here, "../../home/components/QingjianScroll.tsx"),
      "utf8",
    );
    expect(src).toMatch(/className=\{`qj-root ccx-stage-host/);
  });
});

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

  it("墨渗一帧都不推进时,背景仍按兜底时刻置深(不许露出首页浅底)", async () => {
    // 回归:去程的背景置深原先只挂在墨渗进度回调上(e > 0.82)。WebGL 首帧卡在驱动编译、
    // 掉帧、上下文丢失时 onProgress 迟迟不来,屏幕上就是「纸已经飞到落点、背景还是首页浅底」
    // (用户录屏实证)。这里模拟一个 ok=true 但永不回调、永不 resolve 的墨层。
    vi.resetModules();
    vi.doMock("./inkWipe", () => ({
      createInkWipe: () => ({
        ok: true,
        play: () => new Promise<void>(() => {}), // 永不推进、永不结束
        hide: () => {},
        dispose: () => {},
      }),
      prewarmInkWipe: () => true,
    }));
    vi.useFakeTimers();
    const { createHomeTransitionStage: create } = await import("./homeStage");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const stage = create(host);
    const rect = { left: 100, top: 80, width: 320, height: 420 };

    void stage.playForward(rect, rect, { x: 260, y: 290 });
    expect(host.classList.contains("is-dark")).toBe(false); // 还没到兜底时刻

    await vi.advanceTimersByTimeAsync(800); // 越过 DARK_FALLBACK_MS(780)
    expect(host.classList.contains("is-dark")).toBe(true);

    stage.dispose();
    vi.useRealTimers();
    vi.doUnmock("./inkWipe");
    vi.resetModules();
  });

  it("文档编辑页返回(animate=false):纸切纯净皮 + 往下滑出视口收起", () => {
    // 回归:返程 morph 是首页重挂载时新建的元素,不补 ccx-morph-plain 就会先露出
    // 新建卡皮(噪点/棕框/朱砂角标)再消失。位移必须是「滑到视口下沿」而非原地淡出。
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const stage = createHomeTransitionStage(host);
    const morph = host.querySelector<HTMLElement>(".ccx-morph");
    const face = host.querySelector<HTMLElement>(".ccx-morph-face");
    const from = { left: 640, top: 52, width: 800, height: 868 };

    // 到达态首帧就必须是纯净纸:playReturn 要等双 rAF,晚一两帧就会 paint 出新建卡皮
    stage.snapArrived(from, true);
    expect(morph?.classList.contains("ccx-morph-plain")).toBe(true);

    void stage.playReturn(from, from, { x: 1040, y: 486 }, false);

    expect(morph?.classList.contains("ccx-morph-plain")).toBe(true);
    expect(face?.style.opacity).toBe("0");
    expect(face?.style.transform).toBe(
      `translate(640px,${window.innerHeight}px)`,
    );
    expect(face?.style.transition).toContain("transform");

    raf.mockRestore();
    stage.dispose();
  });
});

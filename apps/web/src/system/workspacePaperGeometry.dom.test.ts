import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHomeTransitionStage } from "../pages/new-session/transition/homeStage";
import {
  measureWorkspacePaperRect,
  WORKSPACE_PAPER_CSS_VARIABLES,
} from "./workspacePaperGeometry";

function domRect(input: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DOMRect {
  return new DOMRect(input.left, input.top, input.width, input.height);
}

describe("首页转场纸与工作区真纸几何交接", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("无目标页 DOM 时以同构探针实测浏览器滚动槽后的纸壳 rect", () => {
    const expected = {
      left: 736,
      top: 52,
      width: 792,
      height: 848,
    };
    const nativeGetRect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect(this: Element) {
        if (this.classList.contains("ws-paper-geometry-probe__paper")) {
          const probe = this.closest<HTMLElement>(".ws-paper-geometry-probe");
          expect(
            probe?.style.getPropertyValue("--ws-paper-column-width"),
          ).toBe(WORKSPACE_PAPER_CSS_VARIABLES["--ws-paper-column-width"]);
          return domRect(expected);
        }
        return nativeGetRect.call(this);
      },
    );

    expect(measureWorkspacePaperRect()).toEqual(expected);
    expect(document.querySelector(".ws-paper-geometry-probe")).toBeNull();
  });

  it("真实转场 DOM 的纸面层在落定帧重取目标，终帧与工作区首帧误差不超过 1px", async () => {
    // 6182 真机病例（旧实现把目标写到 morph 外盒，测试只查几何函数所以漏掉）：
    // 工作区 `.wf-doc` 首帧      [492, 52, 792, 525]
    // `.ccx-morph` 外盒终帧      [492, 52, 816, 539]
    // `.ccx-morph-frame` 终帧    [530, 68, 737, 506]
    // 本测试必须挂 createHomeTransitionStage 的真实 DOM，并只把
    // `[data-wf="TransitionPaperFace"]` 当作用户看到的纸边界。
    //
    // 第一次目标代表起飞前 viewport，第二次代表转场中 resize 后 `.wf-doc`
    // 在工作区首帧得到的实测矩形。
    const beforeResize = {
      left: 540,
      top: 52,
      width: 760,
      height: 560,
    };
    const workspaceFirstFrame = {
      left: 492,
      top: 52,
      width: 792,
      height: 525,
    };
    let resized = false;

    const workspace = document.createElement("section");
    workspace.id = "view-workspace";
    const paper = document.createElement("div");
    paper.className = "wf-doc";
    paper.dataset.wf = "WorkspacePaperShell";
    paper.getBoundingClientRect = () =>
      domRect(resized ? workspaceFirstFrame : beforeResize);
    workspace.appendChild(paper);
    document.body.appendChild(workspace);

    const rafCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );

    const host = document.createElement("div");
    document.body.appendChild(host);
    const stage = createHomeTransitionStage(host);
    const morph = host.querySelector<HTMLElement>(".ccx-morph");
    const face = host.querySelector<HTMLElement>(
      '[data-wf="TransitionPaperFace"]',
    );
    const frame = host.querySelector<HTMLElement>(".ccx-morph-frame");
    expect(face).not.toBeNull();
    expect(frame?.parentElement).toBe(face);

    // jsdom 不做布局：把真实 face 的 inline 几何注入为浏览器 BCR。
    // 这仍会覆盖“几何写错到外盒”的回归——旧 DOM 没有 face，且写入不会落到本元素。
    if (face) {
      face.getBoundingClientRect = () => {
        const translated = face.style.transform.match(
          /^translate\((-?\d+(?:\.\d+)?)px,(-?\d+(?:\.\d+)?)px\)/,
        );
        return domRect({
          left: Number(translated?.[1] ?? 0),
          top: Number(translated?.[2] ?? 0),
          width: Number.parseFloat(face.style.width) || 0,
          height: Number.parseFloat(face.style.height) || 0,
        });
      };
    }
    const settledPromise = stage.playForward(
      { left: 80, top: 100, width: 260, height: 360 },
      () => measureWorkspacePaperRect()!,
      { x: 210, y: 280 },
      true,
    );

    resized = true;
    // dust 若可用会先占一个 rAF；morph tween 始终是本轮最后注册的 callback。
    rafCallbacks.at(-1)?.(1100);
    const settled = await settledPromise;
    const faceRect = face!.getBoundingClientRect();

    expect(settled).toEqual(workspaceFirstFrame);
    expect(measureWorkspacePaperRect()).toEqual(workspaceFirstFrame);
    expect(face?.style.width).toBe(`${workspaceFirstFrame.width}px`);
    expect(face?.style.height).toBe(`${workspaceFirstFrame.height}px`);
    expect(face?.style.transform).toBe(
      `translate(${workspaceFirstFrame.left}px,${workspaceFirstFrame.top}px)`,
    );
    expect(face?.style.transition).toBe("none");
    expect(morph?.style.width).toBe("");
    expect(morph?.style.height).toBe("");
    expect(morph?.style.transform).toBe("");
    for (const key of ["left", "top", "width", "height"] as const) {
      expect(
        Math.abs(faceRect[key] - workspaceFirstFrame[key]),
        `${key} 应在 1px 容差内`,
      ).toBeLessThanOrEqual(1);
    }

    stage.dispose();
  });

  it("共享几何和纸壳均无入场 transition/animation，圆角恒为 0", () => {
    const appCss = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");
    const skinCss = readFileSync(
      resolve(process.cwd(), "src/pages/workspace/workspace-ink-skin.css"),
      "utf8",
    );
    const homeCss = readFileSync(
      resolve(process.cwd(), "src/pages/home/components/qingjian.css"),
      "utf8",
    );
    const newSessionCss = readFileSync(
      resolve(process.cwd(), "src/pages/new-session/new-session-qing.css"),
      "utf8",
    );
    const qingjianSource = readFileSync(
      resolve(
        process.cwd(),
        "src/pages/home/components/QingjianScroll.tsx",
      ),
      "utf8",
    );

    const probePaperRule = appCss.match(
      /\.ws-paper-geometry-probe__paper\s*\{[^}]*\}/,
    )?.[0];
    const paperRule = skinCss.match(
      /#view-workspace \.wf-doc,\s*#view-workspace \.ws-paper-shell\s*\{[^}]*\}/,
    )?.[0];
    const morphRule = homeCss.match(
      /\.qj-root \.ccx-morph\s*\{[^}]*\}/,
    )?.[0];
    const morphFaceRule = homeCss.match(
      /\.qj-root \.ccx-morph-face\s*\{[^}]*\}/,
    )?.[0];
    const newSessionMorphFaceRule = newSessionCss.match(
      /\.ccx-morph-face\s*\{[^}]*\}/,
    )?.[0];

    expect(WORKSPACE_PAPER_CSS_VARIABLES["--ws-paper-radius"]).toBe("0px");
    expect(probePaperRule).toContain("border-radius: var(--ws-paper-radius)");
    expect(paperRule).toContain("border-radius: var(--ws-paper-radius)");
    expect(morphFaceRule).toContain(
      "border-radius: var(--ws-paper-radius)",
    );
    expect(newSessionMorphFaceRule).toContain(
      "border-radius: var(--ws-paper-radius)",
    );
    expect(morphRule).toContain("overflow: visible");
    expect(morphRule).not.toMatch(/\b(?:background|box-shadow|border-radius)\s*:/);
    for (const rule of [
      probePaperRule,
      paperRule,
      morphFaceRule,
      newSessionMorphFaceRule,
    ]) {
      expect(rule).not.toMatch(/\b(?:transition|animation)\s*:/);
    }

    // 两条首页入口都必须把“测量函数”交给 stage，并使用 stage 返回的终帧 rect；
    // 不允许退回先算死 landing、转场结束后仍写旧值的链路。
    expect(
      qingjianSource.match(
        /\.playForward\([^,]+,\s*measureLanding,\s*inkOrigin,\s*true\)/g,
      ),
    ).toHaveLength(2);
    expect(qingjianSource.match(/\.then\(\(landing\) =>/g)).toHaveLength(2);
  });
});

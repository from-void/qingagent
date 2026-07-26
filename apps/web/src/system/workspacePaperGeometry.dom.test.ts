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

  it("落定帧重取目标纸壳，终帧与工作区首帧误差为 0px", async () => {
    // 注入式真机矩形：第一次代表起飞前 viewport，第二次代表转场中 resize 后，
    // 工作区 `.ws-paper-shell` 将在首帧得到的实际矩形。
    const beforeResize = {
      left: 734,
      top: 52,
      width: 792,
      height: 848,
    };
    const workspaceFirstFrame = {
      left: 654,
      top: 52,
      width: 792,
      height: 716,
    };
    let resized = false;

    const workspace = document.createElement("section");
    workspace.id = "view-workspace";
    const paper = document.createElement("div");
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
    const morph = host.querySelector<HTMLElement>(".ccx-morph");

    expect(settled).toEqual(workspaceFirstFrame);
    expect(measureWorkspacePaperRect()).toEqual(workspaceFirstFrame);
    expect(morph?.style.width).toBe(`${workspaceFirstFrame.width}px`);
    expect(morph?.style.height).toBe(`${workspaceFirstFrame.height}px`);
    expect(morph?.style.transform).toBe(
      `translate(${workspaceFirstFrame.left}px,${workspaceFirstFrame.top}px)`,
    );
    expect(morph?.style.transition).toBe("none");

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

    expect(WORKSPACE_PAPER_CSS_VARIABLES["--ws-paper-radius"]).toBe("0px");
    expect(probePaperRule).toContain("border-radius: var(--ws-paper-radius)");
    expect(paperRule).toContain("border-radius: var(--ws-paper-radius)");
    expect(morphRule).toContain("border-radius: var(--ws-paper-radius)");
    for (const rule of [probePaperRule, paperRule]) {
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

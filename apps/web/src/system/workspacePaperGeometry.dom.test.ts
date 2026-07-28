import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHomeTransitionStage } from "../pages/new-session/transition/homeStage";
import {
  measureWorkspacePaperRect,
  WORKSPACE_PAPER_CSS_VARIABLES,
  WORKSPACE_PAPER_DOM,
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

  it("同源真类名探针与真实挂载两路测量完全一致，且全程只有一个 #view-workspace", () => {
    const expected = {
      left: 492,
      top: 52,
      width: 792,
      height: 525,
    };
    let measuredProbe = false;
    const nativeGetRect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect(this: Element) {
        if (this.classList.contains(WORKSPACE_PAPER_DOM.documentClass)) {
          const view = this.closest<HTMLElement>(
            `#${WORKSPACE_PAPER_DOM.viewId}`,
          );
          if (view?.style.visibility === "hidden") {
            measuredProbe = true;
            expect(view.tagName).toBe("SECTION");
            expect(view.dataset.wf).toBe(WORKSPACE_PAPER_DOM.viewDataWf);
            expect(view.style.pointerEvents).toBe("none");
            expect(
              view.querySelector(
                `.${WORKSPACE_PAPER_DOM.bodyClass} > .${WORKSPACE_PAPER_DOM.chatColumnClass} + .${WORKSPACE_PAPER_DOM.paperColumnClass}`,
              ),
            ).not.toBeNull();
            expect(
              view.querySelector(
                `.${WORKSPACE_PAPER_DOM.paperColumnClass} > .${WORKSPACE_PAPER_DOM.paperShellClass}[data-wf="${WORKSPACE_PAPER_DOM.paperShellDataWf}"] + .${WORKSPACE_PAPER_DOM.documentContentClass} > .${WORKSPACE_PAPER_DOM.paperSurfaceClass}[data-wf="${WORKSPACE_PAPER_DOM.paperSurfaceDataWf}"] > .${WORKSPACE_PAPER_DOM.documentClass}[data-wf="${WORKSPACE_PAPER_DOM.documentDataWf}"]`,
              ),
            ).toBe(this);
            expect(
              document.querySelectorAll(`#${WORKSPACE_PAPER_DOM.viewId}`),
            ).toHaveLength(1);
          }
          expect(
            view?.style.getPropertyValue("--ws-paper-column-width"),
          ).toBe(WORKSPACE_PAPER_CSS_VARIABLES["--ws-paper-column-width"]);
          return domRect(expected);
        }
        return nativeGetRect.call(this);
      },
    );

    const probedRect = measureWorkspacePaperRect();
    expect(probedRect).toEqual(expected);
    expect(measuredProbe).toBe(true);
    expect(document.getElementById(WORKSPACE_PAPER_DOM.viewId)).toBeNull();

    // 第二路模拟 WorkspacePage 已真实挂载：measure 必须复用现有根节点，
    // 优先读取真 `.wf-doc`，绝不能再插入一个同 id 探针。
    const mountedView = document.createElement("section");
    mountedView.id = WORKSPACE_PAPER_DOM.viewId;
    mountedView.dataset.wf = WORKSPACE_PAPER_DOM.viewDataWf;
    const mountedBody = document.createElement("div");
    mountedBody.className = WORKSPACE_PAPER_DOM.bodyClass;
    const mountedChatColumn = document.createElement("div");
    mountedChatColumn.className = WORKSPACE_PAPER_DOM.chatColumnClass;
    const mountedPaperColumn = document.createElement("div");
    mountedPaperColumn.className = WORKSPACE_PAPER_DOM.paperColumnClass;
    const mountedShell = document.createElement("div");
    mountedShell.className = WORKSPACE_PAPER_DOM.paperShellClass;
    mountedShell.dataset.wf = WORKSPACE_PAPER_DOM.paperShellDataWf;
    const mountedContent = document.createElement("div");
    mountedContent.className = WORKSPACE_PAPER_DOM.documentContentClass;
    const mountedSurface = document.createElement("div");
    mountedSurface.className = WORKSPACE_PAPER_DOM.paperSurfaceClass;
    mountedSurface.dataset.wf = WORKSPACE_PAPER_DOM.paperSurfaceDataWf;
    const mountedPaper = document.createElement("article");
    mountedPaper.className = WORKSPACE_PAPER_DOM.documentClass;
    mountedPaper.dataset.wf = WORKSPACE_PAPER_DOM.documentDataWf;
    mountedPaper.getBoundingClientRect = () => domRect(expected);
    mountedSurface.appendChild(mountedPaper);
    mountedContent.appendChild(mountedSurface);
    mountedPaperColumn.append(mountedShell, mountedContent);
    mountedBody.append(mountedChatColumn, mountedPaperColumn);
    mountedView.appendChild(mountedBody);
    document.body.appendChild(mountedView);

    const mountedRect = measureWorkspacePaperRect();
    expect(mountedRect).toEqual(probedRect);
    expect(
      document.querySelectorAll(`#${WORKSPACE_PAPER_DOM.viewId}`),
    ).toHaveLength(1);
  });

  it("只测量右栏正文，并在正文尚未挂载时回退同一右栏纸壳", () => {
    const previewRect = {
      left: 40,
      top: 120,
      width: 320,
      height: 240,
    };
    const shellRect = {
      left: 492,
      top: 52,
      width: 792,
      height: 525,
    };
    const documentRect = {
      left: 492,
      top: 52,
      width: 792,
      height: 680,
    };
    const view = document.createElement("section");
    view.id = WORKSPACE_PAPER_DOM.viewId;

    const body = document.createElement("div");
    body.className = WORKSPACE_PAPER_DOM.bodyClass;
    const left = document.createElement("aside");
    left.className = WORKSPACE_PAPER_DOM.chatColumnClass;
    const askUserPreview = document.createElement("div");
    askUserPreview.className = `auq-preview-doc ${WORKSPACE_PAPER_DOM.documentClass}`;
    askUserPreview.getBoundingClientRect = vi.fn(() => domRect(previewRect));
    left.appendChild(askUserPreview);

    const right = document.createElement("main");
    right.className = WORKSPACE_PAPER_DOM.paperColumnClass;
    const shell = document.createElement("div");
    shell.className = WORKSPACE_PAPER_DOM.paperShellClass;
    shell.dataset.wf = WORKSPACE_PAPER_DOM.paperShellDataWf;
    shell.getBoundingClientRect = vi.fn(() => domRect(shellRect));
    const content = document.createElement("div");
    content.className = WORKSPACE_PAPER_DOM.documentContentClass;
    const starterPreview = document.createElement("div");
    starterPreview.className = `starter-preview ${WORKSPACE_PAPER_DOM.documentClass}`;
    starterPreview.getBoundingClientRect = vi.fn(() => domRect(previewRect));
    content.appendChild(starterPreview);
    right.append(shell, content);
    body.append(left, right);
    view.appendChild(body);
    document.body.appendChild(view);

    expect(measureWorkspacePaperRect()).toEqual(shellRect);

    const documentPaper = document.createElement("article");
    documentPaper.className = WORKSPACE_PAPER_DOM.documentClass;
    documentPaper.dataset.wf = WORKSPACE_PAPER_DOM.documentDataWf;
    documentPaper.getBoundingClientRect = vi.fn(() => domRect(documentRect));
    const paperSurface = document.createElement("div");
    paperSurface.className = WORKSPACE_PAPER_DOM.paperSurfaceClass;
    paperSurface.dataset.wf = WORKSPACE_PAPER_DOM.paperSurfaceDataWf;
    paperSurface.appendChild(documentPaper);
    content.appendChild(paperSurface);

    expect(measureWorkspacePaperRect()).toEqual(documentRect);
    expect(askUserPreview.getBoundingClientRect).not.toHaveBeenCalled();
    expect(starterPreview.getBoundingClientRect).not.toHaveBeenCalled();
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
    workspace.id = WORKSPACE_PAPER_DOM.viewId;
    const paperColumn = document.createElement("main");
    paperColumn.className = WORKSPACE_PAPER_DOM.paperColumnClass;
    const documentContent = document.createElement("div");
    documentContent.className = WORKSPACE_PAPER_DOM.documentContentClass;
    const paperSurface = document.createElement("div");
    paperSurface.className = WORKSPACE_PAPER_DOM.paperSurfaceClass;
    paperSurface.dataset.wf = WORKSPACE_PAPER_DOM.paperSurfaceDataWf;
    const paper = document.createElement("div");
    paper.className = WORKSPACE_PAPER_DOM.documentClass;
    paper.dataset.wf = WORKSPACE_PAPER_DOM.documentDataWf;
    paper.getBoundingClientRect = () =>
      domRect(resized ? workspaceFirstFrame : beforeResize);
    paperSurface.appendChild(paper);
    documentContent.appendChild(paperSurface);
    paperColumn.appendChild(documentContent);
    workspace.appendChild(paperColumn);
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
    expect(appCss).not.toContain("ws-paper-geometry-probe");
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
    expect(
      qingjianSource.match(
        /\.then\(\(resolvedLanding\) =>\s*\{\s*landing = resolvedLanding;\s*\}\)/g,
      ),
    ).toHaveLength(2);
  });
});

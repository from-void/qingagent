export interface WorkspacePaperRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 首页转场探针与工作区纸列共用的唯一几何常量源。
 *
 * 注意：纸壳的最终 width/left 不能仅靠这些数值闭式推算，因为
 * `scrollbar-gutter: stable both-edges` 的实际槽宽由浏览器决定。
 * 运行时应优先调用 measureWorkspacePaperRect() 读取同构 DOM 探针。
 */
export const WORKSPACE_PAPER_GEOMETRY = Object.freeze({
  bodyPaddingInline: 40,
  chatColumnWidth: 400,
  columnGap: 48,
  paperColumnWidth: 800,
  paperTopOffset: 52,
  paperRadius: 0,
});

export const WORKSPACE_PAPER_CSS_VARIABLES = Object.freeze({
  "--ws-paper-body-padding-inline": `${WORKSPACE_PAPER_GEOMETRY.bodyPaddingInline}px`,
  "--ws-paper-chat-column-width": `${WORKSPACE_PAPER_GEOMETRY.chatColumnWidth}px`,
  "--ws-paper-column-gap": `${WORKSPACE_PAPER_GEOMETRY.columnGap}px`,
  "--ws-paper-column-width": `${WORKSPACE_PAPER_GEOMETRY.paperColumnWidth}px`,
  "--ws-paper-top-offset": `${WORKSPACE_PAPER_GEOMETRY.paperTopOffset}px`,
  "--ws-paper-radius": `${WORKSPACE_PAPER_GEOMETRY.paperRadius}px`,
});

function rectFromElement(element: Element | null): WorkspacePaperRect | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return null;
  }
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * 实测工作区纸壳的首帧矩形。
 *
 * 已在工作区时直接读真实 `.ws-paper-shell`；首页转场时挂一个不可见、与工作区
 * 使用同一 CSS 变量和 scrollbar-gutter 规则的 DOM 探针，让浏览器亲自计算滚动槽。
 * 探针只参与布局，不参与绘制，也没有 transition/animation。
 */
export function measureWorkspacePaperRect(): WorkspacePaperRect | null {
  if (typeof document === "undefined") return null;

  const mountedPaper = document.querySelector(
    '#view-workspace [data-wf="WorkspacePaperShell"]',
  );
  const mountedRect = rectFromElement(mountedPaper);
  if (mountedRect) return mountedRect;

  const probe = document.createElement("div");
  probe.className = "ws-paper-geometry-probe";
  probe.setAttribute("aria-hidden", "true");
  for (const [property, value] of Object.entries(
    WORKSPACE_PAPER_CSS_VARIABLES,
  )) {
    probe.style.setProperty(property, value);
  }
  probe.innerHTML =
    '<div class="ws-paper-geometry-probe__body">' +
    '<div class="ws-paper-geometry-probe__chat"></div>' +
    '<div class="ws-paper-geometry-probe__column">' +
    '<div class="ws-paper-geometry-probe__paper"></div>' +
    "</div></div>";

  document.body.appendChild(probe);
  try {
    return rectFromElement(
      probe.querySelector(".ws-paper-geometry-probe__paper"),
    );
  } finally {
    probe.remove();
  }
}

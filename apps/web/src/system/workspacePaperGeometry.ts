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

/**
 * 工作区真 DOM 与转场测量探针共用的骨架标识。
 * 生产组件和探针都只能从这里取 id/class/data-wf，避免出现“长得像工作区”的第二套类名。
 */
export const WORKSPACE_PAPER_DOM = Object.freeze({
  viewId: "view-workspace",
  viewDataWf: "WorkspacePage",
  bodyClass: "ws-body",
  chatColumnClass: "ws-left",
  paperColumnClass: "ws-right",
  paperShellClass: "ws-paper-shell",
  paperShellDataWf: "WorkspacePaperShell",
  documentContentClass: "ws-document-content",
  paperSurfaceClass: "ws-paper-surface",
  paperSurfaceDataWf: "WorkspacePaperSurface",
  documentClass: "wf-doc",
  documentDataWf: "DocumentSnapshotView",
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

function findMountedPaper(view: HTMLElement): Element | null {
  const paperColumn = view.querySelector(
    `.${WORKSPACE_PAPER_DOM.paperColumnClass}`,
  );
  if (!paperColumn) return null;

  // 问卷和空文档模板预览都会复用 `.wf-doc` 排版类，测量必须落在真实纸面组件。
  // hydration 首帧正文尚未挂出时，再以同一右栏的纸壳接住交接。
  return (
    paperColumn.querySelector(
      `.${WORKSPACE_PAPER_DOM.documentContentClass} .${WORKSPACE_PAPER_DOM.paperSurfaceClass}[data-wf="${WORKSPACE_PAPER_DOM.paperSurfaceDataWf}"] .${WORKSPACE_PAPER_DOM.documentClass}[data-wf="${WORKSPACE_PAPER_DOM.documentDataWf}"]`,
    ) ??
    paperColumn.querySelector(
      `[data-wf="${WORKSPACE_PAPER_DOM.paperShellDataWf}"]`,
    )
  );
}

function createWorkspacePaperMeasurementView(): {
  view: HTMLElement;
  paper: HTMLElement;
} {
  const view = document.createElement("section");
  view.id = WORKSPACE_PAPER_DOM.viewId;
  view.dataset.view = "workspace";
  view.dataset.wf = WORKSPACE_PAPER_DOM.viewDataWf;
  view.dataset.content = "editing";
  view.dataset.tool = "none";
  view.setAttribute("aria-hidden", "true");
  Object.assign(view.style, {
    // 与 WorkspacePage 根节点的首帧布局相同；fixed/inset/visibility 只负责把探针
    // 放进视口且不绘制，不另写任何纸列几何。
    position: "fixed",
    inset: "0",
    zIndex: "-2147483647",
    visibility: "hidden",
    pointerEvents: "none",
    flex: "1",
    display: "flex",
    flexDirection: "column",
    minHeight: "0",
    overflow: "hidden",
  });
  for (const [property, value] of Object.entries(
    WORKSPACE_PAPER_CSS_VARIABLES,
  )) {
    view.style.setProperty(property, value);
  }

  const body = document.createElement("div");
  body.className = WORKSPACE_PAPER_DOM.bodyClass;
  body.dataset.hydration = "waiting";

  const chatColumn = document.createElement("div");
  chatColumn.className = WORKSPACE_PAPER_DOM.chatColumnClass;

  const paperColumn = document.createElement("div");
  paperColumn.className = WORKSPACE_PAPER_DOM.paperColumnClass;

  const shell = document.createElement("div");
  shell.className = WORKSPACE_PAPER_DOM.paperShellClass;
  shell.dataset.wf = WORKSPACE_PAPER_DOM.paperShellDataWf;
  shell.setAttribute("aria-hidden", "true");

  const documentContent = document.createElement("div");
  documentContent.className = WORKSPACE_PAPER_DOM.documentContentClass;
  documentContent.dataset.wf = "WorkspaceHydrationDocumentContent";

  const paperSurface = document.createElement("div");
  paperSurface.className = WORKSPACE_PAPER_DOM.paperSurfaceClass;
  paperSurface.dataset.wf = WORKSPACE_PAPER_DOM.paperSurfaceDataWf;

  const paper = document.createElement("article");
  paper.className = WORKSPACE_PAPER_DOM.documentClass;
  paper.dataset.wf = WORKSPACE_PAPER_DOM.documentDataWf;
  paper.setAttribute("aria-hidden", "true");

  paperSurface.appendChild(paper);
  documentContent.appendChild(paperSurface);
  paperColumn.append(shell, documentContent);
  body.append(chatColumn, paperColumn);
  view.appendChild(body);
  return { view, paper };
}

/**
 * 实测工作区纸壳的首帧矩形。
 *
 * 已在工作区时优先读真实 `.wf-doc`，尚未挂正文时读 `.ws-paper-shell`。
 * 首页转场时挂一个不可见的真实工作区骨架：同一个 `#view-workspace`、`.ws-body`、
 * `.ws-left`、`.ws-right`、`.ws-paper-shell`、`.wf-doc`，让生产样式表原样命中。
 * 探针只参与布局，不参与绘制，也不创建任何仿制 CSS。
 */
export function measureWorkspacePaperRect(): WorkspacePaperRect | null {
  if (typeof document === "undefined") return null;

  const mountedView = document.getElementById(WORKSPACE_PAPER_DOM.viewId);
  if (mountedView) {
    // 绝不在已有真工作区时创建第二个同 id 探针。
    return rectFromElement(findMountedPaper(mountedView));
  }

  const { view, paper } = createWorkspacePaperMeasurementView();
  document.body.appendChild(view);
  try {
    return rectFromElement(paper);
  } finally {
    view.remove();
  }
}

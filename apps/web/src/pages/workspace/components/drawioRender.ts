import {
  hardenInlineSvg,
  prepareDrawioModelXmlForRender,
} from "@qingagent/pm-schema";

const SVG_NS = "http://www.w3.org/2000/svg";
const DRAWIO_RENDER_PADDING = 8;

/**
 * 离线把未压缩 mxGraph XML 渲染成原生 SVG。maxGraph 仅在出现 drawio 块时动态加载，
 * 不进入首屏 chunk；foEnabled=false 禁止 foreignObject，最终结果仍必须过统一 SVG 加固。
 */
export async function renderDrawio(rawSource: string): Promise<string> {
  if (typeof document === "undefined") throw new Error("drawio 渲染器需要浏览器 DOM");
  const { modelXml } = prepareDrawioModelXmlForRender(rawSource);
  const {
    Graph,
    ImageExport,
    ModelXmlSerializer,
    SvgCanvas2D,
  } = await import("@maxgraph/core");

  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  Object.assign(container.style, {
    position: "fixed",
    left: "-10000px",
    top: "-10000px",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    visibility: "hidden",
  });
  document.body.appendChild(container);

  const graph = new Graph(container);
  try {
    graph.setEnabled(false);
    graph.setHtmlLabels(false);
    const getLabel = graph.getLabel.bind(graph);
    graph.getLabel = (cell) => {
      const label = getLabel(cell);
      if (!cell || typeof label !== "string") return label;
      const style = graph.getCurrentCellStyle(cell) as Record<string, unknown>;
      // draw.io 的富文本编辑器会把换行保存成 html=1 的 <div>/<br>。本地 SVG
      // 降级禁止 foreignObject，因此必须先转成纯文本再交给 SvgCanvas2D；
      // 直接关闭 HTML label 会把标签字面量画进 <text>。
      return style.html === 1 || style.html === "1"
        ? drawioHtmlLabelToPlainText(label)
        : label;
    };
    // maxGraph 可选支持把未知 edgeStyle/perimeter 字符串当表达式求值；这里显式锁死，
    // XML 中的样式只能命中内置注册表，不能成为代码执行入口。
    graph.getView().setAllowEval(false);
    new ModelXmlSerializer(graph.getDataModel()).import(modelXml);
    graph.getView().revalidate();

    const bounds = graph.getGraphBounds();
    if (
      !Number.isFinite(bounds.x) ||
      !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height) ||
      bounds.width <= 0 ||
      bounds.height <= 0
    ) {
      throw new Error("drawio 图没有可渲染内容");
    }

    const width = Math.max(1, Math.ceil(bounds.width + DRAWIO_RENDER_PADDING * 2));
    const height = Math.max(1, Math.ceil(bounds.height + DRAWIO_RENDER_PADDING * 2));
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("version", "1.1");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "drawio 图表");

    const canvas = new SvgCanvas2D(svg, false);
    // draw.io 的 html=1 标签也只能降级为原生 <text>/<tspan>，不允许 HTML 执行面。
    canvas.foEnabled = false;
    canvas.translate(DRAWIO_RENDER_PADDING - bounds.x, DRAWIO_RENDER_PADDING - bounds.y);
    const root = graph.getDataModel().getRoot();
    const rootState = root ? graph.getView().getState(root) : null;
    if (!rootState) throw new Error("drawio 图状态初始化失败");
    new ImageExport().drawState(rootState, canvas);
    canvas.end();

    const rawSvg = new XMLSerializer().serializeToString(svg);
    // 不放宽既有 200KB inline SVG 上限；超限按渲染失败态降级源码。
    const safeSvg = hardenInlineSvg(rawSvg);
    if (!safeSvg) throw new Error("drawio SVG 安全校验失败");
    return safeSvg;
  } finally {
    graph.destroy();
    container.remove();
  }
}

const HTML_LABEL_BLOCKS = new Set([
  "ADDRESS",
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "OL",
  "P",
  "PRE",
  "TABLE",
  "TR",
  "UL",
]);
const HTML_LABEL_IGNORED = new Set([
  "EMBED",
  "IFRAME",
  "IMG",
  "MATH",
  "NOSCRIPT",
  "OBJECT",
  "SCRIPT",
  "STYLE",
  "SVG",
  "TEMPLATE",
]);

/**
 * 在 DOMParser 的惰性 HTML 文档里提取 draw.io label 文本，不把任意 HTML 挂进
 * 页面，也不触发脚本/图片加载。块元素与 br 只贡献换行，尾部编辑占位
 * `<div><br></div>` 会自然归一为空白并被裁掉。
 */
export function drawioHtmlLabelToPlainText(raw: string): string {
  const document = new DOMParser().parseFromString(raw, "text/html");
  const chunks: string[] = [];
  const lineBreak = () => {
    if (chunks.length > 0 && chunks[chunks.length - 1] !== "\n") chunks.push("\n");
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
      if (node.nodeValue) chunks.push(node.nodeValue);
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toUpperCase();
    if (HTML_LABEL_IGNORED.has(tag)) return;
    if (tag === "BR") {
      lineBreak();
      return;
    }
    const block = HTML_LABEL_BLOCKS.has(tag);
    if (block) lineBreak();
    for (const child of Array.from(node.childNodes)) visit(child);
    if (block) lineBreak();
  };
  for (const child of Array.from(document.body.childNodes)) visit(child);
  return chunks
    .join("")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

import mermaid from "mermaid";
import { normalizeMermaidQuotes } from "@qingagent/pm-schema";

export { normalizeMermaidQuotes };

// mermaid 客户端渲染:被可编辑节点视图(DiagramView)与只读/审阅态预览(MermaidPreview)共用,
// 保证编辑态和审阅态渲染口径一致(securityLevel:strict 消毒,source 可能来自模型/用户)。

/**
 * 默认主题:暖墨纸面(配 qingagent 奶白纸 + 赭石/古铜金一套),取代 mermaid 默认的黑白灰。
 * 作为 mermaid.initialize 的【全局默认】——只有当图表源码里没有自己声明主题
 * (没有 `%%{init: {...}}%%` 指令)时才用这套;源码若自带主题指令仍会覆盖它。
 * 不往源码里写任何东西,保持源码干净。
 */
const WARM_THEME_VARS = {
  background: "#faf6ec",
  textColor: "#2f2a22",
  // 主/次/三级节点
  primaryColor: "#efe3cc",
  primaryTextColor: "#2f2a22",
  primaryBorderColor: "#b08a3e",
  secondaryColor: "#e3d3b0",
  secondaryTextColor: "#2f2a22",
  secondaryBorderColor: "#b3a07a",
  tertiaryColor: "#f5ecda",
  tertiaryTextColor: "#2f2a22",
  tertiaryBorderColor: "#cdbfa3",
  // 连线 / flowchart
  lineColor: "#9c8552",
  mainBkg: "#efe3cc",
  nodeBorder: "#b08a3e",
  clusterBkg: "#f3ecdd",
  clusterBorder: "#cdbfa3",
  titleColor: "#5c5346",
  edgeLabelBackground: "#faf6ec",
  // note
  noteBkgColor: "#fbf3e2",
  noteBorderColor: "#cdbfa3",
  noteTextColor: "#2f2a22",
  // sequence
  actorBkg: "#efe3cc",
  actorBorder: "#b08a3e",
  actorTextColor: "#2f2a22",
  signalColor: "#7a6a48",
  signalTextColor: "#2f2a22",
  // mindmap / pie 等多档配色:暖色系渐变(取代灰阶)
  cScale0: "#efe3cc",
  cScale1: "#dcc39a",
  cScale2: "#c9a86f",
  cScale3: "#e8d5b0",
  cScale4: "#d4b886",
  cScale5: "#bfa471",
  cScaleLabel0: "#2f2a22",
  cScaleLabel1: "#2f2a22",
  cScaleLabel2: "#2f2a22",
  cScaleLabel3: "#2f2a22",
  cScaleLabel4: "#2f2a22",
  cScaleLabel5: "#2f2a22",
} as const;

let mermaidReady = false;
function ensureMermaid(): void {
  if (mermaidReady) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    // 缓存 SVG 会经过安全净化；必须用原生 text/tspan，避免 foreignObject 被剥离后只剩图形。
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    class: { htmlLabels: false },
    theme: "base",
    themeVariables: WARM_THEME_VARS,
    fontFamily: "var(--font-sans, sans-serif)",
  });
  mermaidReady = true;
}

let renderSeq = 0;

function mermaidErrorLine(error: string): number | null {
  const english = error.match(/\bline\s+(\d+)\b/i);
  const chinese = error.match(/第\s*(\d+)\s*行/);
  const value = Number(english?.[1] ?? chinese?.[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** 把解析器错误收敛成不重复、不泄漏内部细节的用户文案。 */
export function diagramErrorMessage(
  lang: string,
  error: string,
  editable = false,
): string {
  const title = lang === "drawio" ? "draw.io 图表无法解析" : "Mermaid 语法错误";
  const line = lang === "mermaid" ? mermaidErrorLine(error) : null;
  return `${title}${line ? `（第 ${line} 行）` : ""}${editable ? "。双击进入编辑器修正" : ""}`;
}

/** 清掉 mermaid 渲染失败时遗留在 document.body 的临时/错误元素。 */
function cleanupMermaidArtifacts(id: string): void {
  if (typeof document === "undefined") return;
  document.getElementById(id)?.remove();
  document.getElementById(`d${id}`)?.remove();
}

/**
 * 客户端渲染 mermaid 源码 → svg;失败抛错。
 * 关键:渲染失败时 mermaid 会把「Syntax error」错误图(炸弹)注入 document.body 且不清理,
 * 全宽挂在页面底部把布局顶变形。这里两道处理:① 先 parse 校验,非法早抛、根本不走 render
 * (因此不会注入炸弹);② render 后 finally 主动清理任何遗留临时元素。
 */
export async function renderMermaid(rawSource: string): Promise<string> {
  ensureMermaid();
  // 先用原文校验语法(parse 不渲染到 DOM,不注入错误图);非法直接抛干净错误。
  // 测试里的 mermaid mock 没有 parse,用 typeof 兜底跳过。
  let source = rawSource;
  if (typeof mermaid.parse === "function") {
    let valid = (await mermaid.parse(rawSource, { suppressErrors: true })) !== false;
    if (!valid) {
      // 原文解析失败:可能模型把弯/全角引号当结构定界符。规范化引号后重试一次。
      // 注意:只对 parse 失败的源做此兜底——合法源(含标签正文里的弯引号/书名号«»)原文就能 parse,
      // 根本不会走到这里,故不会被误伤（代码评审指出的全局替换误伤合法源问题）。
      const normalized = normalizeMermaidQuotes(rawSource);
      if (
        normalized !== rawSource &&
        (await mermaid.parse(normalized, { suppressErrors: true }))
      ) {
        source = normalized;
        valid = true;
      }
    }
    if (!valid) {
      // suppressErrors 只返回 false，不带定位；再做一次不抑制的 parse，保留“line N”供 UI
      // 转成安全的中文行号。parse 不渲染 DOM，不会产生 Mermaid 错误图残留。
      try {
        await mermaid.parse(rawSource);
      } catch (cause) {
        throw new Error(cause instanceof Error ? cause.message : String(cause));
      }
      throw new Error("Mermaid 语法错误");
    }
  }
  renderSeq += 1;
  const id = `wmd-${Date.now()}-${renderSeq}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return svg;
  } finally {
    cleanupMermaidArtifacts(id);
  }
}

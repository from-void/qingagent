import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { upgradeMermaidCodeBlocksToDiagram } from "@qingagent/pm-schema";
import type { PmBlockNode, PmDoc } from "@qingagent/pm-schema";
import type { ViewBlock } from "../../data/protocol";
import { PmBlockView } from "./PmStaticView";
import { ReviewBlockView } from "./reviewBlockDiff";

// 审阅态块级补丁的渲染:与基座正文完全相同的 PmBlockView(React),让图表(DiagramRenderer)、
// 公式(KaTeX)、callout/columnList/taskList 等运行时节点所见即所得,而不是 raw innerHTML 退化。
// - pmNodes(hunk.after 原始 PM node)存在时:一律用原始 node,保全所有格式(对齐/marks/嵌套/合并单元格/代码高亮/inlineMath)。
// - 否则从 ViewBlock 渲染(ReviewBlockView):列表/表格/callout/columnList 消费 granular diff,其余回退 PmBlockView。
// 返回 Root 供 widget 卸载时 unmount(避免 React 树泄漏)。
export function mountBlockPatchView(
  container: HTMLElement,
  blocks: readonly ViewBlock[],
  pmNodes?: readonly PmBlockNode[],
  beforePmNodes?: readonly PmBlockNode[],
  patchIndex?: number,
  suppressLocalPopup = false,
): Root {
  const root = createRoot(container);
  if (pmNodes && pmNodes.length > 0) {
    // upgrade:legacySectionsToPm 会把 mermaid 当代码块,需升级回 diagram 节点。
    const pmDoc = upgradeMermaidCodeBlocksToDiagram({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: pmNodes as PmBlockNode[],
    } as PmDoc);
    root.render(
      createElement(
        "div",
        { className: "pm-static-view" },
        pmDoc.content.map((node: PmBlockNode, i: number) => createElement(PmBlockView, { node, key: i })),
      ),
    );
    return root;
  }
  // beforePmNodes(hunk.before):供 granular diff 的 changed 行/格/块 hover 渲对应旧节点,
  // 而不是拍平文本或弹整块原文。单块 granular replace 下 [0] 即 before 容器。
  const beforeNode = beforePmNodes && beforePmNodes.length > 0 ? beforePmNodes[0] : undefined;
  root.render(
    createElement(
      "div",
      { className: "pm-static-view" },
      blocks.map((block, i) => createElement(ReviewBlockView, {
        block,
        key: i,
        beforeNode,
        patchIndex,
        suppressLocalPopup,
      })),
    ),
  );
  return root;
}

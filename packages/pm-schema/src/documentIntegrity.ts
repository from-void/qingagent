import type { PmDoc, PmNode } from "./types";

export interface DocumentShape {
  topLevelNodeCount: number;
  nodeCount: number;
  textLength: number;
  contentWeight: number;
}

type PmTreeNode = PmDoc | PmNode;

/**
 * 文档完整性门只需要稳定、便宜的结构量级，不使用 JSON 字节数，避免图片 URL / SVG attrs
 * 把体积虚高。每个节点给固定结构权重，文本按 Unicode 码点计入。
 */
export function measureDocumentShape(doc: PmDoc): DocumentShape {
  let nodeCount = 0;
  let textLength = 0;

  const visit = (node: PmTreeNode) => {
    if (node.type !== "doc") nodeCount += 1;
    if (node.type === "text") {
      textLength += Array.from(node.text).length;
    }
    if ("content" in node && Array.isArray(node.content)) {
      for (const child of node.content) visit(child as PmTreeNode);
    }
  };

  visit(doc);
  return {
    topLevelNodeCount: doc.content.length,
    nodeCount,
    textLength,
    contentWeight: textLength + nodeCount * 2,
  };
}

/**
 * 高危坍缩的组合信号：
 * 1. 上一有效态有多个顶层块；
 * 2. 一次更新后只剩至多一个节点；
 * 3. 原文有足够内容/结构量，且新文档不足原文三分之一。
 *
 * 三项同时满足才熔断，避免把正常的单块文档编辑或小幅删减误判为损坏。
 */
export function isAbnormalDocumentCollapse(
  previous: PmDoc | null | undefined,
  next: PmDoc,
): boolean {
  if (!previous || previous.content.length < 2 || next.content.length > 1) {
    return false;
  }

  const previousShape = measureDocumentShape(previous);
  const nextShape = measureDocumentShape(next);
  return (
    previousShape.contentWeight >= 24 &&
    nextShape.contentWeight * 3 <= previousShape.contentWeight
  );
}

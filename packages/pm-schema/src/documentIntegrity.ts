import type { PmDoc, PmNode } from "./types";

export interface DocumentShape {
  topLevelNodeCount: number;
  nodeCount: number;
  textLength: number;
  mediaCount: number;
  keyAttributeCount: number;
  contentWeight: number;
}

type PmTreeNode = PmDoc | PmNode;

const CONTENT_UNIT_WEIGHT = 12;
// 旧阈值 24 含容器节点权重；改按语义内容计量后，一个内容单位已足以保护短文档。
const MIN_MEANINGFUL_CONTENT_WEIGHT = CONTENT_UNIT_WEIGHT;

/**
 * 文档完整性门只计算用户内容，不把 paragraph/list/table 等容器节点计入权重，
 * 避免合法合并或重构仅因节点数减少而被误判。媒体与承载正文的关键属性使用固定权重，
 * 不按 URL、源码或 SVG 的字节数计量，避免超长属性把体积虚高。
 */
export function measureDocumentShape(doc: PmDoc): DocumentShape {
  let nodeCount = 0;
  let textLength = 0;
  let mediaCount = 0;
  let keyAttributeCount = 0;

  const visit = (node: PmTreeNode) => {
    if (node.type !== "doc") nodeCount += 1;
    if (node.type === "text") {
      textLength += Array.from(node.text).length;
    }
    if (node.type === "image" || node.type === "diagram" || node.type === "fileAttachment") {
      mediaCount += 1;
    }
    if (
      (node.type === "image" && node.attrs.src.length > 0) ||
      (node.type === "diagram" && node.attrs.source.length > 0) ||
      (node.type === "fileAttachment" && node.attrs.fileId.length > 0) ||
      (node.type === "blockMath" && node.attrs.latex.length > 0)
    ) {
      keyAttributeCount += 1;
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
    mediaCount,
    keyAttributeCount,
    contentWeight:
      textLength +
      mediaCount * CONTENT_UNIT_WEIGHT +
      keyAttributeCount * CONTENT_UNIT_WEIGHT,
  };
}

/**
 * 高危坍缩的组合信号：
 * 1. 上一有效态有多个顶层块；
 * 2. 一次更新后只剩至多一个节点；
 * 3. 原文有足够文本/媒体/关键属性，且新文档不足原文三分之一。
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
    previousShape.contentWeight >= MIN_MEANINGFUL_CONTENT_WEIGHT &&
    nextShape.contentWeight * 3 <= previousShape.contentWeight
  );
}

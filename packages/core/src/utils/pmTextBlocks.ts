import type {
  PmBlockNode,
  PmDoc,
  PmInlineNode,
  PmNode,
} from "@qingagent/pm-schema";

export interface TextBlockRef {
  blockId: string;
  topBlockId: string;
  nodeBlockId: string;
  ancestorBlockIds: string[];
  path: number[];
  topIndex: number;
  textStart: number;
  textEnd: number;
  text: string;
  node: PmBlockNode;
}

function nodeSize(node: PmNode | PmDoc): number {
  if (node.type === "doc") {
    return node.content.reduce((sum, child) => sum + nodeSize(child), 0);
  }
  if (node.type === "text") return node.text.length;
  if (node.type === "hardBreak") return 1;
  if (!("content" in node) || !Array.isArray(node.content)) return 1;
  return 2 + node.content.reduce((sum, child) => sum + nodeSize(child as PmNode), 0);
}

// inlineMath 是原子行内节点(PM nodeSize=1):文本投影用 U+FFFC 占位,保证 offset 与 PM 位置一致。
const INLINE_ATOM_PLACEHOLDER = "￼";

export function inlineNodeLen(node: PmInlineNode): number {
  return node.type === "text" ? node.text.length : 1;
}

function inlineText(content: readonly PmInlineNode[] | undefined): string {
  return (content ?? [])
    .map((node) => {
      if (node.type === "hardBreak") return "\n";
      if (node.type === "inlineMath") return INLINE_ATOM_PLACEHOLDER;
      return node.text;
    })
    .join("");
}

export function isInlineTextBlock(
  node: PmNode,
): node is PmBlockNode & { content?: PmInlineNode[] } {
  return (
    node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "codeBlock" ||
    node.type === "penNote"
  );
}

function getNodeBlockId(node: PmNode): string | undefined {
  if (!("attrs" in node)) return undefined;
  const blockId = (node.attrs as Record<string, unknown> | undefined)?.blockId;
  return typeof blockId === "string" && blockId ? blockId : undefined;
}

export function collectTopLevelTextBlocks(doc: PmDoc, withinRef?: string): TextBlockRef[] {
  const out: TextBlockRef[] = [];

  function visit(
    node: PmNode,
    path: number[],
    pos: number,
    topIndex: number,
    topBlockId: string,
    ancestorBlockIds: string[],
  ): void {
    const nodeBlockId = getNodeBlockId(node) ?? topBlockId;
    if (isInlineTextBlock(node)) {
      const text = inlineText(node.content);
      const withinMatches =
        !withinRef ||
        nodeBlockId === withinRef ||
        ancestorBlockIds.includes(withinRef) ||
        topBlockId === withinRef;
      if (withinMatches) {
        out.push({
          blockId: nodeBlockId,
          topBlockId,
          nodeBlockId,
          ancestorBlockIds,
          path,
          topIndex,
          textStart: pos + 1,
          textEnd: pos + 1 + text.length,
          text,
          node,
        });
      }
    }

    if (!("content" in node) || !Array.isArray(node.content)) return;
    const childAncestorBlockIds = nodeBlockId
      ? [...ancestorBlockIds, nodeBlockId]
      : ancestorBlockIds;
    let childPos = pos + 1;
    node.content.forEach((child, index) => {
      if (typeof child !== "object" || child === null) return;
      visit(
        child as PmNode,
        [...path, index],
        childPos,
        topIndex,
        topBlockId,
        childAncestorBlockIds,
      );
      childPos += nodeSize(child as PmNode);
    });
  }

  let pos = 0;
  doc.content.forEach((child, index) => {
    visit(child, [index], pos, index, child.attrs.blockId, []);
    pos += nodeSize(child);
  });
  return out;
}

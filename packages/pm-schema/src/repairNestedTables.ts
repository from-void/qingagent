import { getDeterministicId } from "./hash";
import type { PmDoc } from "./types";

type JsonNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  [key: string]: unknown;
};

/** 旧文档兼容：把 cell 内存量嵌套表降级成 TSV 段落，保留全部可见文本。 */
export function flattenNestedTablesInCells(doc: PmDoc): PmDoc {
  const visit = (node: JsonNode, path: number[], insideCell: boolean): JsonNode | JsonNode[] => {
    if (insideCell && node.type === "table") return nestedTableParagraphs(node, path);
    const nextInsideCell = insideCell || node.type === "tableCell" || node.type === "tableHeader";
    if (!Array.isArray(node.content)) return node;
    const content = node.content.flatMap((child, index) => {
      const visited = visit(child, [...path, index], nextInsideCell);
      return Array.isArray(visited) ? visited : [visited];
    });
    return content.every((child, index) => child === node.content?.[index])
      ? node
      : { ...node, content };
  };

  return visit(doc as unknown as JsonNode, [], false) as PmDoc;
}

function nestedTableParagraphs(table: JsonNode, path: number[]): JsonNode[] {
  const rows = (table.content ?? []).map((row) =>
    (row.content ?? []).map((cell) => visibleText(cell)).join("\t"),
  );
  return (rows.length > 0 ? rows : [""]).map((text, rowIndex) => ({
    type: "paragraph",
    attrs: {
      blockId: getDeterministicId("nested-table-row", { path, rowIndex, text }),
    },
    ...(text ? { content: [{ type: "text", text }] } : {}),
  }));
}

function visibleText(node: JsonNode): string {
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(visibleText).join("");
}

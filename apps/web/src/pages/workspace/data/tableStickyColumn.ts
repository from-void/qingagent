import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { TableMap } from "@tiptap/pm/tables";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export function tableLogicalColumnOffsets(table: ProseMirrorNode): Map<number, number> {
  if (table.type.spec.tableRole !== "table" || table.childCount === 0) return new Map();
  let map: TableMap;
  try {
    map = TableMap.get(table);
  } catch {
    return new Map();
  }
  if (map.width < 1 || map.height < 1) return new Map();

  const columns = new Map<number, number>();
  map.map.forEach((offset, index) => {
    if (!columns.has(offset)) columns.set(offset, index % map.width);
  });
  return columns;
}

export function stickyHeaderColumnOffsets(table: ProseMirrorNode): number[] {
  const logicalColumns = tableLogicalColumnOffsets(table);
  if (logicalColumns.size === 0) return [];

  const firstColumnOffsets = [...logicalColumns]
    .filter(([, column]) => column === 0)
    .map(([offset]) => offset);
  const isHeaderColumn = firstColumnOffsets.every((offset) => table.nodeAt(offset)?.type.name === "tableHeader");
  return isHeaderColumn ? firstColumnOffsets : [];
}

/** 按 TableMap 的逻辑第 0 列标记 sticky cell，rowspan 覆盖行复用跨行格本体。 */
export const TableStickyColumnExtension = Extension.create({
  name: "qingagentTableStickyColumn",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.spec.tableRole !== "table") return true;
              const stickyOffsets = new Set(stickyHeaderColumnOffsets(node));
              for (const [offset, logicalColumn] of tableLogicalColumnOffsets(node)) {
                const cell = node.nodeAt(offset);
                if (cell) {
                  const cellPos = pos + 1 + offset;
                  decorations.push(Decoration.node(cellPos, cellPos + cell.nodeSize, {
                    "data-table-logical-col": String(logicalColumn),
                    ...(stickyOffsets.has(offset) ? { "data-sticky-col": "" } : {}),
                  }));
                }
              }
              return false;
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

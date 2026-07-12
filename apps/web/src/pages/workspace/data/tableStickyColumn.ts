import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { TableMap } from "@tiptap/pm/tables";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export function stickyHeaderColumnOffsets(table: ProseMirrorNode): number[] {
  if (table.type.spec.tableRole !== "table" || table.childCount === 0) return [];
  let map: TableMap;
  try {
    map = TableMap.get(table);
  } catch {
    return [];
  }
  if (map.width < 1 || map.height < 1) return [];

  const offsets = Array.from({ length: map.height }, (_, row) => map.map[row * map.width]!);
  const uniqueOffsets = [...new Set(offsets)];
  const isHeaderColumn = uniqueOffsets.every((offset) => table.nodeAt(offset)?.type.name === "tableHeader");
  return isHeaderColumn ? uniqueOffsets : [];
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
              for (const offset of stickyHeaderColumnOffsets(node)) {
                const cell = node.nodeAt(offset);
                if (cell) {
                  const cellPos = pos + 1 + offset;
                  decorations.push(Decoration.node(cellPos, cellPos + cell.nodeSize, { "data-sticky-col": "" }));
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

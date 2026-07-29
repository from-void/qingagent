import type { PmDoc } from "@qingagent/pm-schema";

export interface ExportFootnote {
  id: string;
  note: string;
  number: number;
}

export interface ExportFootnoteRegistry {
  definitions: ExportFootnote[];
  numberById: ReadonlyMap<string, number>;
}

/** 深度优先遍历完整 PM 树，按引用首见顺序分配展示编号。 */
export function collectExportFootnotes(doc: PmDoc): ExportFootnoteRegistry {
  const definitions: ExportFootnote[] = [];
  const numberById = new Map<string, number>();
  const notesById = new Map<string, string>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as { type?: unknown; attrs?: unknown; content?: unknown };
    if (node.type === "footnoteReference" && node.attrs && typeof node.attrs === "object") {
      const attrs = node.attrs as { id?: unknown; note?: unknown };
      if (typeof attrs.id === "string" && typeof attrs.note === "string") {
        const previous = notesById.get(attrs.id);
        if (previous !== undefined && previous !== attrs.note) {
          throw new Error(`脚注 ${attrs.id} 对应了不同正文`);
        }
        if (previous === undefined) {
          const number = definitions.length + 1;
          notesById.set(attrs.id, attrs.note);
          numberById.set(attrs.id, number);
          definitions.push({ id: attrs.id, note: attrs.note, number });
        }
      }
    }
    if (Array.isArray(node.content)) node.content.forEach(visit);
  };

  visit(doc);
  return { definitions, numberById };
}

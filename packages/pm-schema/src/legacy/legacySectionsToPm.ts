import { getDeterministicId } from "../hash";
import { PM_SCHEMA_VERSION } from "../schemaVersion";
import { normalizePmDoc } from "../validators";
import { detectMermaidSource } from "../ai-ir/aiIrToPm";
import type {
  PmBlockNode,
  PmDoc,
  PmInlineNode,
  PmParagraphNode,
  PmTableCellNode,
  PmTableNode,
  PmTableRowNode,
  PmTaskListNode,
} from "../types";

export type LegacyListSection = {
  ordered?: boolean;
  items: LegacyListItem[];
};

export type LegacyListItem =
  | string
  | {
      text: string;
      children?: LegacyListSectionLike[];
    };

export type LegacyTaskItem = {
  text: string;
  checked: boolean;
  children?: Array<LegacyTaskItem | LegacyListSectionLike>;
};

export type LegacyListSectionLike =
  | { kind: "list"; data: LegacyListSection }
  | { kind: "taskList"; data: { items: LegacyTaskItem[] } };

export type LegacyLegacySection =
  | { kind: "h1"; data: { text: string } }
  | { kind: "h2"; data: { text: string; anchor?: string | null } }
  | { kind: "h3" | "h4" | "h5" | "h6"; data: { text: string } }
  | { kind: "p"; data: { text: string } }
  | { kind: "quote"; data: { text: string } }
  | { kind: "hr"; data?: Record<string, never> }
  | { kind: "list"; data: LegacyListSection }
  | { kind: "taskList"; data: { items: LegacyTaskItem[] } }
  | { kind: "table"; data: { head: string[]; rows: string[][] } }
  | { kind: "code"; data: { body: string; language?: string | null } }
  | { kind: "penNote"; data: { text: string } }
  | {
      kind: "image";
      data: {
        src: string;
        alt?: string | null;
	        caption?: string | null;
	        width?: number | null;
	        height?: number | null;
	        align?: "left" | "center" | "right" | null;
	      };
	    }
  | { kind: "diagram"; data: { lang: string; source: string; svg?: string | null } };

export function legacySectionsToPm(sections: readonly LegacyLegacySection[]): PmDoc {
  const content = sections.map((section, index) => sectionToPmBlock(section, index));
  return normalizePmDoc({
    type: "doc",
    attrs: { schemaVersion: PM_SCHEMA_VERSION },
    content,
  });
}

function sectionToPmBlock(section: LegacyLegacySection, index: number): PmBlockNode {
  const blockId = getDeterministicId("block", { index, section });

  switch (section.kind) {
    case "h1":
      return heading(blockId, 1, section.data.text);
    case "h2":
      return heading(blockId, 2, section.data.text, section.data.anchor ?? null);
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return heading(blockId, Number(section.kind.slice(1)) as 3 | 4 | 5 | 6, section.data.text);
    case "p":
      return paragraph(blockId, section.data.text);
    case "quote":
      return {
        type: "blockquote",
        attrs: { blockId },
        content: [paragraph(`${blockId}-p`, section.data.text)],
      };
    case "hr":
      return { type: "horizontalRule", attrs: { blockId } };
    case "list":
      return listBlock(blockId, section.data);
    case "taskList":
      return taskListBlock(blockId, section.data.items);
    case "table":
      return table(blockId, section.data.head, section.data.rows);
    case "code": {
      // 安全网:模型把 mermaid 图写成代码块时,转成 diagram 块(同 aiIrToPm)。
      const mermaidSource = detectMermaidSource(section.data.language, section.data.body);
      if (mermaidSource) {
        return { type: "diagram", attrs: { blockId, lang: "mermaid", source: mermaidSource, svg: null } };
      }
      return {
        type: "codeBlock",
        attrs: { blockId, language: section.data.language ?? "plaintext" },
        content: section.data.body ? [{ type: "text", text: section.data.body }] : [],
      };
    }
    case "penNote":
      return {
        type: "penNote",
        attrs: { blockId },
        content: textContent(section.data.text),
      };
    case "image":
      return {
        type: "image",
        attrs: {
          blockId,
          src: section.data.src,
          alt: section.data.alt ?? null,
	          caption: section.data.caption ?? null,
	          width: section.data.width ?? null,
	          height: section.data.height ?? null,
	          align: section.data.align ?? "center",
	        },
	      };
    case "diagram":
      return {
        type: "diagram",
        attrs: {
          blockId,
          lang: section.data.lang,
          source: section.data.source,
          // 安全:不信任 legacy section(常来自模型生成)里的 svg,一律 null,
          // 只让前端 mermaid 渲染回写可信 svg。防存储型 XSS(同 aiIrToPm)。
          svg: null,
        },
      };
  }
}

function listBlock(blockId: string, data: LegacyListSection): PmBlockNode {
  const content = data.items.map((item, itemIndex) => {
    const itemBlockId = `${blockId}-item-${itemIndex + 1}`;
    const text = typeof item === "string" ? item : item.text;
    const children = typeof item === "string" ? [] : item.children ?? [];
    return {
      type: "listItem" as const,
      attrs: { blockId: itemBlockId },
      content: [
        paragraph(`${itemBlockId}-p`, text),
        ...children.map((child, childIndex) =>
          child.kind === "taskList"
            ? taskListBlock(`${itemBlockId}-task-${childIndex + 1}`, child.data.items)
            : listBlock(`${itemBlockId}-list-${childIndex + 1}`, child.data),
        ),
      ],
    };
  });
  if (data.ordered) {
    return {
      type: "orderedList",
      attrs: { blockId, start: 1 },
      content,
    };
  }
  return {
    type: "bulletList",
    attrs: { blockId },
    content,
  };
}

function taskListBlock(blockId: string, items: LegacyTaskItem[]): PmTaskListNode {
  return {
    type: "taskList",
    attrs: { blockId },
    content: items.map((item, itemIndex) => {
      const itemBlockId = `${blockId}-item-${itemIndex + 1}`;
      return {
        type: "taskItem",
        attrs: { blockId: itemBlockId, checked: item.checked },
        content: [
          paragraph(`${itemBlockId}-p`, item.text),
          ...taskItemChildBlocks(itemBlockId, item.children ?? []),
        ],
      };
    }),
  };
}

function taskItemChildBlocks(
  itemBlockId: string,
  children: ReadonlyArray<LegacyTaskItem | LegacyListSectionLike>,
): PmBlockNode[] {
  const blocks: PmBlockNode[] = [];
  let taskRun: LegacyTaskItem[] = [];
  const flushTasks = () => {
    if (taskRun.length === 0) return;
    const suffix = blocks.length === 0 ? "tasks" : `tasks-${blocks.length + 1}`;
    blocks.push(taskListBlock(`${itemBlockId}-${suffix}`, taskRun));
    taskRun = [];
  };

  children.forEach((child, childIndex) => {
    if (!isLegacyListSectionLike(child)) {
      taskRun.push(child);
      return;
    }
    flushTasks();
    blocks.push(
      child.kind === "taskList"
        ? taskListBlock(`${itemBlockId}-task-${childIndex + 1}`, child.data.items)
        : listBlock(`${itemBlockId}-list-${childIndex + 1}`, child.data),
    );
  });
  flushTasks();
  return blocks;
}

function isLegacyListSectionLike(value: LegacyTaskItem | LegacyListSectionLike): value is LegacyListSectionLike {
  return typeof value === "object" && value !== null && "kind" in value;
}

function heading(
  blockId: string,
  level: 1 | 2 | 3 | 4 | 5 | 6,
  text: string,
  anchor?: string | null,
): PmBlockNode {
  return {
    type: "heading",
    attrs: anchor === undefined ? { blockId, level } : { blockId, level, anchor },
    content: textContent(text),
  };
}

function paragraph(blockId: string, text: string): PmParagraphNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: textContent(text),
  };
}

function textContent(text: string): PmInlineNode[] {
  return text ? [{ type: "text", text }] : [];
}

function table(blockId: string, head: string[], rows: string[][]): PmTableNode {
  const headerRow: PmTableRowNode | null = head.length
    ? {
        type: "tableRow",
        content: head.map((cell, cellIndex) => tableCell("tableHeader", `${blockId}-h-${cellIndex + 1}`, cell)),
      }
    : null;

  const bodyRows: PmTableRowNode[] = rows.map((row, rowIndex) => ({
    type: "tableRow",
    content: row.map((cell, cellIndex) => tableCell("tableCell", `${blockId}-r-${rowIndex + 1}-${cellIndex + 1}`, cell)),
  }));

  return {
    type: "table",
    attrs: { blockId },
    content: headerRow ? [headerRow, ...bodyRows] : bodyRows,
  };
}

function tableCell(type: "tableCell" | "tableHeader", blockId: string, text: string): PmTableCellNode {
  return {
    type,
    content: [paragraph(`${blockId}-p`, text)],
  };
}

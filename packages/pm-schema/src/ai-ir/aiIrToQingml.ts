import type {
  AiBlock,
  AiListItem,
  AiRun,
  AiRunMark,
  AiTableCell,
  AiTaskListItem,
} from "./aiIrSchema";

export function aiBlocksToQingml(blocks: readonly AiBlock[]): string {
  return blocks.map(aiBlockToQingml).join("");
}

export function aiBlockToQingml(block: AiBlock): string {
  switch (block.type) {
    case "paragraph":
      return tag("p", runsToInline(block.runs), { align: block.textAlign });
    case "heading":
      return tag(`h${block.level}`, runsToInline(block.runs), {
        align: block.textAlign,
        anchor: block.anchor,
      });
    case "blockquote":
      return tag("blockquote", runsToInline(block.runs));
    case "codeBlock":
      return tag("pre", escapeText(block.text), { lang: block.language });
    case "bulletList":
      return tag("ul", block.items.map((item) => aiListItemToQingml(item)).join(""));
    case "orderedList":
      return tag("ol", block.items.map((item) => aiListItemToQingml(item, true)).join(""), {
        start: block.start,
        style: block.listStyle,
      });
    case "horizontalRule":
      return "<hr/>";
    case "table":
      return tag(
        "table",
        block.rows
          .map((row) => aiTableRowToQingml(row.cells.map((cell) => row.header ? { ...cell, header: true } : cell)))
          .join(""),
      );
    case "image":
      return selfClosingTag("img", {
        src: block.src,
        alt: block.alt,
        title: block.title,
        caption: block.caption,
        width: block.width,
        height: block.height,
        align: block.align,
      });
    case "fileAttachment":
      return selfClosingTag("file", {
        id: block.fileId,
        filename: block.filename,
        mime: block.mimeType,
        size: block.size,
      });
    case "penNote":
      return tag("pennote", runsToInline(block.runs));
    case "taskList":
      return tag("tasks", block.items.map(taskListItemToQingml).join(""));
    case "callout":
      return tag("callout", runsToInline(block.runs), {
        emoji: block.emoji,
        tone: block.tone,
      });
    case "columnList":
      return tag(
        "columns",
        block.columns
          .map((column) => tag("column", aiBlocksToQingml(column.blocks), { ratio: column.widthRatio }))
          .join(""),
      );
    case "blockMath":
      return tag("math-block", escapeText(block.latex));
    case "diagram":
      return block.lang === "mermaid"
        ? tag("mermaid", escapeText(block.source))
        : tag("mermaid", escapeText(block.source));
  }
}

export function aiListItemToQingml(item: AiListItem | AiTaskListItem, ordered?: boolean): string {
  if (!ordered && "checked" in item) return taskListItemToQingml(item);
  const children = item.children ? aiBlocksToQingml(item.children) : "";
  return tag("li", `${runsToInline(item.runs)}${children}`);
}

export function aiTableRowToQingml(cells: readonly AiTableCell[]): string {
  return tag(
    "tr",
    cells
      .map((cell) => {
        const name = cell.header ? "th" : "td";
        return tag(name, aiBlocksToQingml(cell.blocks), {
          colspan: cell.colspan,
          rowspan: cell.rowspan,
          bg: cell.backgroundColor,
        });
      })
      .join(""),
  );
}

function taskListItemToQingml(item: AiTaskListItem): string {
  const children = item.children ? aiBlocksToQingml(item.children) : "";
  return tag("task", `${runsToInline(item.runs)}${children}`, item.checked ? { checked: "" } : undefined);
}

function runsToInline(runs: readonly AiRun[]): string {
  return runs.map(runToInline).join("");
}

function runToInline(run: AiRun): string {
  const marks = run.marks ?? [];
  if (marks.some((mark) => mark.type === "math")) return tag("math", escapeText(run.text));

  let out = escapeInlineText(run.text);
  for (let i = marks.length - 1; i >= 0; i -= 1) {
    out = wrapMark(out, marks[i]!);
  }
  return out;
}

function wrapMark(content: string, mark: AiRunMark): string {
  switch (mark.type) {
    case "bold":
      return tag("b", content);
    case "italic":
      return tag("i", content);
    case "underline":
      return tag("u", content);
    case "strike":
    case "strikeThrough":
      return tag("s", content);
    case "code":
      return tag("code", content);
    case "link":
      return tag("a", content, { href: mark.href, title: mark.title });
    case "textColor":
      return tag("color", content, { val: mark.color });
    case "highlight":
      return tag("mark", content, { color: mark.color });
    case "math":
      return tag("math", content);
  }
}

function tag(name: string, content: string, attrs?: Record<string, unknown>): string {
  return `<${name}${attrsToString(attrs)}>${content}</${name}>`;
}

function selfClosingTag(name: string, attrs: Record<string, unknown>): string {
  return `<${name}${attrsToString(attrs)}/>`;
}

function attrsToString(attrs?: Record<string, unknown>): string {
  if (!attrs) return "";
  return Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([name, value]) => value === "" ? ` ${name}` : ` ${name}="${escapeAttribute(String(value))}"`)
    .join("");
}

function escapeInlineText(text: string): string {
  return escapeText(text).replace(/\r\n?/g, "\n").replace(/\n/g, "<br/>");
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

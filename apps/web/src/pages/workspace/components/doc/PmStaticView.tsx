import React, { useMemo, type MouseEventHandler, type ReactNode, type Ref } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { PmBlockNode, PmInlineNode, PmMark, PmTableCellNode } from "@qingagent/pm-schema";
import { ReadonlyImageFigure } from "../ImageView";
import { DiagramRenderer } from "../diagram/DiagramRenderer";

export function PmBlockView({ node }: { node: PmBlockNode }) {
  switch (node.type) {
    case "columnList": {
      const ratios = node.content.map((column) => {
        const ratio = column.attrs.widthRatio;
        return typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0
          ? ratio
          : 1 / Math.max(1, node.content.length);
      });
      const total = ratios.reduce((sum, ratio) => sum + ratio, 0) || 1;
      return (
        <div
          className="pm-column-list"
          data-pm-node="columnList"
          style={{ display: "flex", gap: 16, alignItems: "stretch", width: "100%" }}
        >
          {node.content.map((column, columnIndex) => {
            const widthPercent = `${(ratios[columnIndex]! / total) * 100}%`;
            return (
              <div
                key={column.attrs.blockId ?? columnIndex}
                className="pm-column"
                data-pm-node="column"
                style={{ flexGrow: 0, flexShrink: 1, flexBasis: widthPercent, minWidth: 0 }}
              >
                {column.content.map((child, childIndex) => <PmBlockView key={child.attrs.blockId ?? childIndex} node={child} />)}
              </div>
            );
          })}
        </div>
      );
    }
    case "heading": {
      const children = <>{(node.content ?? []).map((child, i) => <PmInlineView key={i} node={child} />)}</>;
      const id = node.attrs.level === 2 ? node.attrs.anchor ?? undefined : undefined;
      switch (node.attrs.level) {
        case 1:
          return <h1 style={textAlignStyle(node.attrs.textAlign)}>{children}</h1>;
        case 2:
          return <h2 id={id} style={textAlignStyle(node.attrs.textAlign)}>{children}</h2>;
        case 3:
          return <h3 style={textAlignStyle(node.attrs.textAlign)}>{children}</h3>;
        case 4:
          return <h4 style={textAlignStyle(node.attrs.textAlign)}>{children}</h4>;
        case 5:
          return <h5 style={textAlignStyle(node.attrs.textAlign)}>{children}</h5>;
        case 6:
          return <h6 style={textAlignStyle(node.attrs.textAlign)}>{children}</h6>;
      }
    }
    case "paragraph":
      return <p style={textAlignStyle(node.attrs.textAlign)}>{(node.content ?? []).map((child, i) => <PmInlineView key={i} node={child} />)}</p>;
    case "blockquote":
      return <blockquote>{node.content.map((child, i) => <PmBlockView key={i} node={child} />)}</blockquote>;
    case "bulletList":
      return <ul>{node.content.map((item, i) => <PmListItemView key={i} node={item.content} />)}</ul>;
    case "orderedList":
      return <ol start={node.attrs.start ?? undefined}>{node.content.map((item, i) => <PmListItemView key={i} node={item.content} />)}</ol>;
    case "horizontalRule":
      return <hr />;
    case "codeBlock":
      return <pre className="md-code-block" data-language={node.attrs.language ?? "plaintext"}>{pmInlineText(node.content ?? [])}</pre>;
    case "table":
      // 裹一层横滚容器:持久化 colwidth 总和超过可用宽度时,宽表在容器内横向滚动而非撑破/裁切正文与卡片。
      return (
        <div className="pm-table-scroll">
          <table>
            <tbody>
              {node.content.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.content.map((cell, cellIndex) => <PmTableCellView key={cellIndex} cell={cell} />)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
	    case "image":
	      return (
	        <ReadonlyImageFigure
	          src={node.attrs.src}
	          alt={node.attrs.alt ?? ""}
	          caption={node.attrs.caption}
	          width={node.attrs.width}
	          height={node.attrs.height}
	          align={node.attrs.align}
	        />
	      );
    case "fileAttachment":
      return (
        <p>
          <a href={`/api/v1/files/${encodeURIComponent(node.attrs.fileId)}/${encodeURIComponent(node.attrs.filename)}`}>
            {node.attrs.filename}
          </a>
        </p>
      );
    case "penNote":
      return (
        <p style={{ color: "var(--ink-3)", fontSize: 12.5, fontStyle: "italic" }}>
          {(node.content ?? []).map((child, i) => <PmInlineView key={i} node={child} />)}
        </p>
      );
    case "taskList":
      return (
        <ul className="pm-task-list" data-type="taskList">
          {node.content.map((item, i) => (
            <li key={i} data-type="taskItem" data-checked={item.attrs.checked}>
              <input type="checkbox" checked={item.attrs.checked} disabled readOnly />
              <div>
                {item.content.map((child, j) => <PmBlockView key={j} node={child} />)}
              </div>
            </li>
          ))}
        </ul>
      );
    case "callout":
      return (
        <div className={`pm-callout pm-callout--${node.attrs.tone ?? "info"}`} data-pm-node="callout">
          <span className="pm-callout-emoji">{node.attrs.emoji ?? "💡"}</span>
          <div className="pm-callout-body">
            {node.content.map((child, i) => <PmBlockView key={i} node={child} />)}
          </div>
        </div>
      );
    case "blockMath":
      return <MathView latex={node.attrs.latex} display />;
    case "diagram":
      return (
        <div className="pm-diagram" data-pm-node="diagram">
          <DiagramRenderer source={node.attrs.source} cachedSvg={node.attrs.svg} lang={node.attrs.lang ?? "mermaid"} overlay={node.attrs.overlay ?? null} readOnly />
        </div>
      );
  }
}

export function MathView({ latex, display }: { latex: string; display?: boolean }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(latex, { displayMode: display === true, throwOnError: false });
    } catch {
      return null;
    }
  }, [latex, display]);
  if (html === null) {
    return display ? <pre className="pm-math-error">{latex}</pre> : <code className="pm-math-error">{latex}</code>;
  }
  const Tag = display ? "div" : "span";
  return <Tag className="tiptap-mathematics-render" dangerouslySetInnerHTML={{ __html: html }} />;
}

function PmListItemView({ node }: { node: PmBlockNode[] }) {
  return <li>{node.map((child, i) => <PmBlockView key={i} node={child} />)}</li>;
}

export function PmTableCellView({
  cell,
  className,
  cellRef,
  children,
  onMouseEnter,
  onMouseLeave,
}: {
  cell: PmTableCellNode;
  className?: string;
  cellRef?: Ref<HTMLTableCellElement>;
  children?: ReactNode;
  onMouseEnter?: MouseEventHandler<HTMLTableCellElement>;
  onMouseLeave?: MouseEventHandler<HTMLTableCellElement>;
}) {
  const Tag = cell.type === "tableHeader" ? "th" : "td";
  const attrs = cell.attrs as { backgroundColor?: string | null; colspan?: number; rowspan?: number; colwidth?: number[] | null } | undefined;
  const colspan = attrs?.colspan;
  const rowspan = attrs?.rowspan;
  const colwidth = attrs?.colwidth;
  const width = Array.isArray(colwidth) && colwidth.length > 0
    ? colwidth.reduce((sum, w) => sum + (Number.isFinite(w) ? w : 0), 0)
    : undefined;
  return (
    <Tag
      ref={cellRef}
      className={className}
      data-bg-color={attrs?.backgroundColor ?? undefined}
      colSpan={typeof colspan === "number" && colspan > 1 ? colspan : undefined}
      rowSpan={typeof rowspan === "number" && rowspan > 1 ? rowspan : undefined}
      style={width && width > 0 ? { width } : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children ?? cell.content.map((child, i) => <PmBlockView key={i} node={child} />)}
    </Tag>
  );
}

function PmInlineView({ node }: { node: PmInlineNode }) {
  if (node.type === "hardBreak") return <br />;
  if (node.type === "inlineMath") return <MathView latex={node.attrs.latex} />;
  return <>{applyMarks(node.text, node.marks ?? [])}</>;
}

export function textAlignStyle(align: string | null | undefined): React.CSSProperties | undefined {
  return align === "center" || align === "right" || align === "justify" ? { textAlign: align } : undefined;
}

export function applyMarks(text: string, marks: PmMark[]): React.ReactNode {
  return marks.reduce<React.ReactNode>((child, mark) => {
    switch (mark.type) {
      case "bold":
        return <strong>{child}</strong>;
      case "italic":
        return <em>{child}</em>;
      case "underline":
        return <u>{child}</u>;
      case "strike":
        return <s>{child}</s>;
      case "code":
        return <code className="inline-code">{child}</code>;
      case "link":
        return <a href={mark.attrs.href} title={mark.attrs.title ?? undefined} target="_blank" rel="noopener noreferrer">{child}</a>;
      case "textColor":
        return <span data-text-color={mark.attrs.color}>{child}</span>;
      case "highlight":
        return <mark data-color={mark.attrs.color}>{child}</mark>;
    }
  }, text);
}

export function pmInlineText(content: readonly { type: string; text?: string; attrs?: { latex?: string } }[]): string {
  return content
    .map((node) => {
      if (node.type === "hardBreak") return "\n";
      if (node.type === "inlineMath") return node.attrs?.latex ?? "";
      return node.text ?? "";
    })
    .join("");
}

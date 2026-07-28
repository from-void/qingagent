import React, { createContext, useContext, useEffect, useMemo, useRef, type CSSProperties, type MouseEventHandler, type ReactNode, type Ref } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { PmBlockNode, PmInlineNode, PmMark, PmTableCellNode, PmTableNode } from "@qingagent/pm-schema";
import { splitGraphemes } from "../../data/presentationSpans";
import { reviewTableCellKey, type ReviewTableCellTypedCounts } from "../../data/tableTypewriter";
import { ReadonlyImageFigure } from "../ImageView";
import { DiagramRenderer } from "../diagram/DiagramRenderer";

const PmTextRendererContext = createContext<((text: string) => ReactNode) | null>(null);

export function PmTextRendererProvider({
  children,
  renderText,
}: {
  children: ReactNode;
  renderText: (text: string) => ReactNode;
}) {
  return <PmTextRendererContext.Provider value={renderText}>{children}</PmTextRendererContext.Provider>;
}

export function PmTableScroll({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrapper = ref.current;
    if (!wrapper) return;
    let rafId: number | null = null;
    const syncScrolledState = () => wrapper.toggleAttribute("data-scrolled-x", wrapper.scrollLeft > 0);
    const scheduleSync = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        syncScrolledState();
      });
    };
    wrapper.addEventListener("scroll", scheduleSync, { passive: true });
    syncScrolledState();
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      wrapper.removeEventListener("scroll", scheduleSync);
      wrapper.removeAttribute("data-scrolled-x");
    };
  }, []);

  return <div ref={ref} className={`pm-table-scroll${className ? ` ${className}` : ""}`}>{children}</div>;
}

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
    case "table": {
      const logicalColumns = staticTableCellLogicalColumns(node);
      const stickyCellIndexes = staticStickyHeaderCellIndexes(node, logicalColumns);
      // 裹一层横滚容器:持久化 colwidth 总和超过可用宽度时,宽表在容器内横向滚动而非撑破/裁切正文与卡片。
      return (
        <PmTableScroll>
          <table>
            <tbody>
              {node.content.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.content.map((cell, cellIndex) => (
                    <PmTableCellView
                      key={cellIndex}
                      cell={cell}
                      logicalColumn={logicalColumns.get(`${rowIndex}:${cellIndex}`)}
                      stickyColumn={stickyCellIndexes.has(`${rowIndex}:${cellIndex}`)}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </PmTableScroll>
      );
	    }
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

export function PmTypewriterTableView({
  node,
  blockIndex,
  typedCounts,
}: {
  node: PmTableNode;
  blockIndex: number;
  typedCounts: ReviewTableCellTypedCounts;
}) {
  const logicalColumns = staticTableCellLogicalColumns(node);
  const stickyCellIndexes = staticStickyHeaderCellIndexes(node, logicalColumns);
  let activeCellKey: string | null = null;
  node.content.forEach((row, rowIndex) => {
    row.content.forEach((cell, cellIndex) => {
      if (activeCellKey) return;
      const key = reviewTableCellKey(blockIndex, rowIndex, cellIndex);
      const target = inlineGraphemeLength(pmTextBlockInlineContent(cell.content[0]));
      if ((typedCounts.get(key) ?? target) < target) activeCellKey = key;
    });
  });
  return (
    <PmTableScroll>
      <table data-review-table-reveal="true">
        <tbody>
          {node.content.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.content.map((cell, cellIndex) => {
                const key = reviewTableCellKey(blockIndex, rowIndex, cellIndex);
                const block = cell.content[0];
                const inlineContent = pmTextBlockInlineContent(block);
                const target = inlineGraphemeLength(inlineContent);
                const typed = typedCounts.get(key) ?? target;
                const revealedBlock = block
                  ? withTruncatedPmInlineContent(block, inlineContent, typed)
                  : null;
                return (
                  <PmTableCellView
                    key={cellIndex}
                    cell={cell}
                    logicalColumn={logicalColumns.get(`${rowIndex}:${cellIndex}`)}
                    stickyColumn={stickyCellIndexes.has(`${rowIndex}:${cellIndex}`)}
                  >
                    <div className="review-table-reveal-cell" data-review-cell-key={key}>
                      {revealedBlock ? <PmBlockView node={revealedBlock} /> : null}
                      {activeCellKey === key ? (
                        <span
                          className="ai-cursor native-presentation-cursor review-table-reveal-cursor"
                          aria-hidden="true"
                        />
                      ) : null}
                    </div>
                  </PmTableCellView>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </PmTableScroll>
  );
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
  reviewTargetId,
  reviewTargetIndex,
  onClick,
  cellStyle,
  stickyColumn,
  logicalColumn,
}: {
  cell: PmTableCellNode;
  className?: string;
  cellRef?: Ref<HTMLTableCellElement>;
  children?: ReactNode;
  onMouseEnter?: MouseEventHandler<HTMLTableCellElement>;
  onMouseLeave?: MouseEventHandler<HTMLTableCellElement>;
  reviewTargetId?: string;
  reviewTargetIndex?: number;
  onClick?: MouseEventHandler<HTMLTableCellElement>;
  cellStyle?: CSSProperties;
  stickyColumn?: boolean;
  logicalColumn?: number;
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
      data-table-logical-col={logicalColumn}
      data-sticky-col={stickyColumn ? "" : undefined}
      data-review-target-id={reviewTargetId}
      data-review-target-index={reviewTargetIndex}
      colSpan={typeof colspan === "number" && colspan > 1 ? colspan : undefined}
      rowSpan={typeof rowspan === "number" && rowspan > 1 ? rowspan : undefined}
      style={{ ...(width && width > 0 ? { width } : {}), ...cellStyle }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
    >
      {children ?? cell.content.map((child, i) => <PmBlockView key={i} node={child} />)}
    </Tag>
  );
}

export function staticTableCellLogicalColumns(table: PmTableNode): Map<string, number> {
  const occupied: Array<Array<string | undefined>> = [];
  const logicalColumns = new Map<string, number>();
  table.content.forEach((row, rowIndex) => {
    occupied[rowIndex] ??= [];
    let logicalColumn = 0;
    row.content.forEach((cell, cellIndex) => {
      while (occupied[rowIndex]![logicalColumn] !== undefined) logicalColumn += 1;
      const key = `${rowIndex}:${cellIndex}`;
      logicalColumns.set(key, logicalColumn);
      const colspan = Math.max(1, Number(cell.attrs?.colspan) || 1);
      const rowspan = Math.max(1, Number(cell.attrs?.rowspan) || 1);
      for (let rowOffset = 0; rowOffset < rowspan; rowOffset += 1) {
        occupied[rowIndex + rowOffset] ??= [];
        for (let colOffset = 0; colOffset < colspan; colOffset += 1) {
          occupied[rowIndex + rowOffset]![logicalColumn + colOffset] = key;
        }
      }
      logicalColumn += colspan;
    });
  });
  return logicalColumns;
}

function staticStickyHeaderCellIndexes(
  table: PmTableNode,
  logicalColumns = staticTableCellLogicalColumns(table),
): Set<string> {
  const origins = new Map<string, PmTableCellNode>();
  table.content.forEach((row, rowIndex) => {
    row.content.forEach((cell, cellIndex) => origins.set(`${rowIndex}:${cellIndex}`, cell));
  });
  const firstColumnKeys = [...logicalColumns]
    .filter(([, column]) => column === 0)
    .map(([key]) => key);
  return firstColumnKeys.length > 0 && firstColumnKeys.every((key) => origins.get(key)?.type === "tableHeader")
    ? new Set(firstColumnKeys)
    : new Set();
}

function PmInlineView({ node }: { node: PmInlineNode }) {
  const renderText = useContext(PmTextRendererContext);
  if (node.type === "hardBreak") return <br />;
  if (node.type === "inlineMath") return <MathView latex={node.attrs.latex} />;
  return <>{applyMarks(renderText ? renderText(node.text) : node.text, node.marks ?? [])}</>;
}

function inlineGraphemeLength(content: readonly PmInlineNode[]): number {
  return content.reduce(
    (sum, node) => sum + (node.type === "text" ? splitGraphemes(node.text).length : 1),
    0,
  );
}

function pmTextBlockInlineContent(block: PmBlockNode | undefined): readonly PmInlineNode[] {
  if (!block) return [];
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "codeBlock":
    case "penNote":
      return block.content ?? [];
    default:
      return [];
  }
}

function withTruncatedPmInlineContent(
  block: PmBlockNode,
  content: readonly PmInlineNode[],
  graphemeCount: number,
): PmBlockNode {
  const truncated = truncatePmInlineNodes(content, graphemeCount);
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "codeBlock":
    case "penNote":
      return { ...block, content: truncated } as PmBlockNode;
    default:
      return block;
  }
}

function truncatePmInlineNodes(
  content: readonly PmInlineNode[],
  graphemeCount: number,
): PmInlineNode[] {
  let remaining = Math.max(0, Math.floor(graphemeCount));
  const result: PmInlineNode[] = [];
  for (const node of content) {
    if (remaining <= 0) break;
    if (node.type !== "text") {
      result.push(node);
      remaining -= 1;
      continue;
    }
    const graphemes = splitGraphemes(node.text);
    const take = Math.min(remaining, graphemes.length);
    if (take > 0) result.push({ ...node, text: graphemes.slice(0, take).join("") });
    remaining -= take;
  }
  return result;
}

export function textAlignStyle(align: string | null | undefined): React.CSSProperties | undefined {
  return align === "center" || align === "right" || align === "justify" ? { textAlign: align } : undefined;
}

export function applyMarks(text: React.ReactNode, marks: PmMark[]): React.ReactNode {
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

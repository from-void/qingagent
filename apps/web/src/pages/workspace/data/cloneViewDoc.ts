import type { ViewBlock, ViewBlockSeqDiff, ViewColumnDiff, ViewDocSpan, ViewListRowDiff, ViewTableRowDiff } from "./protocol";

export function cloneViewSections(sections: readonly ViewBlock[]): ViewBlock[] {
  return sections.map((section) => {
    const meta = cloneViewBlockMeta(section);
    switch (section.kind) {
      case "h1":
        return { ...meta, kind: "h1", text: section.text, ...(section.textAlign ? { textAlign: section.textAlign } : {}), ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}) };
      case "h2":
        return { ...meta, kind: "h2", text: section.text, anchor: section.anchor, ...(section.textAlign ? { textAlign: section.textAlign } : {}), ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}) };
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return { ...meta, kind: section.kind, text: section.text, ...(section.textAlign ? { textAlign: section.textAlign } : {}), ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}) };
      case "p":
        return { ...meta, kind: "p", spans: section.spans.map((span) => ({ ...span })), ...(section.textAlign ? { textAlign: section.textAlign } : {}) };
      case "quote":
        return { ...meta, kind: "quote", text: section.text, ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}), ...(section.node ? { node: section.node } : {}) };
      case "list":
        return {
          ...meta,
          kind: "list",
          ordered: section.ordered,
          ...(section.start != null ? { start: section.start } : {}),
          ...(section.listStyle ? { listStyle: section.listStyle } : {}),
          items: section.items.slice(),
          ...(section.node ? { node: section.node } : {}),
          ...(section.itemSpans ? { itemSpans: section.itemSpans.map((spans) => spans.map((span) => ({ ...span }))) } : {}),
          ...(section.rowDiff ? { rowDiff: cloneViewListRowDiff(section.rowDiff) } : {}),
        };
      case "hr":
        return { ...meta, kind: "hr" };
      case "table":
        return {
          ...meta,
          kind: "table",
          head: section.head.slice(),
          rows: section.rows.map((row) => row.slice()),
          ...(section.node ? { node: section.node } : {}),
          ...(section.headSpans ? { headSpans: section.headSpans.map((spans) => spans.map((span) => ({ ...span }))) } : {}),
          ...(section.rowSpans
            ? {
                rowSpans: section.rowSpans.map((row) =>
                  row.map((spans) => spans.map((span) => ({ ...span }))),
                ),
              }
            : {}),
          ...(section.cellDiff
            ? {
                cellDiff: section.cellDiff.map((row) => ({
                  status: row.status,
                  cells: row.cells.map((cell) => ({
                    ...cell,
                    spans: cell.spans.map((span) => ({ ...span })),
                  })),
                })),
              }
            : {}),
        };
      case "code":
        return { ...meta, kind: "code", body: section.body, language: section.language ?? null };
      case "diagram":
        return { ...meta, kind: "diagram", source: section.source, lang: section.lang, svg: section.svg, overlay: cloneJson(section.overlay) };
      case "penNote":
        return { ...meta, kind: "penNote", text: section.text, ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}) };
      case "image":
        return {
          ...meta,
          kind: "image",
          src: section.src,
          alt: section.alt,
	          caption: section.caption,
	          width: section.width,
	          height: section.height,
	          align: section.align ?? "center",
	        };
      case "fileAttachment":
        return {
          ...meta,
          kind: "fileAttachment",
          fileId: section.fileId,
          filename: section.filename,
          mimeType: section.mimeType,
          size: section.size,
        };
      case "taskList":
        return {
          ...meta,
          kind: "taskList",
          node: section.node,
          text: section.text,
          ...(section.rowDiff ? { rowDiff: cloneViewListRowDiff(section.rowDiff) } : {}),
        };
      case "callout":
        return {
          ...meta,
          kind: "callout",
          node: section.node,
          text: section.text,
          ...(section.bodyDiff ? { bodyDiff: cloneViewBlockSeqDiff(section.bodyDiff) } : {}),
        };
      case "columnList":
        return {
          ...meta,
          kind: "columnList",
          node: section.node,
          text: section.text,
          ...(section.columnsDiff ? { columnsDiff: section.columnsDiff.map(cloneViewColumnDiff) } : {}),
        };
      case "math":
        return { ...meta, kind: "math", node: section.node, latex: section.latex };
    }
  });
}

function cloneViewBlockMeta(section: ViewBlock) {
  const beforeBlock = section.blockPatch?.beforeBlock
    ? cloneViewSections([section.blockPatch.beforeBlock])[0]
    : undefined;
  return {
    ...(section.blockId ? { blockId: section.blockId } : {}),
    ...(section.blockPatch
      ? {
          blockPatch: {
            patchId: section.blockPatch.patchId,
            op: section.blockPatch.op,
            ...(section.blockPatch.marker ? { marker: { ...section.blockPatch.marker } } : {}),
            ...(beforeBlock ? { beforeBlock } : {}),
          },
        }
      : {}),
  };
}

function cloneViewSpans(spans: readonly ViewDocSpan[]): ViewDocSpan[] {
  return spans.map((span) => ({ ...span }));
}

function cloneJson<T>(value: T): T {
  if (value == null) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneViewListRowDiff(rowDiff: readonly ViewListRowDiff[]): ViewListRowDiff[] {
  const cloneChildLists = (row: ViewListRowDiff) => (
    row.childLists
      ? {
          childLists: row.childLists.map((child) => ({
            ...(child.beforeListIndex !== undefined ? { beforeListIndex: child.beforeListIndex } : {}),
            ...(child.afterListIndex !== undefined ? { afterListIndex: child.afterListIndex } : {}),
            rowDiff: cloneViewListRowDiff(child.rowDiff),
          })),
        }
      : {}
  );
  return rowDiff.map((row): ViewListRowDiff => {
    switch (row.status) {
      case "same":
        return {
          status: "same",
          spans: cloneViewSpans(row.spans),
          ...(typeof row.checked === "boolean" ? { checked: row.checked } : {}),
          ...cloneChildLists(row),
        };
      case "changed":
        return {
          status: "changed",
          ...(row.patchId ? { patchId: row.patchId } : {}),
          spans: cloneViewSpans(row.spans),
          oldText: row.oldText,
          ...(typeof row.checked === "boolean" ? { checked: row.checked } : {}),
          ...(row.checkedChanged ? { checkedChanged: true } : {}),
          ...cloneChildLists(row),
        };
      case "added":
        return {
          status: "added",
          ...(row.patchId ? { patchId: row.patchId } : {}),
          spans: cloneViewSpans(row.spans),
          ...(typeof row.checked === "boolean" ? { checked: row.checked } : {}),
          ...cloneChildLists(row),
        };
      case "removed":
        return {
          status: "removed",
          ...(row.patchId ? { patchId: row.patchId } : {}),
          oldText: row.oldText,
          ...(typeof row.checked === "boolean" ? { checked: row.checked } : {}),
          ...cloneChildLists(row),
        };
    }
  });
}

function cloneViewTableRowDiff(rowDiff: readonly ViewTableRowDiff[]): ViewTableRowDiff[] {
  return rowDiff.map((row) => ({
    status: row.status,
    cells: row.cells.map((cell) => (
      cell.status === "same"
        ? { status: "same", spans: cloneViewSpans(cell.spans) }
        : { status: "changed", spans: cloneViewSpans(cell.spans), oldText: cell.oldText }
    )),
  }));
}

function cloneViewBlockSeqDiff(seqDiff: readonly ViewBlockSeqDiff[number][]): ViewBlockSeqDiff {
  return seqDiff.map((entry): ViewBlockSeqDiff[number] => {
    switch (entry.status) {
      case "same":
        return { status: "same", block: entry.block };
      case "added":
        return { status: "added", block: entry.block };
      case "removed":
        return { status: "removed", oldText: entry.oldText };
      case "changed":
        if (entry.kind === "block") {
          return {
            status: "changed",
            kind: "block",
            node: entry.node,
          };
        }
        if (entry.kind === "text") {
          return {
            status: "changed",
            kind: "text",
            node: entry.node,
            spans: cloneViewSpans(entry.spans),
            oldText: entry.oldText,
          };
        }
        if (entry.kind === "list") {
          return {
            status: "changed",
            kind: "list",
            node: entry.node,
            rowDiff: cloneViewListRowDiff(entry.rowDiff),
          };
        }
        return {
          status: "changed",
          kind: "table",
          node: entry.node,
          cellDiff: cloneViewTableRowDiff(entry.cellDiff),
        };
    }
  });
}

function cloneViewColumnDiff(columnDiff: ViewColumnDiff): ViewColumnDiff {
  return {
    status: columnDiff.status,
    ...(columnDiff.beforeColumnIndex !== undefined ? { beforeColumnIndex: columnDiff.beforeColumnIndex } : {}),
    ...(columnDiff.afterColumnIndex !== undefined ? { afterColumnIndex: columnDiff.afterColumnIndex } : {}),
    bodyDiff: cloneViewBlockSeqDiff(columnDiff.bodyDiff),
  };
}

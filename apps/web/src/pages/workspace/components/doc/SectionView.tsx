import React from "react";
import type { PmBlockNode, PmTableCellNode } from "@qingagent/pm-schema";
import type { PatchMeta } from "../DocumentSnapshotView";
import { DiagramRenderer } from "../diagram/DiagramRenderer";
import { ReadonlyImageFigure } from "../ImageView";
import type { ViewBlock, ViewBlockSeqDiff, ViewDocSpan, ViewListRowDiff, ViewTableRowDiff } from "../../data/protocol";
import { viewDocSpanText, wordDiffSegments } from "../../data/protocol";
import { MathView, PmBlockView, pmInlineText, textAlignStyle } from "./PmStaticView";
import { PatchHoverBlockFrame, PatchHoverFrame, PatchPopupActions, PatchStatePopup, renderOriginalDiff } from "./patchHover";
import { renderMarkedText, SpanView } from "./SpanView";

interface SectionViewProps {
  section: ViewBlock;
  showPatches: boolean;
  acceptedPatches: ReadonlySet<string>;
  rejectedPatches: ReadonlySet<string>;
  onPatchVerdict?: (patchId: string, verdict: "accepted" | "rejected") => void;
  patchMeta?: Map<string, PatchMeta>;
  activePatchId?: string | null;
  revealedPatchIds?: ReadonlySet<string> | null;
  revealCursors?: ReadonlyMap<string, number> | null;
  typedByPatch?: ReadonlyMap<string, number> | null;
}

function cleanReplaceReviewBlock(section: ViewBlock): ViewBlock {
  const meta = section.blockId ? { blockId: section.blockId } : {};
  if (section.kind === "list") {
    return {
      ...meta,
      kind: "list",
      ordered: section.ordered,
      items: section.items,
      ...(section.itemSpans ? { itemSpans: section.itemSpans } : {}),
      ...(section.start != null ? { start: section.start } : {}),
    };
  }
  if (section.kind === "taskList") {
    return { ...meta, kind: "taskList", node: section.node, text: section.text };
  }
  if (section.kind === "table") {
    return {
      ...meta,
      kind: "table",
      head: section.head.slice(),
      rows: section.rows.map((row) => row.slice()),
      ...(section.headSpans ? { headSpans: section.headSpans.map((spans) => spans.map((span) => ({ ...span }))) } : {}),
      ...(section.rowSpans
        ? {
            rowSpans: section.rowSpans.map((row) =>
              row.map((spans) => spans.map((span) => ({ ...span }))),
            ),
          }
        : {}),
    };
  }
  if (section.kind === "callout") {
    return { ...meta, kind: "callout", node: section.node, text: section.text, ...(section.bodyDiff ? { bodyDiff: section.bodyDiff } : {}) };
  }
  if (section.kind === "columnList") {
    return { ...meta, kind: "columnList", node: section.node, text: section.text, ...(section.columnsDiff ? { columnsDiff: section.columnsDiff } : {}) };
  }
  return { ...section, blockPatch: undefined };
}

function rowDiffText(row: ViewListRowDiff): string {
  if (row.status === "removed") return row.oldText;
  return row.spans.map(viewDocSpanText).join("");
}

function tableCellDiffText(cell: ViewTableRowDiff["cells"][number]): string {
  return cell.spans.map(viewDocSpanText).join("");
}

function tableRowDiffText(row: ViewTableRowDiff): string {
  return row.cells.map(tableCellDiffText).join("\t");
}

function hasInlinePatchSpan(spans: readonly ViewDocSpan[] | undefined): boolean {
  return spans?.some((span) =>
    span.kind === "patchDel" ||
    span.kind === "patchIns" ||
    span.kind === "patchDelMath" ||
    span.kind === "patchInsMath" ||
    span.kind === "patchMark",
  ) ?? false;
}

function hasMathSpan(spans: readonly ViewDocSpan[]): boolean {
  return spans.some((span) =>
    span.kind === "math" ||
    span.kind === "patchDelMath" ||
    span.kind === "patchInsMath",
  );
}

function pmCellPlainText(cell: PmTableCellNode): string {
  return cell.content.map(pmBlockPlainText).join("\n");
}

function pmBlockPlainText(node: PmBlockNode): string {
  switch (node.type) {
    case "heading":
    case "paragraph":
    case "penNote":
    case "codeBlock":
      return pmInlineText(node.content ?? []);
    case "blockquote":
      return node.content.map(pmBlockPlainText).join("\n");
    case "bulletList":
    case "orderedList":
      return node.content.map((item) => item.content.map(pmBlockPlainText).join("\n")).join("\n");
    case "table":
      return node.content.map((row) => row.content.map(pmCellPlainText).join("\t")).join("\n");
    case "horizontalRule":
      return "";
    case "image":
      return node.attrs.caption ?? node.attrs.alt ?? "";
    case "fileAttachment":
      return node.attrs.filename;
    case "taskList":
      return node.content
        .map((item) => `${item.attrs.checked ? "[x]" : "[ ]"} ${item.content.map(pmBlockPlainText).join("\n")}`)
        .join("\n");
    case "callout":
      return node.content.map(pmBlockPlainText).join("\n");
    case "columnList":
      return node.content.map((column) => column.content.map(pmBlockPlainText).join("\n")).join("\n");
    case "blockMath":
      return node.attrs.latex;
    case "diagram":
      return node.attrs.source;
  }
}

function checkedLabel(value: boolean | undefined): string {
  return value ? "已完成" : "未完成";
}

function renderRowDiffInlineSpans(spans: readonly ViewDocSpan[]): React.ReactNode {
  return spans.map((span, i) => {
    switch (span.kind) {
      case "text":
        return <React.Fragment key={i}>{renderMarkedText(span.text, span.marks)}</React.Fragment>;
      case "math":
        return <MathView key={i} latex={span.latex} />;
      case "patchIns":
        return <span key={i} className="wf-patch-ins">{renderMarkedText(span.text, span.marks)}</span>;
      case "patchInsMath":
        return <span key={i} className="wf-patch-ins"><MathView latex={span.latex} /></span>;
      case "patchDel":
      case "patchDelMath":
        return null;
      case "patchMark":
        return <React.Fragment key={i}>{renderMarkedText(span.text, span.marks)}</React.Fragment>;
      case "selectable":
        return <span key={i} className="wf-sel">{span.text}</span>;
    }
  });
}

const EMPTY_PATCH_SET: ReadonlySet<string> = new Set<string>();

export const SectionView = React.memo(function SectionView({
  section,
  showPatches,
  acceptedPatches,
  rejectedPatches,
  onPatchVerdict,
  patchMeta,
  activePatchId,
  revealedPatchIds,
  revealCursors,
  typedByPatch,
}: SectionViewProps) {
  const renderSpans = (spans: readonly ViewDocSpan[]) =>
    spans.map((span, i) => (
      <SpanView
        key={i}
        span={span}
        showPatches={showPatches}
        acceptedPatches={acceptedPatches}
        rejectedPatches={rejectedPatches}
        onPatchVerdict={onPatchVerdict}
        patchMeta={patchMeta}
        activePatchId={activePatchId}
        revealedPatchIds={revealedPatchIds}
        revealCursors={revealCursors}
        typedByPatch={typedByPatch}
      />
    ));
  let renderedSection = section;
  let blockPatch = renderedSection.blockPatch;
  if (showPatches && blockPatch?.op === "replace") {
    const accepted = acceptedPatches.has(blockPatch.patchId);
    const rejected = rejectedPatches.has(blockPatch.patchId);
    const revealed = !revealedPatchIds || revealedPatchIds.has(blockPatch.patchId);
    if (rejected || !revealed) {
      renderedSection = cleanReplaceReviewBlock(blockPatch.beforeBlock ?? section);
      blockPatch = renderedSection.blockPatch;
    } else if (accepted) {
      renderedSection = cleanReplaceReviewBlock(section);
      blockPatch = renderedSection.blockPatch;
    } else {
      const activeReplacePatch = blockPatch;
      renderedSection = cleanReplaceReviewBlock(section);
      blockPatch = activeReplacePatch;
    }
  }
  if (showPatches && blockPatch) {
    const accepted = acceptedPatches.has(blockPatch.patchId);
    const rejected = rejectedPatches.has(blockPatch.patchId);
    const revealed = !revealedPatchIds || revealedPatchIds.has(blockPatch.patchId);
    if (blockPatch.op === "insert") {
      if (rejected) return null;
      if (!accepted && !revealed) return null;
    } else if (accepted) {
      return null;
    }
  }

  // 结构块 patch 是否处于"待审可见"态(标记+块体贴色都用同一判定)
  const blockPatchActive = (() => {
    const marker = blockPatch?.marker;
    if (!showPatches || !blockPatch || !marker) return false;
    if (acceptedPatches.has(blockPatch.patchId) || rejectedPatches.has(blockPatch.patchId)) return false;
    if (revealedPatchIds && !revealedPatchIds.has(blockPatch.patchId)) return false;
    return true;
  })();
  const replacePatchActive =
    showPatches &&
    blockPatch?.op === "replace" &&
    !acceptedPatches.has(blockPatch.patchId) &&
    !rejectedPatches.has(blockPatch.patchId) &&
    (!revealedPatchIds || revealedPatchIds.has(blockPatch.patchId));
  const canRenderNestedReplaceDiff = replacePatchActive && !blockPatch?.beforeBlock;

  // 块级改动呈现原则(用户确认):改动一律就近、行内显示。
  // - 文字块(标题/段落/引用/批注):整块新增/删除已由 withBlockPatch 把整段文本投影成
  //   patchIns/patchDel span,行内绿/红铺色即可表达,【不再套任何块状背景/容器】。
  //   这类 blockPatch 没有 marker,直接透传 children。
  // - 结构块(图片/分隔线/整表/整图等块内无可标注文本):整块新增/删除时用【一道左侧细竖条】
  //   (wf-blockmark,不铺背景)+ hover 看"新增图片/删除表格"说明;删除时内容降透明示意。
  const wrapBlockPatch = (children: React.ReactNode) => {
    const marker = blockPatch?.marker;
    if (replacePatchActive && blockPatch?.op === "replace") {
      const patchId = blockPatch.patchId;
      const popupIndex = patchMeta?.get(patchId)?.index;
      const beforeBlock = blockPatch.beforeBlock ? cleanReplaceReviewBlock(blockPatch.beforeBlock) : null;
      const original = beforeBlock ? (
        <div className="patch-popup-preview">
          <SectionView
            section={beforeBlock}
            showPatches={false}
            acceptedPatches={EMPTY_PATCH_SET}
            rejectedPatches={EMPTY_PATCH_SET}
          />
        </div>
      ) : (patchMeta?.get(patchId)?.before ?? "");
      return (
        <PatchHoverBlockFrame
          className={`wf-patch-replace-wrap${activePatchId === patchId ? " is-current" : ""}`}
          patchId={patchId}
          patchState="replace"
          popup={(
            <PatchStatePopup
              state="replace"
              index={popupIndex}
              original={original}
              patchId={patchId}
              onPatchVerdict={onPatchVerdict}
            />
          )}
        >
          {children}
        </PatchHoverBlockFrame>
      );
    }
    if (!blockPatchActive || !blockPatch || !marker) {
      return <>{children}</>;
    }
    const popupIndex = patchMeta?.get(blockPatch.patchId)?.index;
    // 结构块删除:与行内删除口径一致——【不显示被删内容】,折叠成一道红色标记,
    // hover 在卡片里看被删内容(文本投影)。用户反复强调:修改/删除不要把旧块留在原位。
    if (blockPatch.op === "delete") {
      // 被删结构块原位只留红虚线;hover 卡片里给【被删块的缩放原版渲染】(用户要求:能看到删的是什么)。
      const cleanDeleted: ViewBlock = { ...renderedSection, blockPatch: undefined };
      return (
        <PatchHoverBlockFrame
          className={`wf-blockmark-del${activePatchId === blockPatch.patchId ? " is-current" : ""}`}
          patchId={blockPatch.patchId}
          patchState="delete"
          popup={(
            <PatchStatePopup
              state="delete"
              index={popupIndex}
              original={(
                <div className="patch-popup-preview">
                  <SectionView
                    section={cleanDeleted}
                    showPatches={false}
                    acceptedPatches={EMPTY_PATCH_SET}
                    rejectedPatches={EMPTY_PATCH_SET}
                  />
                </div>
              )}
              patchId={blockPatch.patchId}
              onPatchVerdict={onPatchVerdict}
            />
          )}
        >
          <span className="wf-blockmark-del-line" aria-hidden="true" />
        </PatchHoverBlockFrame>
      );
    }
    // 结构块新增:新内容可见 + 左侧绿色细竖条 + hover 标签(自适应翻转,不被裁)
    return (
      <PatchHoverBlockFrame
        className={`wf-blockmark insert${activePatchId === blockPatch.patchId ? " is-current" : ""}`}
        patchId={blockPatch.patchId}
        patchState="insert"
        popup={(
          <PatchStatePopup
            state="insert"
            index={popupIndex}
            patchId={blockPatch.patchId}
            onPatchVerdict={onPatchVerdict}
          />
        )}
      >
        {/* 审阅态所见≈应用后:整块新增只留左侧绿色细竖条(wf-blockmark insert),
           不叠常显「新增」文字徽章;标签/撤销在 hover 弹层「#N · 新增」里 */}
        {children}
      </PatchHoverBlockFrame>
    );
  };

  // 行内多处改动:每个改动区段(连续 del/ins)各自成一个 hover——绿块即改动处,hover 卡片
  // 只展示【该处】改前的原文(纯新增则说明新增)。不再整行一个 hover。
  const renderInlineDiffWithHovers = (oldText: string, newText: string): React.ReactNode => {
    const patchId = blockPatch?.patchId;
    if (!patchId) return <>{newText}</>;
    const popupIndex = patchMeta?.get(patchId)?.index;
    const isActive = activePatchId === patchId;
    const segs = wordDiffSegments(oldText, newText);
    const out: React.ReactNode[] = [];
    let i = 0;
    let k = 0;
    while (i < segs.length) {
      const seg = segs[i]!;
      if (seg.type === "same") {
        out.push(<React.Fragment key={k++}>{renderMarkedText(seg.text)}</React.Fragment>);
        i += 1;
        continue;
      }
      let delText = "";
      let insText = "";
      while (i < segs.length && segs[i]!.type !== "same") {
        if (segs[i]!.type === "del") delText += segs[i]!.text;
        else insText += segs[i]!.text;
        i += 1;
      }
      if (insText) {
        out.push(
          <PatchHoverFrame
            key={k++}
            className={`wf-patch-replace-wrap${isActive ? " is-current" : ""}`}
            patchId={patchId}
            patchState={delText ? "replace" : "insert"}
            popup={
              <>
                <span className="patch-popup-num">#{popupIndex ?? "?"} · {delText ? "修改" : "新增"}</span>
                {/* 纯新增:标题已够,不叠「此处为新增内容」填充;仅「修改」时展示被替换原文 */}
                {delText && (
                  <span className="patch-popup-row">
                    <span className="patch-popup-k">原文</span>
                    <span className="patch-popup-del-seg">{delText}</span>
                  </span>
                )}
                <PatchPopupActions patchId={patchId} onPatchVerdict={onPatchVerdict} />
              </>
            }
          >
            <span className="wf-patch-ins">{insText}</span>
          </PatchHoverFrame>,
        );
      } else if (delText) {
        out.push(
          <PatchHoverFrame
            key={k++}
            className={`wf-patch-del-marker${activePatchId === patchId ? " is-current" : ""}`}
            patchId={patchId}
            patchState="delete"
            popup={
              <>
                <span className="patch-popup-num">#{popupIndex ?? "?"} · 删除</span>
                <span className="patch-popup-row">
                  <span className="patch-popup-k">原文</span>
                  <span className="patch-popup-del-seg">{delText}</span>
                </span>
                <PatchPopupActions patchId={patchId} onPatchVerdict={onPatchVerdict} />
              </>
            }
          >
            <span className="patch-del-cursor" />
          </PatchHoverFrame>,
        );
      }
    }
    return <>{out}</>;
  };

  const renderInlineDiffWithRichSpans = (oldText: string, spans: readonly ViewDocSpan[]): React.ReactNode => {
    const newText = spans.map(viewDocSpanText).join("");
    if (!hasMathSpan(spans)) return renderInlineDiffWithHovers(oldText, newText);
    const patchId = blockPatch?.patchId;
    if (!patchId) return <>{renderRowDiffInlineSpans(spans)}</>;
    const popupIndex = patchMeta?.get(patchId)?.index;
    const isActive = activePatchId === patchId;
    const state = oldText ? "replace" : "insert";
    const className = state === "insert" ? "wf-patch-ins-wrap" : "wf-patch-replace-wrap";
    return (
      <PatchHoverFrame
        className={`${className}${isActive ? " is-current" : ""}`}
        patchId={patchId}
        patchState={state}
        popup={
          <>
            <span className="patch-popup-num">#{popupIndex ?? "?"} · {state === "insert" ? "新增" : "修改"}</span>
            <PatchPopupActions patchId={patchId} onPatchVerdict={onPatchVerdict} />
          </>
        }
      >
        {renderRowDiffInlineSpans(spans)}
      </PatchHoverFrame>
    );
  };

  const renderRowPopup = (row: ViewListRowDiff) => {
    const patchId = blockPatch?.patchId;
    if (!patchId) return null;
    const popupIndex = patchMeta?.get(patchId)?.index;
    const newText = rowDiffText(row);
    if (row.status === "added") {
      return (
        <>
          <span className="patch-popup-num">#{popupIndex ?? "?"} · 新增行</span>
          {newText ? <span className="patch-popup-new-text">{newText}</span> : null}
          <PatchPopupActions patchId={patchId} onPatchVerdict={onPatchVerdict} />
        </>
      );
    }
    if (row.status === "removed") {
      return (
        <>
          <span className="patch-popup-num">#{popupIndex ?? "?"} · 删除行</span>
          {row.oldText ? <span className="patch-popup-deleted">{row.oldText}</span> : null}
          <PatchPopupActions patchId={patchId} onPatchVerdict={onPatchVerdict} />
        </>
      );
    }
    if (row.status === "changed") {
      return (
        <>
          <span className="patch-popup-num">#{popupIndex ?? "?"} · 修改行</span>
          {row.oldText !== newText ? (
            <span className="patch-popup-row">
              <span className="patch-popup-k">原文</span>
              {renderOriginalDiff(row.oldText, newText)}
            </span>
          ) : null}
          {row.checkedChanged ? (
            <span className="patch-popup-row">
              <span className="patch-popup-k">状态</span>
              <span className="patch-popup-new-text">
                {checkedLabel(!row.checked)} → {checkedLabel(row.checked)}
              </span>
            </span>
          ) : null}
          <PatchPopupActions patchId={patchId} onPatchVerdict={onPatchVerdict} />
        </>
      );
    }
    return null;
  };

  const renderRowDiffContent = (row: ViewListRowDiff) => {
    const patchId = blockPatch?.patchId;
    if (row.status === "same" || !patchId) return <>{renderRowDiffInlineSpans(row.status === "removed" ? [] : row.spans)}</>;
    if (row.status === "removed") {
      return (
        <PatchHoverFrame
          className={`row-del${activePatchId === patchId ? " is-current" : ""}`}
          patchId={patchId}
          patchState="delete"
          popup={renderRowPopup(row)}
        >
          <span className="row-del-line" aria-hidden="true" />
        </PatchHoverFrame>
      );
    }
    // 修改行:每处改动各自 hover(行内多处改动 → 多个绿块,各看各的原文)
    if (row.status === "changed") {
      return <>{renderInlineDiffWithRichSpans(row.oldText, row.spans)}</>;
    }
    // 新增行:整行新增,单个 hover
    const isActive = activePatchId === patchId;
    return (
      <PatchHoverFrame
        className={`wf-patch-ins-wrap row-${row.status}${isActive ? " is-current" : ""}`}
        patchId={patchId}
        patchState="insert"
        popup={renderRowPopup(row)}
      >
        {renderRowDiffInlineSpans(row.spans)}
      </PatchHoverFrame>
    );
  };

  const renderListRowDiffItems = (rows: readonly ViewListRowDiff[]) =>
    rows.map((row, i) => (
      <li key={i} data-row-status={row.status}>
        {renderRowDiffContent(row)}
      </li>
    ));

  const renderTaskRowDiffItems = (rows: readonly ViewListRowDiff[]) =>
    rows.map((row, i) => {
      if (row.status === "removed") {
        return (
          <li key={i} data-row-status="removed">
            {renderRowDiffContent(row)}
          </li>
        );
      }
      const checkbox = (
        <input
          type="checkbox"
          checked={row.checked === true}
          disabled
          readOnly
          className={row.status === "changed" && row.checkedChanged ? "cb-changed" : undefined}
        />
      );
      return (
        <li key={i} data-type="taskItem" data-checked={row.checked} data-row-status={row.status}>
          {row.status === "changed" && row.checkedChanged && blockPatch ? (
            <PatchHoverFrame
              className="wf-task-cb-change"
              patchId={blockPatch.patchId}
              popup={renderRowPopup(row)}
            >
              {checkbox}
            </PatchHoverFrame>
          ) : checkbox}
          <div><p>{renderRowDiffContent(row)}</p></div>
        </li>
      );
    });

  const renderTableRowPopup = (row: ViewTableRowDiff) => {
    const patchId = blockPatch?.patchId;
    if (!patchId) return null;
    const popupIndex = patchMeta?.get(patchId)?.index;
    const rowText = tableRowDiffText(row);
    if (row.status === "added") {
      return (
        <>
          <span className="patch-popup-num">#{popupIndex ?? "?"} · 新增行</span>
          {rowText ? <span className="patch-popup-new-text">{rowText}</span> : null}
          <PatchPopupActions patchId={patchId} onPatchVerdict={onPatchVerdict} />
        </>
      );
    }
    if (row.status === "removed") {
      return (
        <>
          <span className="patch-popup-num">#{popupIndex ?? "?"} · 删除行</span>
          {rowText ? <span className="patch-popup-deleted">{rowText}</span> : null}
          <PatchPopupActions patchId={patchId} onPatchVerdict={onPatchVerdict} />
        </>
      );
    }
    return null;
  };

  const renderTableCellPopup = (cell: Extract<ViewTableRowDiff["cells"][number], { status: "changed" }>) => {
    const patchId = blockPatch?.patchId;
    if (!patchId) return null;
    const popupIndex = patchMeta?.get(patchId)?.index;
    const newText = tableCellDiffText(cell);
    return (
      <>
        <span className="patch-popup-num">#{popupIndex ?? "?"} · 修改单元格</span>
        {cell.oldText !== newText ? (
          <span className="patch-popup-row">
            <span className="patch-popup-k">原文</span>
            {renderOriginalDiff(cell.oldText, newText)}
          </span>
        ) : null}
        <PatchPopupActions patchId={patchId} onPatchVerdict={onPatchVerdict} />
      </>
    );
  };

  const renderTableCellDiffContent = (cell: ViewTableRowDiff["cells"][number], row: ViewTableRowDiff) => {
    const patchId = blockPatch?.patchId;
    if (!patchId) return <>{renderRowDiffInlineSpans(cell.spans)}</>;
    const isActive = activePatchId === patchId;
    if (row.status === "added") {
      return (
        <PatchHoverFrame
          className={`wf-table-row-add-hover${isActive ? " is-current" : ""}`}
          patchId={patchId}
          patchState="insert"
          popup={renderTableRowPopup(row)}
        >
          {renderRowDiffInlineSpans(cell.spans)}
        </PatchHoverFrame>
      );
    }
    if (cell.status === "changed") {
      // 单元格内多处改动各自 hover
      return <>{renderInlineDiffWithRichSpans(cell.oldText, cell.spans)}</>;
    }
    return <>{renderRowDiffInlineSpans(cell.spans)}</>;
  };

  const renderTableDiffRow = (
    row: ViewTableRowDiff,
    key: React.Key,
    cellTag: "td" | "th",
    columnCount: number,
  ) => {
    const patchId = blockPatch?.patchId;
    const CellTag = cellTag;
    if (row.status === "removed" && patchId) {
      return (
        <tr key={key} data-row-status="removed">
          <CellTag colSpan={columnCount}>
            <PatchHoverFrame
              className={`row-del${activePatchId === patchId ? " is-current" : ""}`}
              patchId={patchId}
              patchState="delete"
              popup={renderTableRowPopup(row)}
            >
              <span className="row-del-line" aria-hidden="true" />
            </PatchHoverFrame>
          </CellTag>
        </tr>
      );
    }
    return (
      <tr key={key} className={row.status === "added" ? "row-add" : undefined} data-row-status={row.status}>
        {row.cells.map((cell, i) => (
          <CellTag key={i} data-cell-status={cell.status}>
            {renderTableCellDiffContent(cell, row)}
          </CellTag>
        ))}
      </tr>
    );
  };

  const renderBlockSeqPopup = (entry: ViewBlockSeqDiff[number]) => {
    const patchId = blockPatch?.patchId;
    if (!patchId) return null;
    const popupIndex = patchMeta?.get(patchId)?.index;
    if (entry.status === "added") {
      const newText = pmBlockPlainText(entry.block);
      return (
        <>
          <span className="patch-popup-num">#{popupIndex ?? "?"} · 新增块</span>
          {newText ? <span className="patch-popup-new-text">{newText}</span> : null}
          <PatchPopupActions patchId={patchId} onPatchVerdict={onPatchVerdict} />
        </>
      );
    }
    if (entry.status === "removed") {
      return (
        <>
          <span className="patch-popup-num">#{popupIndex ?? "?"} · 删除块</span>
          {entry.oldText ? <span className="patch-popup-deleted">{entry.oldText}</span> : null}
          <PatchPopupActions patchId={patchId} onPatchVerdict={onPatchVerdict} />
        </>
      );
    }
    if (entry.status === "changed" && entry.kind === "text") {
      const newText = entry.spans.map(viewDocSpanText).join("");
      return (
        <>
          <span className="patch-popup-num">#{popupIndex ?? "?"} · 修改块</span>
          {entry.oldText !== newText ? (
            <span className="patch-popup-row">
              <span className="patch-popup-k">原文</span>
              {renderOriginalDiff(entry.oldText, newText)}
            </span>
          ) : null}
          <PatchPopupActions patchId={patchId} onPatchVerdict={onPatchVerdict} />
        </>
      );
    }
    return null;
  };

  const renderChangedTextBlock = (entry: Extract<ViewBlockSeqDiff[number], { status: "changed"; kind: "text" }>) => {
    // 容器内文本块的多处改动也各自 hover
    const inline = renderInlineDiffWithRichSpans(entry.oldText, entry.spans);

    switch (entry.node.type) {
      case "paragraph":
        return <p style={textAlignStyle(entry.node.attrs.textAlign)}>{inline}</p>;
      case "heading": {
        const id = entry.node.attrs.level === 2 ? entry.node.attrs.anchor ?? undefined : undefined;
        switch (entry.node.attrs.level) {
          case 1:
            return <h1 style={textAlignStyle(entry.node.attrs.textAlign)}>{inline}</h1>;
          case 2:
            return <h2 id={id} style={textAlignStyle(entry.node.attrs.textAlign)}>{inline}</h2>;
          case 3:
            return <h3 style={textAlignStyle(entry.node.attrs.textAlign)}>{inline}</h3>;
          case 4:
            return <h4 style={textAlignStyle(entry.node.attrs.textAlign)}>{inline}</h4>;
          case 5:
            return <h5 style={textAlignStyle(entry.node.attrs.textAlign)}>{inline}</h5>;
          case 6:
            return <h6 style={textAlignStyle(entry.node.attrs.textAlign)}>{inline}</h6>;
        }
        return <h6 style={textAlignStyle(entry.node.attrs.textAlign)}>{inline}</h6>;
      }
      case "penNote":
        return (
          <p style={{ color: "var(--ink-3)", fontSize: 12.5, fontStyle: "italic" }}>
            {inline}
          </p>
        );
      default:
        return <PmBlockView node={entry.node} />;
    }
  };

  const renderListDiffBlock = (
    node: Extract<PmBlockNode, { type: "bulletList" | "orderedList" | "taskList" }>,
    rowDiff: readonly ViewListRowDiff[],
  ) => {
    if (node.type === "taskList") {
      return (
        <ul className="pm-task-list wf-row-diff-list" data-type="taskList">
          {renderTaskRowDiffItems(rowDiff)}
        </ul>
      );
    }
    const Tag = node.type === "orderedList" ? "ol" : "ul";
    return (
      <Tag
        className="wf-row-diff-list"
        start={node.type === "orderedList" ? node.attrs.start ?? undefined : undefined}
      >
        {renderListRowDiffItems(rowDiff)}
      </Tag>
    );
  };

  const renderTableDiffBlock = (node: Extract<PmBlockNode, { type: "table" }>, cellDiff: readonly ViewTableRowDiff[]) => {
    const firstRow = node.content[0];
    const hasHead = firstRow?.content.every((cell) => cell.type === "tableHeader") ?? false;
    const headDiffRows = hasHead ? cellDiff.slice(0, 1) : [];
    const bodyDiffRows = hasHead ? cellDiff.slice(1) : cellDiff;
    const columnCount = Math.max(
      1,
      ...node.content.map((row) => row.content.length),
      ...cellDiff.map((row) => row.cells.length),
    );
    return (
      <table className="wf-table-diff">
        <tbody>
          {headDiffRows.map((row, i) => renderTableDiffRow(row, `h-${i}`, "th", columnCount))}
          {bodyDiffRows.map((row, i) => renderTableDiffRow(row, `b-${i}`, "td", columnCount))}
        </tbody>
      </table>
    );
  };

  const renderBlockSeqDiffEntry = (entry: ViewBlockSeqDiff[number], key: React.Key) => {
    const patchId = blockPatch?.patchId;
    if (entry.status === "same") return <PmBlockView key={key} node={entry.block} />;
    if (entry.status === "added") {
      if (!patchId) return <PmBlockView key={key} node={entry.block} />;
      return (
        <PatchHoverBlockFrame
          key={key}
          className={`wf-patch-ins-wrap row-added${activePatchId === patchId ? " is-current" : ""}`}
          patchId={patchId}
          patchState="insert"
          popup={renderBlockSeqPopup(entry)}
        >
          <div className="wf-patch-ins">
            <PmBlockView node={entry.block} />
          </div>
        </PatchHoverBlockFrame>
      );
    }
    if (entry.status === "removed") {
      if (!patchId) return null;
      return (
        <PatchHoverFrame
          key={key}
          className={`row-del${activePatchId === patchId ? " is-current" : ""}`}
          patchId={patchId}
          patchState="delete"
          popup={renderBlockSeqPopup(entry)}
        >
          <span className="row-del-line" aria-hidden="true" />
        </PatchHoverFrame>
      );
    }
    if (entry.kind === "text") {
      return <React.Fragment key={key}>{renderChangedTextBlock(entry)}</React.Fragment>;
    }
    if (entry.kind === "list") {
      if (entry.node.type !== "bulletList" && entry.node.type !== "orderedList" && entry.node.type !== "taskList") {
        return <PmBlockView key={key} node={entry.node} />;
      }
      return <React.Fragment key={key}>{renderListDiffBlock(entry.node, entry.rowDiff)}</React.Fragment>;
    }
    if (entry.node.type !== "table") return <PmBlockView key={key} node={entry.node} />;
    return <React.Fragment key={key}>{renderTableDiffBlock(entry.node, entry.cellDiff)}</React.Fragment>;
  };

  const renderBlockSeqDiff = (seqDiff: readonly ViewBlockSeqDiff[number][]) =>
    seqDiff.map((entry, i) => renderBlockSeqDiffEntry(entry, i));

  switch (renderedSection.kind) {
    case "h1":
      return wrapBlockPatch(<h1 style={textAlignStyle(renderedSection.textAlign)}>{renderedSection.spans ? renderSpans(renderedSection.spans) : renderedSection.text}</h1>);
    case "h2":
      return wrapBlockPatch(<h2 id={renderedSection.anchor} style={textAlignStyle(renderedSection.textAlign)}>{renderedSection.spans ? renderSpans(renderedSection.spans) : renderedSection.text}</h2>);
    case "h3":
      return wrapBlockPatch(<h3 style={textAlignStyle(renderedSection.textAlign)}>{renderedSection.spans ? renderSpans(renderedSection.spans) : renderedSection.text}</h3>);
    case "h4":
      return wrapBlockPatch(<h4 style={textAlignStyle(renderedSection.textAlign)}>{renderedSection.spans ? renderSpans(renderedSection.spans) : renderedSection.text}</h4>);
    case "h5":
      return wrapBlockPatch(<h5 style={textAlignStyle(renderedSection.textAlign)}>{renderedSection.spans ? renderSpans(renderedSection.spans) : renderedSection.text}</h5>);
    case "h6":
      return wrapBlockPatch(<h6 style={textAlignStyle(renderedSection.textAlign)}>{renderedSection.spans ? renderSpans(renderedSection.spans) : renderedSection.text}</h6>);
    case "p":
      return wrapBlockPatch(
        <p style={textAlignStyle(renderedSection.textAlign)}>
          {renderSpans(renderedSection.spans)}
        </p>,
      );
    case "quote":
      if (renderedSection.node && !hasInlinePatchSpan(renderedSection.spans)) {
        return wrapBlockPatch(<PmBlockView node={renderedSection.node} />);
      }
      return wrapBlockPatch(<blockquote><p>{renderedSection.spans ? renderSpans(renderedSection.spans) : renderedSection.text}</p></blockquote>);
    case "list": {
      const Tag = renderedSection.ordered ? "ol" : "ul";
      if (canRenderNestedReplaceDiff && renderedSection.rowDiff?.length) {
        return wrapBlockPatch(
          <Tag
            className="wf-row-diff-list"
            start={renderedSection.ordered ? renderedSection.start ?? undefined : undefined}
          >
            {renderListRowDiffItems(renderedSection.rowDiff)}
          </Tag>,
        );
      }
      return wrapBlockPatch(
        <Tag start={renderedSection.ordered ? renderedSection.start ?? undefined : undefined}>
          {renderedSection.items.map((item, i) => (
            <li key={i}>
              {renderedSection.itemSpans?.[i]?.length ? renderSpans(renderedSection.itemSpans[i]!) : item}
            </li>
          ))}
        </Tag>,
      );
    }
    case "hr":
      return wrapBlockPatch(<hr />);
    case "table": {
      if (canRenderNestedReplaceDiff && renderedSection.cellDiff?.length) {
        const diffRows = renderedSection.cellDiff;
        const hasHead = renderedSection.head.length > 0;
        const headDiffRows = hasHead ? diffRows.slice(0, 1) : [];
        const bodyDiffRows = hasHead ? diffRows.slice(1) : diffRows;
        const columnCount = Math.max(
          1,
          renderedSection.head.length,
          ...renderedSection.rows.map((row) => row.length),
          ...diffRows.map((row) => row.cells.length),
        );
        return wrapBlockPatch(
          <table className="wf-table-diff">
            <tbody>
              {headDiffRows.map((row, i) => renderTableDiffRow(row, `h-${i}`, "th", columnCount))}
              {bodyDiffRows.map((row, i) => renderTableDiffRow(row, `b-${i}`, "td", columnCount))}
            </tbody>
          </table>,
        );
      }
      return wrapBlockPatch(
        <table>
          <tbody>
            {renderedSection.head.length > 0 ? (
              <tr>
              {renderedSection.head.map((h, i) => (
                <th key={i}>
                  {renderedSection.headSpans?.[i]?.length ? renderSpans(renderedSection.headSpans[i]!) : h}
                </th>
              ))}
              </tr>
            ) : null}
            {renderedSection.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>
                    {renderedSection.rowSpans?.[i]?.[j]?.length ? renderSpans(renderedSection.rowSpans[i]![j]!) : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
    }
    case "code":
      return wrapBlockPatch(
        <pre className="md-code-block" data-language={renderedSection.language ?? "plaintext"}>{renderedSection.body}</pre>,
      );
    case "diagram":
      // 审阅/只读快照:节点-边图带 overlay 渲染,其他 Mermaid 仍用静态预览。
      return wrapBlockPatch(
        <div className="pm-diagram" data-pm-node="diagram">
          <DiagramRenderer source={renderedSection.source} cachedSvg={renderedSection.svg} lang={renderedSection.lang} overlay={renderedSection.overlay ?? null} readOnly />
        </div>,
      );
    case "penNote":
      return wrapBlockPatch(
        <p
          style={{
            color: "var(--ink-3)",
            fontSize: 12.5,
            fontStyle: "italic",
          }}
        >
          {renderedSection.spans ? renderSpans(renderedSection.spans) : renderedSection.text}
        </p>,
      );
	    case "image":
	      return wrapBlockPatch(
	        <ReadonlyImageFigure
	          src={renderedSection.src}
	          alt={renderedSection.alt}
	          caption={renderedSection.caption}
	          width={renderedSection.width}
	          height={renderedSection.height}
	          align={renderedSection.align}
	        />,
	      );
    case "fileAttachment":
      return wrapBlockPatch(
        <p>
          <a href={`/api/v1/files/${encodeURIComponent(renderedSection.fileId)}/${encodeURIComponent(renderedSection.filename)}`}>
            {renderedSection.filename}
          </a>
        </p>,
      );
    // 审核态保真块:直接复用最终态的 PmBlockView 渲染原始 pm 节点(真复选框 / 提示框 /
    // 并排分栏 / KaTeX 公式),保证"审核态展示=最终态展示"。这几类只参与整块插入/删除,
    // 行内 diff 不锚定到它们(patchableSectionSpans 返回 null),故无需在内部叠 patch span。
    case "taskList":
      if (canRenderNestedReplaceDiff && renderedSection.rowDiff?.length) {
        return wrapBlockPatch(
          <ul className="pm-task-list wf-row-diff-list" data-type="taskList">
            {renderTaskRowDiffItems(renderedSection.rowDiff)}
          </ul>,
        );
      }
      return wrapBlockPatch(<PmBlockView node={renderedSection.node} />);
    case "callout": {
      const node = renderedSection.node;
      if (canRenderNestedReplaceDiff && renderedSection.bodyDiff?.length && node.type === "callout") {
        return wrapBlockPatch(
          <div className={`pm-callout pm-callout--${node.attrs.tone ?? "info"}`} data-pm-node="callout">
            <span className="pm-callout-emoji">{node.attrs.emoji ?? "💡"}</span>
            <div className="pm-callout-body wf-row-diff-list">
              {renderBlockSeqDiff(renderedSection.bodyDiff)}
            </div>
          </div>,
        );
      }
      return wrapBlockPatch(<PmBlockView node={renderedSection.node} />);
    }
    case "columnList": {
      const node = renderedSection.node;
      if (canRenderNestedReplaceDiff && renderedSection.columnsDiff?.length && node.type === "columnList") {
        const ratios = node.content.map((column) => {
          const ratio = column.attrs.widthRatio;
          return typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0
            ? ratio
            : 1 / Math.max(1, node.content.length);
        });
        const total = ratios.reduce((sum, ratio) => sum + ratio, 0) || 1;
        return wrapBlockPatch(
          <div
            className="pm-column-list"
            data-pm-node="columnList"
            style={{ display: "flex", gap: 16, alignItems: "stretch", width: "100%" }}
          >
            {node.content.map((column, columnIndex) => {
              const widthPercent = `${(ratios[columnIndex]! / total) * 100}%`;
              const columnDiff = renderedSection.columnsDiff?.[columnIndex];
              return (
                <div
                  key={column.attrs.blockId ?? columnIndex}
                  className="pm-column"
                  data-pm-node="column"
                  style={{ flexGrow: 0, flexShrink: 1, flexBasis: widthPercent, minWidth: 0 }}
                >
                  <div className="pm-column-body wf-row-diff-list">
                    {columnDiff ? renderBlockSeqDiff(columnDiff) : column.content.map((child, childIndex) => (
                      <PmBlockView key={child.attrs.blockId ?? childIndex} node={child} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>,
        );
      }
      return wrapBlockPatch(<PmBlockView node={renderedSection.node} />);
    }
    case "math":
      return wrapBlockPatch(<PmBlockView node={renderedSection.node} />);
  }
});

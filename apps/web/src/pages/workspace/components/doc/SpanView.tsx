import React from "react";
import type { PmMark } from "@qingagent/pm-schema";
import type { ViewDocSpan } from "../../data/protocol";
import type { PatchMeta } from "../DocumentSnapshotView";
import { applyMarks } from "./PmStaticView";
import {
  mixedPatchChanges,
  PatchHoverFrame,
  PatchPopupActions,
  PatchPopupChanges,
  renderOriginalDiff,
} from "./patchHover";

interface SpanViewProps {
  span: ViewDocSpan;
  showPatches: boolean;
  acceptedPatches: ReadonlySet<string>;
  rejectedPatches: ReadonlySet<string>;
  // 改动B:审批入口"标记逐处入场"——为 null/undefined 时全部视为已入场(静态审批/恢复态);
  // 为 Set 时仅集合内 patchId 渲染红绿标记，集合外渲染成 baseline（原文在、新增未现）。
  revealedPatchIds?: ReadonlySet<string> | null;
  /** 改动B 微调:当前打字游标处 patchId 集合(可并发多处)，在其末尾叠加全文光标特效。 */
  revealCursors?: ReadonlyMap<string, number> | null;
  /** 改动B 逐字打字:每处新增文案已打字符数;null/undefined = 不截断(全显示)。 */
  typedByPatch?: ReadonlyMap<string, number> | null;
  onPatchVerdict?: (patchId: string, verdict: "accepted" | "rejected") => void;
  patchMeta?: Map<string, PatchMeta>;
  activePatchId?: string | null;
}

/**
 * 全文光标特效(复用 native 应用动效的光标外观:闪烁竖条+圆点+辉光)。
 * 名字标识改由拟人鼠标 overlay(HumanCursorOverlay)承载,光标本身不带 Agent·N 文字;
 * 仅打上 data-hc-lane 作为鼠标定位锚点(lane = 并发通道号)。
 */
function RevealCursor({ tone, lane }: { tone?: "red"; lane?: number }) {
  return (
    <span
      className={`ai-cursor native-presentation-cursor wf-reveal-cursor${tone === "red" ? " red" : ""}`}
      aria-hidden="true"
      data-hc-lane={lane != null ? String(lane) : undefined}
      // 纯删除处:让拟人鼠标也用红色(否则回退 lane 色,丢失"这是删除"的颜色暗示)
      data-hc-color={tone === "red" ? "#ef4444" : undefined}
    />
  );
}

/** 行内 marks 渲染:与正式态 Tiptap 同视觉(粗/斜/下划/删除/行内代码/链接/高亮)。
 *  嵌套顺序 link 最外,与 AI-IR 生成约定一致。 */
export function renderMarkedText(text: string, marks?: readonly PmMark[]): React.ReactNode {
  if (!marks || marks.length === 0) return text;
  let node: React.ReactNode = text;
  for (const mark of marks) {
    switch (mark.type) {
      case "bold":
        node = <strong>{node}</strong>;
        break;
      case "italic":
        node = <em>{node}</em>;
        break;
      case "underline":
        node = <u>{node}</u>;
        break;
      case "strike":
        node = <s>{node}</s>;
        break;
      case "code":
        node = <code className="inline-code">{node}</code>;
        break;
      case "highlight":
        node = <mark data-color={mark.attrs.color}>{node}</mark>;
        break;
      case "link":
        node = (
          <a href={mark.attrs.href} target="_blank" rel="noreferrer">
            {node}
          </a>
        );
        break;
    }
  }
  return node;
}

export function SpanView({
  span,
  showPatches,
  acceptedPatches,
  rejectedPatches,
  revealedPatchIds,
  revealCursors,
  typedByPatch,
  onPatchVerdict,
  patchMeta,
  activePatchId,
}: SpanViewProps) {
  switch (span.kind) {
    case "text": {
      return <>{renderMarkedText(span.text, span.marks)}</>;
    }
    case "patchDel": {
      const accepted = acceptedPatches.has(span.patchId);
      const rejected = rejectedPatches.has(span.patchId);
      if (!showPatches || accepted) return null;
      if (rejected) return <>{span.text}</>;
      // 改动B:未入场的 patchDel 显示原文（baseline 态——删除标记尚未"演"出来）
      if (revealedPatchIds && !revealedPatchIds.has(span.patchId)) return <>{span.text}</>;

      const meta = patchMeta?.get(span.patchId);
      const isBlockDeletion = meta?.kind === "delete";
      const isPureDeletion = meta != null && meta.after === "";

      // 修改里的删除部分:原位不显示,挂到对应 patchIns 的 hover(见 patchIns 分支)。
      if (!isBlockDeletion && !isPureDeletion) return null;

      // 统一删除呈现:行内删除 / 整段删除一律【不显示被删内容】,只在删除位置留一道红色光标,
      // hover 看被删的内容。与用户审核规范一致(删除=红光标+hover)。
      const changes = mixedPatchChanges(meta);
      return (
        <PatchHoverFrame
          className="wf-patch-del-marker"
          patchId={span.patchId}
          popup={
            <>
              <span className="patch-popup-num">#{meta?.index ?? "?"}</span>
              {changes ? (
                <PatchPopupChanges changes={changes} />
              ) : (
                <span className="patch-popup-deleted">{meta?.before || span.text}</span>
              )}
              <PatchPopupActions patchId={span.patchId} onPatchVerdict={onPatchVerdict} />
            </>
          }
        >
          {revealCursors?.has(span.patchId) && (
            <RevealCursor tone="red" lane={revealCursors.get(span.patchId)} />
          )}
          <span className="patch-del-cursor" />
        </PatchHoverFrame>
      );
    }
    case "patchIns": {
      const accepted = acceptedPatches.has(span.patchId);
      const rejected = rejectedPatches.has(span.patchId);
      if (!showPatches || accepted) return <>{span.text}</>;
      if (rejected) return null;
      // 改动B:未入场的 patchIns 隐藏新增（baseline 态——新增标记尚未"演"出来）
      if (revealedPatchIds && !revealedPatchIds.has(span.patchId)) return null;

      const meta = patchMeta?.get(span.patchId);
      const isActive = activePatchId === span.patchId;
      const isPureInsert = meta != null && meta.before === "";
      // Pure addition: after starts with before and extends it
      const isAddition =
        meta != null &&
        meta.before.length > 0 &&
        meta.after.startsWith(meta.before) &&
        meta.after.length > meta.before.length;

      // For additions, split the text: show the anchor (before) part as
      // plain text and only the appended portion with green highlight.
      const anchorPart = isAddition ? meta.before : "";
      const newPart = isAddition ? span.text.slice(meta.before.length) : span.text;
      // 改动B 逐字打字:正在打字时只显示已打出的前 N 个字符(按 code point 截,中文/emoji 不截半);
      // typedByPatch 为 null/未含该处 → 全显示(静态审批/恢复/降级态)。
      const typed = typedByPatch?.get(span.patchId);
      const newPartArr = Array.from(newPart);
      const shownArr = typed == null ? newPartArr : newPartArr.slice(0, typed);
      // 正在打字时:把刚"打"出的末尾几个字符单独成 head,用线性渐变遮罩做半透明渐变淡入——
      // 光标处最透明、随打字变老→变实,看起来是丝滑的渐变流出,而非逐字硬蹦。
      const isTyping = typed != null && typed < newPartArr.length;
      const REVEAL_HEAD = 4;
      const headLen = isTyping ? Math.min(REVEAL_HEAD, shownArr.length) : 0;
      const bodyText = shownArr.slice(0, shownArr.length - headLen).join("");
      const headText = shownArr.slice(shownArr.length - headLen).join("");
      const changes = mixedPatchChanges(meta);

      return (
        <PatchHoverFrame
          className={`wf-patch-ins-wrap${isActive ? " active" : ""}`}
          patchId={span.patchId}
          popup={
            <>
              <span className="patch-popup-num">#{meta?.index ?? "?"}</span>
              {changes ? (
                <PatchPopupChanges changes={changes} />
              ) : isAddition || isPureInsert ? (
                <span className="patch-popup-info">
                  {meta?.kind === "insert" ? "新增内容" : "新增内容"}
                </span>
              ) : (
                <span className="patch-popup-row">
                  <span className="patch-popup-k">原文</span>
                  {renderOriginalDiff(meta?.before ?? "", meta?.after ?? span.text)}
                </span>
              )}
              <PatchPopupActions patchId={span.patchId} onPatchVerdict={onPatchVerdict} />
            </>
          }
        >
          {isAddition && <>{anchorPart}</>}
          <span className="wf-patch-ins">
            {bodyText}
            {headText && <span className="wf-patch-ins-head">{headText}</span>}
          </span>
          {revealCursors?.has(span.patchId) && (
            <RevealCursor lane={revealCursors.get(span.patchId)} />
          )}
        </PatchHoverFrame>
      );
    }
    case "patchMark": {
      const accepted = acceptedPatches.has(span.patchId);
      const rejected = rejectedPatches.has(span.patchId);
      const meta = patchMeta?.get(span.patchId);
      const label = meta?.label ?? span.label;
      if (!showPatches) return <>{span.text}</>;
      if (accepted) {
        return <>{span.op === "markAdd" ? applyMarks(span.text, span.marks) : span.text}</>;
      }
      if (rejected) return <>{span.text}</>;
      if (revealedPatchIds && !revealedPatchIds.has(span.patchId)) return <>{span.text}</>;

      const isActive = activePatchId === span.patchId;
      const isAdd = span.op === "markAdd";
      const markStyle: React.CSSProperties = {
        background: isAdd
          ? `linear-gradient(to bottom, transparent 46%, rgba(232, 145, 58, ${isActive ? 0.42 : 0.28}) 46%)`
          : "linear-gradient(to bottom, transparent 46%, rgba(87, 121, 155, 0.22) 46%)",
        boxShadow: `inset 0 -1px ${isAdd ? "rgba(232, 145, 58, 0.34)" : "rgba(87, 121, 155, 0.34)"}`,
        textDecoration: isAdd ? undefined : "line-through",
        textDecorationColor: isAdd ? undefined : "rgba(87, 121, 155, 0.65)",
      };
      const changes = mixedPatchChanges(meta);
      // 格式变更:去掉行内文字徽章("加粗/删除线"),只保留下划线高亮提示此处有格式改动,
      // 具体说明移到 hover 卡片里(label / changes)。与用户"不要行内标签"诉求一致。
      return (
        <PatchHoverFrame
          className={`wf-patch-ins-wrap wf-patch-mark-wrap ${isAdd ? "add" : "remove"}${isActive ? " active" : ""}`}
          title={label}
          patchId={span.patchId}
          popup={
            <>
              <span className="patch-popup-num">#{meta?.index ?? "?"}</span>
              {changes ? (
                <PatchPopupChanges changes={changes} />
              ) : (
                <span className="patch-popup-info">{label}</span>
              )}
              <PatchPopupActions patchId={span.patchId} onPatchVerdict={onPatchVerdict} />
            </>
          }
        >
          <span className="wf-patch-ins wf-patch-mark" style={markStyle}>
            {isAdd ? applyMarks(span.text, span.marks) : span.text}
          </span>
          {revealCursors?.has(span.patchId) && (
            <RevealCursor lane={revealCursors.get(span.patchId)} />
          )}
        </PatchHoverFrame>
      );
    }
    case "selectable":
      return <span className="wf-sel">{span.text}</span>;
  }
}

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { getMarkRange } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { DOMParser as ProseMirrorDOMParser, Slice } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import katex from "katex";
import "katex/dist/katex.min.css";
import { APPLYING_REMOTE_META, createDedupeBlockIdsTransaction, createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { legacySectionsToPm, markdownToPm, normalizePmDoc, pmToClipboardHtml, pmToPlainText, upgradeMermaidCodeBlocksToDiagram, type PmBlockNode, type PmDoc, type PmInlineNode, type PmMark, type PmTableCellNode } from "@qingagent/pm-schema";
import { CodeBlockCM } from "./CodeBlockView";
import { CalloutCM } from "./CalloutView";
import { findDraggableBlock, type MovableBlock } from "./ColumnDnD";
import { ColumnCM, ColumnListCM } from "./ColumnView";
import {
  findDraggableListItem,
  getListItemRowMetrics,
  LIST_ITEM_DND_MIME,
  ListItemDnDExtension,
  resolveListItemByBlockId,
  type DraggableListItem,
} from "./ListItemDnD";
import {
  BlockCollapseExtension,
  getBlockCollapseInfo,
  getCollapsedBlockIds,
  qingagentCollapseKey,
  setBlockCollapseDocId,
  setBlockCollapseForceExpanded,
  toggleBlockCollapse,
} from "./BlockCollapse";
import { DiagramCM } from "./DiagramView";
import { ImageCM, ReadonlyImageFigure, normalizeImageAlign } from "./ImageView";
import { DiagramRenderer } from "./diagram/DiagramRenderer";
import { mountBlockPatchView } from "./doc/blockPatchView";
import { chatInputBus } from "../../../system";
import {
  advanceNativeConcurrentState,
  buildNativeDiffInstructions,
  buildNativePresentationSeedSections,
  cloneNativePresentationRun,
  createNativeConcurrentState,
  planNativeTiming,
  shouldForwardEditorUpdate,
  shouldUseInstantNativePresentation,
  type NativePresentationRun,
} from "../data/nativeDiffAnimation";
import {
  applyNativeConcurrentFrame,
  NativePresentationDecorations,
  resolveNativeTargetRange,
  setNativePresentationDecorations,
  type NativeEditorOperationRuntime,
} from "../data/nativePresentationPm";
import {
  buildPatchDecorations,
  clearPatchDecorations,
  setPatchDecorations,
} from "../data/patchDecorations";
import { sectionText } from "../data/presentationSpans";
import type { ReviewTableTypedByPatch } from "../data/tableTypewriter";
import {
  classifyIncomingDoc,
  pushPendingSelfDocKey,
} from "../data/docSyncClassify";
import type {
  ViewBlock,
  ViewBlockSeqDiff,
  ViewDocSpan,
  ViewDocumentSnapshot,
  ViewListRowDiff,
  ViewTableRowDiff,
  AppliedPatch,
  BlockPatchInput,
  DocSuggestion,
  PatchOverlayInput,
} from "../data/protocol";
import { insertFileAsset, insertImageAsset } from "../data/insertUploadedAsset";
import { MathEditPopover, type MathEditTarget } from "./MathEditPopover";
import { DocColophon } from "./DocColophon";
import {
  applyTableToolbarFormat,
  isTableToolbarFormatCommand,
  setTableCellSelectionFromDom,
} from "../data/tableToolbar";
import {
  resolveAnchoredBubblePosition,
  resolveCenteredFloatingPosition,
} from "../data/floatingPosition";
import {
  isTableToolbarCommandEnabled,
  normalizeToolbarHighlightColor,
  normalizeToolbarTextColor,
  resolveToolbarUnlockConfig,
  sanitizeToolbarLinkHref,
  TOOLBAR_HIGHLIGHT_COLORS,
  TOOLBAR_TEXT_COLORS,
  TOOLBAR_THEME_COLORS,
  type ToolbarThemeColorKey,
} from "../data/toolbarUnlock";
import { MATH_CLICK_EVENT, createWorkspaceTiptapExtensions } from "./doc/workspaceTiptapExtensions";
import { handleQingagentPaste, writeSelectionToClipboard } from "./doc/clipboardPaste";
export { handleQingagentPaste, parsePlainTextClipboard } from "./doc/clipboardPaste";
import {
  createBlockDragPayload,
  createDefaultColumnListNode,
  createDefaultTableNode,
  insertStructureNodeAfterBlock,
} from "./doc/structureNodes";
export {
  createBlockDragPayload,
  createDefaultColumnListNode,
  createDefaultTableNode,
  insertStructureNodeAfterBlock,
} from "./doc/structureNodes";
import { pickFile } from "./doc/pickFile";
export { pickFile } from "./doc/pickFile";
import { hasMissingPresentationBlockId, viewDocToPm, viewSectionsToHtml } from "./doc/viewDocHtml";
import { BlockHandle } from "./doc/BlockHandle";
import { LinkHoverCard } from "./doc/LinkHoverCard";
import { PatchHoverLayer } from "./doc/PatchHoverLayer";
import { PmBlockView } from "./doc/PmStaticView";
import { TableControls } from "./doc/TableControls";
import { TableHeaderOverlay } from "./doc/TableHeaderOverlay";
import type { AiModifyTarget } from "../data/aiModifyTarget";
export { resolveWorkspaceFloatingPortalTarget } from "./doc/TableControls";

export type PatchMetaChange =
  | { kind: "content"; before: string; after: string }
  | {
      kind: "mark";
      op: "markAdd" | "markRemove";
      marks?: PmMark[];
      label?: string;
    };

export interface PatchMeta {
  before: string;
  after: string;
  kind?: "text" | "markAdd" | "markRemove" | "insert" | "delete" | "replace";
  marks?: PmMark[];
  label?: string;
  /** 原始 before PM node:hover 卡片"原文"据此用 PmBlockView 渲成真内容(表格/图表/公式/嵌套列表全保真)。 */
  beforePmNodes?: readonly PmBlockNode[];
  changes?: PatchMetaChange[];
  index: number;
}

export interface DocumentSnapshotViewHandle {
  getInnerHtml: () => string;
  getLastPresentationRun: () => NativePresentationRun | null;
  flushPendingDocSave: () => Promise<void>;
}

export interface DocumentSnapshotViewProps {
  doc: ViewDocumentSnapshot;
  docId?: string | null;
  editable: boolean;
  /** TipTap 已挂载时是否允许用户交互编辑；presentation 动画期间会强制只读。 */
  interactiveEditable?: boolean;
  /** 审阅态锚点基于原文 PM 位置；退出审阅前延后存量 blockId 自愈，避免改写位置与锚点错位。 */
  deferBlockIdNormalization?: boolean;
  showPatches: boolean;
  acceptedPatches: ReadonlySet<string>;
  rejectedPatches: ReadonlySet<string>;
  /** 改动B:审批入口标记逐处入场的已入场集合；null/undefined = 全部已入场（静态/恢复态）。 */
  revealedPatchIds?: ReadonlySet<string> | null;
  /** 改动B 微调:当前这一拍正在"打字"出现的那几处 patchId(可并发多处)，在其末尾叠加全文光标特效。 */
  revealCursors?: ReadonlyMap<string, number> | null;
  /** 改动B 逐字打字:每处新增文案已"打"出的字符数;null/undefined = 不截断(全显示)。 */
  typedByPatch?: ReadonlyMap<string, number> | null;
  tableTypedByPatch?: ReviewTableTypedByPatch | null;
  onPatchVerdict?: (patchId: string, verdict: "accepted" | "rejected") => void;
  /** Maps patchId to before/after text and sequence number. */
  patchMeta?: Map<string, PatchMeta>;
  /** Currently navigated-to patch for highlight. */
  activePatchId?: string | null;
  reviewSuggestions?: readonly DocSuggestion[];
  reviewOverlayInputs?: readonly PatchOverlayInput[];
  reviewBlockPatches?: readonly BlockPatchInput[];
  reviewAppliedPatches?: readonly AppliedPatch[];
  reviewTargets?: readonly import("../data/protocol").ReviewTarget[];
  activeReviewTargetId?: string | null;
  onEditorReady?: (editor: Editor | null) => void;
  onEditorChange?: (doc: PmDoc) => void | Promise<void>;
  onToast?: (message: string) => void;
  onAiModify?: (target: AiModifyTarget) => Promise<boolean>;
  presentationRun?: NativePresentationRun | null;
  presentationReducedMotion?: boolean;
  onPresentationFinish?: () => void;
  onPresentationCancel?: () => void;
}

export const DocumentSnapshotView = forwardRef<
  DocumentSnapshotViewHandle,
  DocumentSnapshotViewProps
>(function DocumentSnapshotView(
  {
    doc,
    docId = null,
    editable,
    interactiveEditable,
    deferBlockIdNormalization = false,
    showPatches,
    acceptedPatches,
    rejectedPatches,
    revealedPatchIds,
    revealCursors,
    typedByPatch,
    tableTypedByPatch,
    onPatchVerdict,
    patchMeta,
    activePatchId,
    reviewSuggestions,
    reviewOverlayInputs,
    reviewBlockPatches,
    reviewAppliedPatches,
    reviewTargets,
    activeReviewTargetId,
    onEditorReady,
    onEditorChange,
    onToast,
    onAiModify,
    presentationRun,
    presentationReducedMotion = false,
    onPresentationFinish,
    onPresentationCancel,
  },
  ref,
) {
  const articleRef = useRef<HTMLElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const tiptapRef = useRef<TipTapDocHandle>(null);
  const lastPresentationRunRef = useRef<NativePresentationRun | null>(null);

  useImperativeHandle(
    ref,
    (): DocumentSnapshotViewHandle => ({
      getInnerHtml() {
        const ed = editorRef.current;
        if (ed && !ed.isDestroyed) return ed.getHTML();
        return articleRef.current?.innerHTML ?? "";
      },
      getLastPresentationRun() {
        return lastPresentationRunRef.current
          ? cloneNativePresentationRun(lastPresentationRunRef.current)
          : null;
      },
      flushPendingDocSave() {
        return tiptapRef.current?.flushPendingDocSave() ?? Promise.resolve();
      },
    }),
    [],
  );

  useEffect(() => {
    if (presentationRun) {
      lastPresentationRunRef.current = cloneNativePresentationRun(presentationRun);
    }
  }, [presentationRun]);

  const handleEditorReady = useCallback(
    (editor: Editor | null) => {
      editorRef.current = editor;
      onEditorReady?.(editor);
    },
    [onEditorReady],
  );

  const presentationMatchesDoc = presentationRun?.docVersion === doc.version;
  const mountTipTap = editable || presentationMatchesDoc;
  const tiptapInteractiveEditable = (interactiveEditable ?? editable) && !presentationMatchesDoc;

  if (mountTipTap) {
    const tiptap = (
      <TipTapDoc
        ref={tiptapRef}
        doc={doc}
        interactiveEditable={tiptapInteractiveEditable}
        deferBlockIdNormalization={deferBlockIdNormalization}
        docId={docId}
        forceExpandCollapse={showPatches || !editable || Boolean(presentationRun)}
        showPatches={showPatches}
        acceptedPatches={acceptedPatches}
        rejectedPatches={rejectedPatches}
        revealedPatchIds={revealedPatchIds}
        revealCursors={revealCursors}
        typedByPatch={typedByPatch}
        tableTypedByPatch={tableTypedByPatch}
        onPatchVerdict={onPatchVerdict}
        patchMeta={patchMeta}
        activePatchId={activePatchId}
        reviewSuggestions={reviewSuggestions}
        reviewOverlayInputs={reviewOverlayInputs}
        reviewBlockPatches={reviewBlockPatches}
        reviewAppliedPatches={reviewAppliedPatches}
        reviewTargets={reviewTargets}
        activeReviewTargetId={activeReviewTargetId}
        onEditorReady={handleEditorReady}
        onEditorChange={onEditorChange}
        onToast={onToast}
        onAiModify={onAiModify}
        presentationRun={presentationRun}
        presentationReducedMotion={presentationReducedMotion}
        onPresentationFinish={onPresentationFinish}
        onPresentationCancel={onPresentationCancel}
      />
    );
    return tiptap;
  }

  return (
    <div className="ws-paper-surface" data-wf="WorkspacePaperSurface">
      <div className="ws-editor-glow" data-wf="WorkspaceEditorGlow" aria-hidden="true" />
      <article
        ref={articleRef}
        className="wf-doc"
        style={{ maxWidth: 800, paddingRight: 200 }}
        data-wf="DocumentSnapshotView"
        data-version={doc.version}
        spellCheck={false}
      >
        {doc.pmDoc?.content.map((node, i) => <PmBlockView key={`pm-${i}`} node={node} />)}
      </article>
      {/* 审阅态(静态补丁路径,editable=false)也把落款这块奶白纸提前占好位:
          内容(署名文字/印章)以占位态隐藏、不跑入场动画,只把高度预留出来。
          提交结清 → 翻回可编辑(TipTap)路径,那条会渲染非占位的真落款、内容淡入,
          高度连续、不再凭空蹦出一整块。占位落款作为 .wf-doc 的兄弟,沿用其
          position+z-index:1 盖住正文纸阴影接缝的作用(口径与 TipTap 路径一致)。 */}
      {!presentationRun ? <DocColophon doc={doc} placeholder /> : null}
    </div>
  );
});

/* ───────────── TipTap editable doc ───────────── */

/** 公式点击事件:扩展在模块级创建拿不到 React 状态,经 window 事件转发给 TipTapDoc 弹编辑浮层。 */
interface TipTapDocHandle {
  flushPendingDocSave: () => Promise<void>;
}

const TipTapDoc = forwardRef<TipTapDocHandle, {
  doc: ViewDocumentSnapshot;
  interactiveEditable: boolean;
  deferBlockIdNormalization: boolean;
  docId: string | null;
  forceExpandCollapse: boolean;
  showPatches: boolean;
  acceptedPatches: ReadonlySet<string>;
  rejectedPatches: ReadonlySet<string>;
  revealedPatchIds?: ReadonlySet<string> | null;
  revealCursors?: ReadonlyMap<string, number> | null;
  typedByPatch?: ReadonlyMap<string, number> | null;
  tableTypedByPatch?: ReviewTableTypedByPatch | null;
  onPatchVerdict?: (patchId: string, verdict: "accepted" | "rejected") => void;
  patchMeta?: Map<string, PatchMeta>;
  activePatchId?: string | null;
  reviewSuggestions?: readonly DocSuggestion[];
  reviewOverlayInputs?: readonly PatchOverlayInput[];
  reviewBlockPatches?: readonly BlockPatchInput[];
  reviewAppliedPatches?: readonly AppliedPatch[];
  reviewTargets?: readonly import("../data/protocol").ReviewTarget[];
  activeReviewTargetId?: string | null;
  onEditorReady: (editor: Editor | null) => void;
  onEditorChange?: (doc: PmDoc) => void | Promise<void>;
  onToast?: (message: string) => void;
  onAiModify?: (target: AiModifyTarget) => Promise<boolean>;
  presentationRun?: NativePresentationRun | null;
  presentationReducedMotion: boolean;
  onPresentationFinish?: () => void;
  onPresentationCancel?: () => void;
}>(function TipTapDoc(
  {
    doc,
    interactiveEditable,
    deferBlockIdNormalization,
    docId,
    forceExpandCollapse,
    showPatches,
    acceptedPatches,
    rejectedPatches,
    revealedPatchIds,
    revealCursors,
    typedByPatch,
    tableTypedByPatch,
    onPatchVerdict,
    patchMeta,
    activePatchId,
    reviewSuggestions,
    reviewOverlayInputs,
    reviewBlockPatches,
    reviewAppliedPatches,
    reviewTargets,
    activeReviewTargetId,
    onEditorReady,
    onEditorChange,
    onToast,
    onAiModify,
    presentationRun,
    presentationReducedMotion,
    onPresentationFinish,
    onPresentationCancel,
  },
  ref,
) {
  const isApplyingRemoteRef = useRef(false);
  const remoteApplyDepthRef = useRef(0);
  const isPresentationApplyingRef = useRef(false);
  // 已 forward 上去、尚未确认回声的自我保存内容键(规范化后 JSON)。doc-sync 用它识别
  // "陈旧自我回声"——快打字时编辑器已超前于回声,绝不能让旧回声 setContent 倒退光标/吞字。
  const pendingSelfDocKeysRef = useRef<string[]>([]);
  const activePresentationRef = useRef<{
    runId: number;
    skip: () => void;
  } | null>(null);
  const presentationTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const presentationFrameRef = useRef<{
    id: number;
    resolve: (time: number) => void;
  } | null>(null);
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beginApplyingRemote = useCallback(() => {
    remoteApplyDepthRef.current += 1;
    isApplyingRemoteRef.current = true;
  }, []);
  const finishApplyingRemoteSoon = useCallback(() => {
    scheduleMicrotask(() => {
      remoteApplyDepthRef.current = Math.max(0, remoteApplyDepthRef.current - 1);
      isApplyingRemoteRef.current = remoteApplyDepthRef.current > 0;
    });
  }, []);
  const initialContent = useMemo(
    () =>
      presentationRun?.docVersion === doc.version
        ? viewSectionsToHtml(presentationRun.baselineSections)
        : viewDocToPm(doc),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const editorExtensions = useMemo(
    () => createWorkspaceTiptapExtensions({ docId, forceExpandCollapse }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // 粘贴图片到正文:走上传文件链路(uploadAssetFile)再插 image 节点;读 ref 拿当前 editor,
  // 避免 editorProps 闭包捕获到 useEditor 首帧的 null。
  const pasteImageEditorRef = useRef<Editor | null>(null);
  const handlePasteImages = useCallback(
    (files: File[]) => {
      const ed = pasteImageEditorRef.current;
      if (!ed || ed.isDestroyed || !ed.isEditable) return;
      void (async () => {
        for (const file of files) {
          try {
            await insertImageAsset(ed, file);
          } catch (error) {
            console.error("[workspace] paste image upload failed", error);
            onToast?.("图片上传失败，请重试");
          }
        }
      })();
    },
    [onToast],
  );
  const editor = useEditor({
    // immediatelyRender:false——TipTap v3 默认 true 会在 React render 阶段同步创建 EditorView
    // 并内部 flushSync 同步 NodeView,落在 render 窗口触发"flushSync was called from inside a
    // lifecycle method"告警(e2e v07/v08/v10/v12/v17 反复复现,栈为纯 render 栈 TipTapDoc→
    // DocumentSnapshotView→RightPane)。设 false 把首次建视图延后到 commit 后的 effect,消除
    // render 期 flushSync。代价:首帧 editor 为 null——本组件所有 effect 已 if(!editor)守空,
    // EditorContent 接受 null,editable 工具门控再加 && editor 收窄即可。逐帧揭示动画走后续
    // setContentSilently 不受影响(只改首次建视图时机,不改后续命令)。
    immediatelyRender: false,
    // 可编辑性以 interactiveEditable 为准(dev 模型);extensions 用 editorExtensions(带 docId/forceExpandCollapse 折叠 plumbing)
    editable: interactiveEditable,
    extensions: editorExtensions,
    content: initialContent,
    editorProps: {
      attributes: {
        class: "wf-doc",
        "data-wf": "DocumentSnapshotView",
        "data-version": String(doc.version),
        style: "max-width:800px;padding-right:200px;outline:none",
      },
      // F3 剪切板:copy/cut 同时写干净语义 HTML + 纯文本(表格 TSV),
      // 支持 HTML 的目标(飞书/Word)保留表格与样式,纯文本目标自然降级。
      // 任何异常返回 false 走 ProseMirror 默认行为,绝不破坏既有复制。
      handleDOMEvents: {
        copy: (view, event) => writeSelectionToClipboard(view, event, false),
        cut: (view, event) => writeSelectionToClipboard(view, event, true),
        // 拦截文档内部锚点链接点击(href="#anchor-id"),做页内平滑滚动。
        // TipTap Link 扩展 openOnClick:false 导致普通点击只弹气泡，不跳转；
        // 此处直接检测 #href 并 scrollIntoView，无需修改 Link 扩展配置。
        click: (_view, event) => {
          const target = event.target as HTMLElement;
          const a = target.closest("a[href]") as HTMLAnchorElement | null;
          if (!a) return false;
          const href = a.getAttribute("href") ?? "";
          if (!href.startsWith("#")) return false;
          const anchorId = href.slice(1);
          if (!anchorId) return false;
          const el = document.getElementById(anchorId);
          if (!el) return false;
          event.preventDefault();
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          return true;
        },
      },
      handlePaste: (view, event, slice) => handleQingagentPaste(view, event, onToast, handlePasteImages, slice),
    },
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    // setEditable 会同步触发 EditorContent 刷新,直接在 useEffect(commit)窗口执行会引发
    // TipTap v3 'flushSync was called from inside a lifecycle method' 告警;editable 态
    // 非帧时序敏感,延后到 microtask(commit 之后)执行,避开告警且无副作用。
    const nextEditable = interactiveEditable;
    scheduleMicrotask(() => {
      if (!editor || editor.isDestroyed) return;
      editor.setEditable(nextEditable);
    });
  }, [editor, interactiveEditable]);

  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    // setBlockCollapse* 内部同步 editor.view.dispatch(tr),在 useLayoutEffect(commit)窗口
    // 执行会触发 TipTap v3 flushSync 生命周期告警;延后到 microtask(仍在 paint 前,无闪烁)。
    const id = docId;
    scheduleMicrotask(() => {
      if (!editor || editor.isDestroyed) return;
      setBlockCollapseDocId(editor, id);
    });
  }, [editor, docId]);

  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const force = forceExpandCollapse;
    scheduleMicrotask(() => {
      if (!editor || editor.isDestroyed) return;
      setBlockCollapseForceExpanded(editor, force);
    });
  }, [editor, forceExpandCollapse]);

  const forwardCurrentEditorDoc = useCallback(async () => {
    if (
      !editor ||
      editor.isDestroyed ||
      !onEditorChange ||
      !shouldForwardEditorUpdate({
        isApplyingRemote: isApplyingRemoteRef.current,
        isAnimating: isPresentationApplyingRef.current,
      })
    ) {
      return;
    }
    const normalized = normalizePmDoc(editor.getJSON());
    // 记录这次 forward 的内容键,供 doc-sync 把它的回声识别为"自我保存"(即便之后又打了字)。
    pendingSelfDocKeysRef.current = pushPendingSelfDocKey(
      pendingSelfDocKeysRef.current,
      JSON.stringify(normalized),
    );
    await onEditorChange(normalized);
  }, [editor, onEditorChange]);

  useImperativeHandle(
    ref,
    (): TipTapDocHandle => ({
      async flushPendingDocSave() {
        if (!updateTimerRef.current) return;
        clearTimeout(updateTimerRef.current);
        updateTimerRef.current = null;
        await forwardCurrentEditorDoc();
      },
    }),
    [forwardCurrentEditorDoc],
  );

  useEffect(() => {
    pasteImageEditorRef.current = editor ?? null;
    if (editor) {
      onEditorReady(editor);
      return () => onEditorReady(null);
    }
  }, [editor, onEditorReady]);

  useReviewPatchDecorations({
    editor,
    enabled: showPatches && !presentationRun,
    doc,
    suggestions: reviewSuggestions,
    overlayInputs: reviewOverlayInputs,
    blockPatches: reviewBlockPatches,
    applied: reviewAppliedPatches,
    reviewTargets,
    acceptedPatches,
    rejectedPatches,
    activePatchId,
    activeReviewTargetId,
    revealedPatchIds,
    typedByPatch,
    tableTypedByPatch,
    revealCursors,
  });

  // 公式点击 → 弹 LaTeX 编辑浮层(只在可编辑态响应)
  const [mathEdit, setMathEdit] = useState<MathEditTarget | null>(null);
  useEffect(() => {
    if (!editor) return;
    const onMathClick = (event: Event) => {
      const detail = (event as CustomEvent<{ kind: "inline" | "block"; latex: string; pos: number }>).detail;
      if (!detail || editor.isDestroyed || !editor.isEditable) return;
      let anchorX = window.innerWidth / 2;
      let anchorY = window.innerHeight / 3;
      try {
        const coords = editor.view.coordsAtPos(detail.pos);
        anchorX = coords.left;
        anchorY = coords.bottom;
      } catch {
        /* 坐标解析失败时浮层落在视口默认位置 */
      }
      setMathEdit({ ...detail, anchorX, anchorY });
    };
    window.addEventListener(MATH_CLICK_EVENT, onMathClick);
    return () => window.removeEventListener(MATH_CLICK_EVENT, onMathClick);
  }, [editor]);

  const closeMathEdit = useCallback(() => setMathEdit(null), []);
  const saveMathEdit = useCallback(
    (latex: string) => {
      if (!editor || !mathEdit) return;
      if (!editor.isEditable) return;
      const chain = editor.chain().focus();
      if (mathEdit.kind === "block") chain.updateBlockMath({ latex, pos: mathEdit.pos }).run();
      else chain.updateInlineMath({ latex, pos: mathEdit.pos }).run();
      setMathEdit(null);
    },
    [editor, mathEdit],
  );
  const deleteMathEdit = useCallback(() => {
    if (!editor || !mathEdit) return;
    if (!editor.isEditable) return;
    const chain = editor.chain().focus();
    if (mathEdit.kind === "block") chain.deleteBlockMath({ pos: mathEdit.pos }).run();
    else chain.deleteInlineMath({ pos: mathEdit.pos }).run();
    setMathEdit(null);
  }, [editor, mathEdit]);

  useEffect(() => {
    if (!editor || !onEditorChange) return;
    const handleUpdate = () => {
      if (
        !shouldForwardEditorUpdate({
          isApplyingRemote: isApplyingRemoteRef.current,
          isAnimating: isPresentationApplyingRef.current,
        })
      ) {
        return;
      }
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
      updateTimerRef.current = setTimeout(() => {
        updateTimerRef.current = null;
        // forwardCurrentEditorDoc 内含 normalizePmDoc;.catch 兜住个别瞬态非法块
        // (如尚未填源码的 diagram)的校验异常,不让一次异常炸掉编辑器 update 转发流。
        void forwardCurrentEditorDoc().catch((error) => {
          console.error("[doc] debounced save failed", error);
        });
      }, 400);
    };
    editor.on("update", handleUpdate);
    return () => {
      editor.off("update", handleUpdate);
      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current);
        updateTimerRef.current = null;
      }
    };
  }, [editor, forwardCurrentEditorDoc, onEditorChange]);

  const lastVersionRef = useRef(doc.version);
  const latestDocVersionRef = useRef(doc.version);
  const latestPresentationDocVersionRef = useRef<number | null>(
    presentationRun?.docVersion ?? null,
  );
  const deferBlockIdNormalizationRef = useRef(deferBlockIdNormalization);
  const interactiveEditableRef = useRef(interactiveEditable);
  const repairedBlockIdVersionRef = useRef<string | null>(null);
  latestDocVersionRef.current = doc.version;
  latestPresentationDocVersionRef.current = presentationRun?.docVersion ?? null;
  deferBlockIdNormalizationRef.current = deferBlockIdNormalization;
  interactiveEditableRef.current = interactiveEditable;
  useEffect(() => {
    if (
      editor &&
      !editor.isDestroyed &&
      doc.version !== lastVersionRef.current
    ) {
      if (presentationRun?.docVersion === doc.version) {
        lastVersionRef.current = doc.version;
        return;
      }
      const scheduledDoc = doc;
      const scheduledVersion = doc.version;
      scheduleMicrotask(() => {
        if (!editor || editor.isDestroyed) return;
        if (latestDocVersionRef.current !== scheduledVersion) return;
        if (lastVersionRef.current === scheduledVersion) return;
        // 揭示动画正在播放(或将播放本版本):主 effect 绝不抢着 setContent,
        // 把渲染权让给 presentation 动画的逐帧 setContentSilently,否则会用成品
        // 直接覆盖、吞掉逐字光标动效。microtask 延后后时序可能与 presentationRun
        // staged 交错,故这里用实时 ref 双重判定(版本 + 是否正在播放)。
        if (
          isPresentationApplyingRef.current ||
          latestPresentationDocVersionRef.current === scheduledVersion
        ) {
          lastVersionRef.current = scheduledVersion;
          return;
        }
        beginApplyingRemote();
        // 诊断 p02 fail-closed:装载含当前编辑器不支持节点的文档时,setContent 抛
        // Unknown node type 且编辑器回落为空白——用户看到"整篇被清空"(实际库里
        // 还在)。这里捕获装载失败,保留上一版可见内容并明确报错,绝不渲染空白。
        try {
          const incoming = viewDocToPm(scheduledDoc);
          // 受控回环修复:用户打字 → 防抖回写 → 服务器存盘 → manualDocSaved 把"同一内容(仅 version+1)"
          // 写回 canonical doc。回声(含快打字下"编辑器已超前于回声"的陈旧回声)绝不能 setContent
          // 整篇重设(TipTap 会把光标甩到文末、吞掉尚未存的新输入)——只同步版本号,光标原地不动。
          // 只有既不等当前内容、也不是我方任何在途保存的,才是真·外部变更(agent/回滚/审阅)。
          const incomingKey = JSON.stringify(normalizePmDoc(incoming));
          const liveKey = JSON.stringify(normalizePmDoc(editor.getJSON()));
          const sync = classifyIncomingDoc({
            incomingKey,
            liveKey,
            pendingSelfKeys: pendingSelfDocKeysRef.current,
          });
          if (sync.verdict === "echo") {
            // 命中在途自我保存键 → 连同更早的一起丢弃(它们都已落地)。
            if (sync.matchedSelfIndex >= 0) {
              pendingSelfDocKeysRef.current = pendingSelfDocKeysRef.current.slice(
                sync.matchedSelfIndex + 1,
              );
            }
            lastVersionRef.current = scheduledVersion;
          } else {
            // 真·外部变更:我方在途编辑已被外部覆盖,清空在途自我键避免后续误判;
            // 换内容前先记住选区,焦点在编辑器时按原位恢复光标(越界则钳到文末)。
            pendingSelfDocKeysRef.current = [];
            const hadFocus = editor.isFocused;
            const prevSelection = editor.state.selection;
            setRemoteEditorContent(editor, incoming);
            lastVersionRef.current = scheduledVersion;
            if (hadFocus) {
              const size = editor.state.doc.content.size;
              const from = Math.min(prevSelection.from, size);
              const to = Math.min(prevSelection.to, size);
              try {
                editor.chain().setTextSelection({ from, to }).run();
              } catch {
                /* 选区映射失败(结构变化过大)时忽略,不强行定位 */
              }
            }
          }
        } catch (err) {
          console.error("[doc] setContent 装载失败,保留上一版可见内容", {
            version: scheduledVersion,
            error: err instanceof Error ? err.message : String(err),
          });
          onToast?.("这份文档里有暂不支持的内容，已先显示上一版。");
        } finally {
          finishApplyingRemoteSoon();
        }
      });
    }
  }, [
    beginApplyingRemote,
    doc,
    editor,
    finishApplyingRemoteSoon,
    onToast,
    presentationRun?.docVersion,
  ]);

  useEffect(() => {
    if (
      !editor ||
      editor.isDestroyed ||
      !onEditorChange ||
      presentationRun ||
      deferBlockIdNormalization ||
      !interactiveEditable
    ) {
      return;
    }
    const targetVersion = doc.version;
    const repairKey = `${docId ?? ""}:${targetVersion}`;
    if (repairedBlockIdVersionRef.current === repairKey) return;

    // 初次 content 与外部 setContent 都已在此 effect 之前排入 microtask；归一事务随后执行，
    // 既能覆盖存量文档，也不会抢在远端正文装载前误扫旧 editor state。
    scheduleMicrotask(() => {
      if (!editor || editor.isDestroyed) return;
      if (latestDocVersionRef.current !== targetVersion) return;
      if (isPresentationApplyingRef.current) return;
      // pendingReview 期间 blockId/PM position 是审阅 decoration 的锚点，绝不在原文上改写；
      // 用户退出审阅回到 editing 后，同一版本会因 defer=false 重新进入本 effect 并完成自愈。
      if (deferBlockIdNormalizationRef.current || !interactiveEditableRef.current) return;
      if (repairedBlockIdVersionRef.current === repairKey) return;

      const repair = createDedupeBlockIdsTransaction(editor.state);
      repairedBlockIdVersionRef.current = repairKey;
      if (!repair) return;

      beginApplyingRemote();
      try {
        editor.view.dispatch(repair);
        const repairedDoc = normalizePmDoc(editor.getJSON());
        // update 监听被 isApplyingRemote 抑制；这里只显式保存一次修复结果，回声由既有
        // pendingSelfDocKeys 识别，不会形成 setContent → dirty-save 循环。
        pendingSelfDocKeysRef.current = pushPendingSelfDocKey(
          pendingSelfDocKeysRef.current,
          JSON.stringify(repairedDoc),
        );
        void Promise.resolve(onEditorChange(repairedDoc)).catch((error: unknown) => {
          repairedBlockIdVersionRef.current = null;
          console.error("[doc] 存量 blockId 自愈保存失败", error);
          onToast?.("文档标识修复未保存，请刷新后重试");
        });
      } finally {
        finishApplyingRemoteSoon();
      }
    });
  }, [
    beginApplyingRemote,
    deferBlockIdNormalization,
    doc.version,
    docId,
    editor,
    finishApplyingRemoteSoon,
    interactiveEditable,
    onEditorChange,
    onToast,
    presentationRun,
  ]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || !presentationRun) {
      return;
    }
    if (presentationRun.docVersion !== doc.version) return;

    let cancelled = false;
    let completed = false;
    const instructions = buildNativeDiffInstructions(presentationRun);
    const timing = planNativeTiming(instructions, undefined, presentationRun.finalDoc);
    let scheduler = createNativeConcurrentState({
      run: presentationRun,
      instructions,
      stepDelayMs: timing.stepDelayMs,
      chunkSize: timing.chunkSize,
      maxDurationMs: timing.totalDurationMs,
    });
    const finalContent = presentationRun.finalDoc ?? doc.pmDoc;
    const finalHtml = viewSectionsToHtml(presentationRun.finalSections);
    const seedHtml = viewSectionsToHtml(buildNativePresentationSeedSections(presentationRun));

    const clearTimers = () => {
      for (const timer of presentationTimersRef.current) {
        clearTimeout(timer);
      }
      presentationTimersRef.current = [];
      if (
        presentationFrameRef.current &&
        typeof window !== "undefined" &&
        typeof window.cancelAnimationFrame === "function"
      ) {
        const frame = presentationFrameRef.current;
        window.cancelAnimationFrame(frame.id);
        presentationFrameRef.current = null;
        frame.resolve(performanceNow());
      }
    };
    const waitFrame = () =>
      new Promise<number>((resolve) => {
        if (
          typeof window !== "undefined" &&
          typeof window.requestAnimationFrame === "function"
        ) {
          const id = window.requestAnimationFrame((time) => {
            if (presentationFrameRef.current?.id === id) {
              presentationFrameRef.current = null;
            }
            resolve(time);
          });
          presentationFrameRef.current = { id, resolve };
          return;
        }

        const timer = setTimeout(() => {
          presentationTimersRef.current = presentationTimersRef.current.filter(
            (item) => item !== timer,
          );
          resolve(performanceNow());
        }, Math.max(16, timing.stepDelayMs));
        presentationTimersRef.current.push(timer);
      });
    const setContentSilently = (content: string | PmDoc) => {
      // 揭示动画逐帧写入:必须同步 setContent 才能保持帧时序(逐字/光标动效)。
      // 这里不在 React render 生命周期里调用(在定时器/动画循环回调内),不触发
      // flushSync 生命周期告警,故不走 microtask 延后(WP-E 的 microtask 只针对
      // 主 doc.version effect 那条同步 setContent 路径)。
      if (!editor || editor.isDestroyed) return;
      beginApplyingRemote();
      try {
        setRemoteEditorContent(editor, content);
        lastVersionRef.current = doc.version;
      } finally {
        finishApplyingRemoteSoon();
      }
    };
    const finishToFinal = () => {
      clearTimers();
      setNativePresentationDecorations(editor, []);
      setContentSilently(finalContent ?? finalHtml);
      const releasePresentation = () => {
        isPresentationApplyingRef.current = false;
        activePresentationRef.current = null;
      };
      scheduleMicrotask(releasePresentation);
    };

    if (updateTimerRef.current) {
      clearTimeout(updateTimerRef.current);
      updateTimerRef.current = null;
    }

    isPresentationApplyingRef.current = true;
    activePresentationRef.current = {
      runId: presentationRun.id,
      skip: () => {
        if (completed) return;
        cancelled = true;
        completed = true;
        finishToFinal();
        onPresentationCancel?.();
      },
    };
    setContentSilently(seedHtml);
    setNativePresentationDecorations(editor, []);

    const instant = shouldUseInstantNativePresentation({
      reducedMotion: presentationReducedMotion,
      coordinateAvailable: canResolveNativePresentationCoordinates(editor, scheduler),
      instructionCount: scheduler.tasks.length,
    });

    const play = async () => {
      try {
        if (instant) {
          completed = true;
          finishToFinal();
          onPresentationFinish?.();
          return;
        }

        const offsetRuntime: NativeEditorOperationRuntime = {
          offsets: new Map(),
          operationOffsets: new Map(),
          charEnters: [],
        };
        let lastFrameAt = performanceNow();
        while (scheduler.phase !== "done") {
          const frameAt = await waitFrame();
          if (cancelled) return;
          const advanced = advanceNativeConcurrentState(
            scheduler,
            Math.max(1, frameAt - lastFrameAt),
          );
          lastFrameAt = frameAt;
          scheduler = advanced.state;
          if (advanced.steps.length > 0) {
            offsetRuntime.charEnters.length = 0;
            applyNativeConcurrentFrame(
              editor,
              advanced.steps,
              offsetRuntime,
            );
          }
        }
        if (cancelled) return;
        completed = true;
        finishToFinal();
        onPresentationFinish?.();
      } catch (error) {
        console.error("[workspace] native presentation failed", error);
        completed = true;
        finishToFinal();
        onPresentationFinish?.();
      }
    };

    void play();

    return () => {
      if (!completed) {
        cancelled = true;
        completed = true;
        finishToFinal();
      }
    };
  }, [
    doc.version,
    beginApplyingRemote,
    editor,
    finishApplyingRemoteSoon,
    onPresentationCancel,
    onPresentationFinish,
    presentationReducedMotion,
    presentationRun,
  ]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || presentationRun || !doc.pmDoc) return;
    const liveDoc = editor.getJSON();
    if (!hasMissingPresentationBlockId(liveDoc)) return;
    if (hasMissingPresentationBlockId(doc.pmDoc)) return;

    // setContent 同步落在 useEffect(commit)窗口会触发 TipTap v3 flushSync 生命周期告警;
    // 延后到 microtask(commit 之后)执行,避开告警,保留 beginApplyingRemote 配对与 isDestroyed 重检。
    // presentationRun 在本 effect 已 early-return 守护,microtask 在下一次 render 前执行,期间不会切到揭示态。
    const targetDoc = doc.pmDoc;
    const targetVersion = doc.version;
    scheduleMicrotask(() => {
      if (!editor || editor.isDestroyed) return;
      // 延后期间状态可能变化(揭示动画起播/外部 setContent 已修好 blockId):microtask 内
      // 重检触发条件仍成立才补写,避免 stale 覆盖(codex 评审指出的理论风险)。
      if (isPresentationApplyingRef.current) return;
      if (!hasMissingPresentationBlockId(editor.getJSON())) return;
      beginApplyingRemote();
      try {
        setRemoteEditorContent(editor, targetDoc);
        lastVersionRef.current = targetVersion;
      } finally {
        finishApplyingRemoteSoon();
      }
    });
  }, [
    beginApplyingRemote,
    doc.pmDoc,
    doc.version,
    editor,
    finishApplyingRemoteSoon,
    presentationRun,
  ]);

  const handleSkipPresentation = useCallback(() => {
    activePresentationRef.current?.skip();
  }, []);

  if (!editor) return null;

  return (
    <div
      className={`native-presentation-shell${presentationRun ? " native-presentation-active" : ""}`}
      data-native-presentation-run-id={presentationRun?.id}
    >
      {presentationRun ? <div className="native-presentation-vignette" aria-hidden="true" /> : null}
      <div className="ws-paper-surface" data-wf="WorkspacePaperSurface">
        <div className="ws-editor-glow" data-wf="WorkspaceEditorGlow" aria-hidden="true" />
        <EditorContent editor={editor} />
        {!presentationRun ? <DocColophon doc={doc} /> : null}
      </div>
      {showPatches && !presentationRun ? (
        <PatchHoverLayer
          editor={editor}
          patchMeta={patchMeta}
          onPatchVerdict={onPatchVerdict}
        />
      ) : null}
      {interactiveEditable && editor ? <BlockHandle editor={editor} onToast={onToast} /> : null}
      {interactiveEditable && editor ? <LinkHoverCard editor={editor} onToast={onToast} /> : null}
      {interactiveEditable && editor && onAiModify ? (
        <TableControls editor={editor} onAiModify={onAiModify} onToast={onToast} />
      ) : null}
      {interactiveEditable && editor ? <TableHeaderOverlay editor={editor} /> : null}
      {interactiveEditable && mathEdit ? (
        <MathEditPopover
          target={mathEdit}
          onSave={saveMathEdit}
          onDelete={deleteMathEdit}
          onClose={closeMathEdit}
        />
      ) : null}
      {/* 右下角「进度 / 跳到最终」HUD 浮层去掉:生成草稿时不再打扰(光标动效已足够表达进度) */}
    </div>
  );
});

function setRemoteEditorContent(editor: Editor, content: string | PmDoc): void {
  editor.chain().setMeta(APPLYING_REMOTE_META, true).setContent(content).run();
}

function useReviewPatchDecorations({
  editor,
  enabled,
  doc,
  suggestions,
  overlayInputs,
  blockPatches,
  applied,
  reviewTargets,
  acceptedPatches,
  rejectedPatches,
  activePatchId,
  activeReviewTargetId,
  revealedPatchIds,
  typedByPatch,
  tableTypedByPatch,
  revealCursors,
}: {
  editor: Editor | null;
  enabled: boolean;
  doc: ViewDocumentSnapshot;
  suggestions?: readonly DocSuggestion[];
  overlayInputs?: readonly PatchOverlayInput[];
  blockPatches?: readonly BlockPatchInput[];
  applied?: readonly AppliedPatch[];
  reviewTargets?: readonly import("../data/protocol").ReviewTarget[];
  acceptedPatches: ReadonlySet<string>;
  rejectedPatches: ReadonlySet<string>;
  activePatchId?: string | null;
  activeReviewTargetId?: string | null;
  revealedPatchIds?: ReadonlySet<string> | null;
  typedByPatch?: ReadonlyMap<string, number> | null;
  tableTypedByPatch?: ReviewTableTypedByPatch | null;
  revealCursors?: ReadonlyMap<string, number> | null;
}) {
  const suggestionsKey = useMemo(
    () => (suggestions ?? []).map((s) => [
      s.id,
      s.status,
      s.anchor.pmFrom,
      s.anchor.pmTo,
      s.preview.deleteText,
      s.preview.insertText,
    ].join(":")).join("|"),
    [suggestions],
  );
  const appliedKey = useMemo(
    () => (applied ?? []).map((patch) => [
      patch.id,
      patch.index,
      patch.kind,
      patch.before,
      patch.after,
    ].join(":")).join("|"),
    [applied],
  );
  const overlayInputsKey = useMemo(
    () => (overlayInputs ?? []).map((input) => [
      input.id,
      input.blockIndex,
      input.range?.start ?? "",
      input.range?.end ?? "",
      input.before,
      input.after,
    ].join(":")).join("|"),
    [overlayInputs],
  );
  const blockPatchesKey = useMemo(
    () => (blockPatches ?? []).map((input) => [
      input.patchId,
      input.op,
      input.anchorBlockId ?? "",
      input.anchorIndex ?? "",
      input.gravity ?? "",
      input.blocks.length,
      input.blockCount ?? "",
    ].join(":")).join("|"),
    [blockPatches],
  );
  const acceptedKey = useMemo(() => setKey(acceptedPatches), [acceptedPatches]);
  const rejectedKey = useMemo(() => setKey(rejectedPatches), [rejectedPatches]);
  const revealedPatchIdsKey = useMemo(
    () => (revealedPatchIds ? setKey(revealedPatchIds) : ""),
    [revealedPatchIds],
  );
  const typedByPatchKey = useMemo(
    () => (typedByPatch ? mapKey(typedByPatch) : ""),
    [typedByPatch],
  );
  const revealCursorsKey = useMemo(
    () => (revealCursors ? mapKey(revealCursors) : ""),
    [revealCursors],
  );
  const tableTypedByPatchKey = useMemo(
    () => nestedMapKey(tableTypedByPatch),
    [tableTypedByPatch],
  );

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (!enabled || !doc.pmDoc) {
      clearPatchDecorations(editor);
      return;
    }
    const { decorations, dropped } = buildPatchDecorations({
      suggestions: suggestions ?? [],
      overlayInputs: overlayInputs ?? [],
      blockPatches: blockPatches ?? [],
      applied: applied ?? [],
      baselineDoc: doc.pmDoc,
      acceptedIds: acceptedPatches,
      rejectedIds: rejectedPatches,
      activePatchId,
      activeReviewTargetId,
      reviewTargets,
      revealedPatchIds,
      typedByPatch,
      revealCursors,
      tableTypedByPatch,
      mountBlockView: mountBlockPatchView,
    });
    if (dropped.length > 0) {
      console.warn(
        `[patch] ${dropped.length} 处改动 decoration 锚点越界、未上屏:`,
        dropped,
      );
    }
    setPatchDecorations(editor, decorations);
    // 不在每次依赖变化时 clear:先 clear→empty 再 set 会让 ProseMirror 销毁全部 widget DOM
    // (经历空集),切换 activePatchId 时满屏红球/绿块重挂闪烁。直接用新 decorations 替换旧集合,
    // ProseMirror 按 widget key 复用未变项,只重建 current 真正变化的一两处。
    // 卸载/换 editor 的清理见下方独立 effect。
  }, [
    editor,
    enabled,
    doc.pmDoc,
    doc.version,
    suggestions,
    suggestionsKey,
    overlayInputs,
    overlayInputsKey,
    blockPatches,
    blockPatchesKey,
    applied,
    appliedKey,
    acceptedPatches,
    acceptedKey,
    rejectedPatches,
    rejectedKey,
    activePatchId,
    activeReviewTargetId,
    reviewTargets,
    revealedPatchIds,
    revealedPatchIdsKey,
    typedByPatch,
    typedByPatchKey,
    revealCursors,
    revealCursorsKey,
    tableTypedByPatch,
    tableTypedByPatchKey,
  ]);

  // 卸载或更换 editor 时才彻底清理 patch decorations;更新期间不清,避免全量重挂闪烁(见上)。
  useEffect(() => {
    return () => {
      if (editor && !editor.isDestroyed) clearPatchDecorations(editor);
    };
  }, [editor]);
}

function setKey(values: ReadonlySet<string>): string {
  return Array.from(values).sort().join(",");
}

function mapKey(values: ReadonlyMap<string, number>): string {
  return Array.from(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join(",");
}

function nestedMapKey(values: ReviewTableTypedByPatch | null | undefined): string {
  if (!values) return "";
  return Array.from(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([patchId, cells]) => `${patchId}[${mapKey(cells)}]`)
    .join("|");
}

export function canResolveNativePresentationCoordinates(
  editor: Editor,
  state: ReturnType<typeof createNativeConcurrentState>,
): boolean {
  if (state.tasks.length === 0) return false;
  try {
    for (const task of state.tasks) {
      for (const operation of task.operations) {
        const at = operation.kind === "deleteText" ? operation.from : operation.at;
        const range = resolveNativeTargetRange(
          editor,
          operation.blockIndex,
          operation.target,
          at,
          at,
        );
        if (!range) return false;
        editor.view.coordsAtPos(range.from);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function performanceNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function scheduleMicrotask(callback: () => void): void {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(callback);
    return;
  }
  setTimeout(callback, 0);
}

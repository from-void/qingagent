import { useEffect } from "react";
import type * as React from "react";
import type { Editor } from "@tiptap/react";
import type { PmDoc } from "@qingagent/pm-schema";
import { BigPlanPanel, isBigPlanQuestionnaireReady } from "./BigPlanPanel";
import { DocInit } from "./DocInit";
import { DocumentSnapshotView } from "./DocumentSnapshotView";
import type { DocumentSnapshotViewHandle, PatchMeta } from "./DocumentSnapshotView";
import { PatchNav } from "./PatchNav";
import { QingLoading } from "./QingLoading";
import { StarterPanel } from "./StarterPanel";
import type { StarterBlankTarget } from "./StarterPanel";
import { WholeDocReviewNav } from "./WholeDocReviewNav";
import { clientPerformanceNow } from "../data/sessionFrameGuards";
import { logClientEvent } from "../data/clientLog";
import type { DocDimensions } from "../data/docDimensions";
import type { NativePresentationRun } from "../data/nativeDiffAnimation";
import type { AiModifyTarget } from "../data/aiModifyTarget";
import type { ReviewTableTypedByPatch } from "../data/tableTypewriter";
import type {
  AppliedPatch,
  AskUserAnswers,
  BlockPatchInput,
  DocSuggestion,
  PatchOverlayInput,
  StreamError,
  ToolCallSpec,
  ViewDocumentSnapshot,
} from "../data/protocol";
import type { ServerStream } from "../data/serverStream";
import type { StarterTemplate } from "../data/starterTemplates";
import type { EditorDocChange } from "../data/docWriteBaseline";
import { canEditDocument, generationDraftHasContent, selectRenderDoc } from "../data/workspacePageView";

function extractAskUser(tc: ToolCallSpec) {
  return tc.body.kind === "askUser" ? tc.body.data : null;
}

interface RightPaneProps {
  dimensions: DocDimensions;
  /** 左侧 agent 是否在推理/生成（streamActive || agentBusy || 乐观发送中）——驱动空文档占位的静止/推理态。 */
  agentReasoning: boolean;
  /** 空引导态点击模板「填充」:把骨架写入空文档(并触发会话/文档惰性创建) */
  onFillTemplate: (template: StarterTemplate) => void;
  /** 空引导态点击标题/正文:创建最小空文档并把光标定位到目标块。 */
  onCreateBlank: (target: StarterBlankTarget) => void;
  doc: ViewDocumentSnapshot | null;
  streamError: StreamError | null;
  generationDraftDoc: ViewDocumentSnapshot | null;
  viewingSnapshotDoc: ViewDocumentSnapshot | null;
  /** 大改(≥70%)走整篇新旧版审,而非内联逐处。 */
  wholeDocReview: boolean;
  wholeDocVersion: "new" | "old";
  /** 候选编辑后的干净新文档(整篇审「新版」直接渲染它)。 */
  editedNewDoc: ViewDocumentSnapshot | null;
  onWholeDocVersionChange: (v: "new" | "old") => void;
  patchesAccepted: Set<string>;
  patchesRejected: Set<string>;
  reviewedCount: number;
  remainingCount: number;
  activePatchIndex: number;
  isReviewSubmitting?: boolean;
  reviewSettlementRetryPending?: boolean;
  visiblePatchCount: number;
  unrenderablePatchCount: number;
  effectiveReview: boolean;
  /** 有待裁决候选；即使正文定位失败，也必须显示提交/放弃入口。 */
  reviewResolutionAvailable: boolean;
  reviewMaterializing: boolean;
  fullpageAsk: ToolCallSpec | null;
  submittingAskUserId?: string | null;
  viewingVersion: number | null;
  docViewRef: React.RefObject<DocumentSnapshotViewHandle>;
  patchMeta: Map<string, PatchMeta>;
  activePatchId: string | null;
  reviewSuggestions?: readonly DocSuggestion[];
  reviewOverlayInputs?: readonly PatchOverlayInput[];
  reviewBlockPatches?: readonly BlockPatchInput[];
  reviewAppliedPatches?: readonly AppliedPatch[];
  reviewTargets?: readonly import("../data/protocol").ReviewTarget[];
  activeReviewTargetId?: string | null;
  revealedPatchIds: ReadonlySet<string> | null;
  revealCursors: ReadonlyMap<string, number>;
  typedByPatch: ReadonlyMap<string, number> | null;
  tableTypedByPatch?: ReviewTableTypedByPatch | null;
  patchRevealing: boolean;
  sessionId: string | null;
  stream: ServerStream | null;
  presentationRun: NativePresentationRun | null;
  presentationReducedMotion: boolean;
  onToast: (msg: string) => void;
  onAiModify: (target: AiModifyTarget) => Promise<boolean>;
  onSubmitPlan: (toolCallId: string, answers: AskUserAnswers) => void;
  onJumpPrev: () => void;
  onJumpNext: () => void;
  onRejectAll: () => void | Promise<void>;
  onAcceptAll?: () => void | Promise<void>;
  onCommit: () => void | Promise<void>;
  onPatchVerdict: (patchId: string, verdict: "accepted" | "rejected") => void;
  onCancelAskUser: (toolCall: ToolCallSpec) => void;
  onCloseViewingVersion: () => void;
  onEditorReady: (editor: Editor | null) => void;
  onEditorContentReady?: (editor: Editor, revision: string) => void;
  onEditorChange: EditorDocChange;
  onPresentationFinish: () => void;
  onPresentationCancel: () => void;
  /** 会话恢复失败时,错误态卡面上「重试」按钮的动作(不给则不渲染按钮)。 */
  onRetryRestore?: () => void;
}

function RightPaneBranchLog({
  branch,
  sessionId,
  docVersion,
  runId,
}: {
  branch: string;
  sessionId: string | null;
  docVersion?: number | null;
  runId?: number | null;
}) {
  useEffect(() => {
    logClientEvent("presentationRun.rightPane_branch", {
      sessionId: sessionId ?? undefined,
      meta: {
        branch,
        performanceNow: clientPerformanceNow(),
        docVersion: docVersion ?? null,
        runId: runId ?? null,
      },
    });
  }, [branch, docVersion, runId, sessionId]);
  return null;
}

export function RightPane({
  dimensions,
  agentReasoning,
  onFillTemplate,
  onCreateBlank,
  doc,
  streamError,
  generationDraftDoc,
  viewingSnapshotDoc,
  wholeDocReview,
  wholeDocVersion,
  editedNewDoc,
  onWholeDocVersionChange,
  patchesAccepted,
  patchesRejected,
  reviewedCount,
  remainingCount,
  activePatchIndex,
  isReviewSubmitting,
  reviewSettlementRetryPending = false,
  visiblePatchCount,
  unrenderablePatchCount,
  effectiveReview,
  reviewResolutionAvailable,
  reviewMaterializing,
  fullpageAsk,
  submittingAskUserId,
  viewingVersion,
  docViewRef,
  patchMeta,
  activePatchId,
  reviewSuggestions = [],
  reviewOverlayInputs = [],
  reviewBlockPatches = [],
  reviewAppliedPatches = [],
  reviewTargets = [],
  activeReviewTargetId,
  revealedPatchIds,
  revealCursors,
  typedByPatch,
  tableTypedByPatch = null,
  patchRevealing,
  sessionId,
  stream,
  presentationRun,
  presentationReducedMotion,
  onToast,
  onAiModify,
  onSubmitPlan,
  onJumpPrev,
  onJumpNext,
  onRejectAll,
  onAcceptAll,
  onCommit,
  onPatchVerdict,
  onCancelAskUser,
  onCloseViewingVersion,
  onEditorReady,
  onEditorContentReady,
  onEditorChange,
  onPresentationFinish,
  onPresentationCancel,
  onRetryRestore,
}: RightPaneProps) {
  if (streamError?.kind === "failed" && !doc && !generationDraftDoc) {
    // 行动入口就在卡面上:曾经写「请点击上方重试」,但上方从来没有重试按钮,
    // 唯一入口是会自动消失的左下角 toast——文案撒谎。现在错误态自带按钮。
    return (
      <DocInit
        mode="error"
        title="恢复失败"
        onRetry={onRetryRestore}
      />
    );
  }
  // 中途反问(inline askUser)时,agent 已 suspend、不在产文:此刻 generationDraft 多半是
  // generation_started 刚建出的【空草稿】(sections 为空),不能拿它当"可渲染文档",否则右侧
  // 会渲染成空白(用户感知为"文档消失")。空草稿一律不算 renderable;askUser 浮层下优先用
  // 已落库的 canonical doc(渲染选择见 selectRenderDoc)。
  const hasRenderableDoc =
    !!doc || generationDraftHasContent(generationDraftDoc) || !!viewingSnapshotDoc;
  if (dimensions.content.kind === "empty" && !fullpageAsk && !hasRenderableDoc) {
    // 左侧 AI 在跑 → 青字 loading;overlay 挂起(如 inline askUser,挂起期 agentBusy=false)→ 同样不给
    // 可交互引导态:此时服务端 editorState=locked,点填充/正文只会被拒(review #1 状态分叉),回青字静候。
    if (agentReasoning || dimensions.overlay !== null) {
      return <QingLoading reasoning={agentReasoning} />;
    }
    return <StarterPanel onFill={onFillTemplate} onCreateBlank={onCreateBlank} />;
  }
  if (dimensions.overlay === "askUser" && fullpageAsk) {
    const askSpec = extractAskUser(fullpageAsk)!;
    const isQuestionnaireStreaming =
      fullpageAsk.status.kind === "running" && !isBigPlanQuestionnaireReady(askSpec);
    return (
      <BigPlanPanel
        toolCallId={fullpageAsk.id}
        spec={askSpec}
        isStreaming={isQuestionnaireStreaming}
        isSubmitting={submittingAskUserId === fullpageAsk.id}
        onSubmit={(_askUserId, answers) => onSubmitPlan(fullpageAsk.id, answers)}
        onAbort={() => onCancelAskUser(fullpageAsk)}
        sessionId={sessionId}
        stream={stream}
        onToast={onToast}
      />
    );
  }
  const viewingHistory = viewingVersion !== null;
  const historyBanner = viewingHistory ? (
    <div className="wf-region" data-wf="HistoryViewingBanner" style={{ marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <span className="font-mono">正在查看历史版本 #{viewingVersion}</span>
      <button type="button" className="wf-btn small ghost" onClick={onCloseViewingVersion}>
        返回当前版本
      </button>
    </div>
  ) : null;
  if (reviewMaterializing && !viewingHistory) {
    return (
      <DocInit
        mode="drafting"
        title="正在整理审阅视图…"
        subtitle="审阅中 · 请稍候"
      />
    );
  }
  const showLock = dimensions.overlay === "imageProgress" && !viewingHistory;
  const reviewMode = dimensions.content.kind === "pendingReview";
  if (dimensions.agentBusy && !showLock && !viewingHistory && !reviewMode) {
    const busyDoc = selectRenderDoc({
      viewingHistory,
      viewingSnapshotDoc,
      doc,
      generationDraftDoc,
      showPatches: false,
      overlay: dimensions.overlay,
    });
    if (!busyDoc) return <QingLoading reasoning />;
    const runMatchesBusyDoc = presentationRun?.docVersion === busyDoc.version;
    if (runMatchesBusyDoc) {
      return (
        <>
          <RightPaneBranchLog
            branch="busy-presentation"
            sessionId={sessionId}
            docVersion={busyDoc.version}
            runId={presentationRun.id}
          />
          <DocumentSnapshotView
            ref={docViewRef}
            doc={busyDoc}
            docId={sessionId}
            editable={true}
            interactiveEditable={false}
            showPatches={false}
            acceptedPatches={new Set()}
            rejectedPatches={new Set()}
            patchMeta={patchMeta}
            activePatchId={activePatchId}
            onEditorReady={onEditorReady}
            onEditorContentReady={onEditorContentReady}
            onEditorChange={onEditorChange}
            onToast={onToast}
            presentationRun={presentationRun}
            presentationReducedMotion={presentationReducedMotion}
            onPresentationFinish={onPresentationFinish}
            onPresentationCancel={onPresentationCancel}
          />
        </>
      );
    }
    return (
      <>
        <RightPaneBranchLog
          branch="busy-readonly"
          sessionId={sessionId}
          docVersion={busyDoc.version}
          runId={presentationRun?.id ?? null}
        />
        <DocumentSnapshotView
          ref={docViewRef}
          doc={busyDoc}
          docId={sessionId}
          editable={true}
          interactiveEditable={false}
          showPatches={false}
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          patchMeta={patchMeta}
          activePatchId={activePatchId}
          onEditorReady={onEditorReady}
          onEditorContentReady={onEditorContentReady}
        />
      </>
    );
  }
  if (viewingHistory && !viewingSnapshotDoc) {
    return (
      <>
        {historyBanner}
        <DocInit
          mode="drafting"
          title="正在加载历史版本…"
          subtitle="历史版本 · 请稍候"
        />
      </>
    );
  }
  if (!viewingHistory && !doc && !generationDraftDoc)
    return <QingLoading reasoning={agentReasoning} />;

  const showPatches = !viewingHistory && effectiveReview;
  const showReviewActions = !viewingHistory && reviewResolutionAvailable;
  const showUnrenderableHint =
    !viewingHistory &&
    !patchRevealing &&
    unrenderablePatchCount > 0 &&
    dimensions.content.kind === "pendingReview";

  // askUser 浮层(中途反问)期间 agent 已挂起,generationDraft 即便存在也只是空/半成品占位,
  // 不能盖掉已落库的 doc。渲染选择收敛进 selectRenderDoc(同一不变量,带单测锁)。
  const renderDoc = selectRenderDoc({
    viewingHistory,
    viewingSnapshotDoc,
    doc,
    // generationDraft 只是生成中的瞬态投影，不是编辑权限来源。终态偶发漏清时，
    // dimensions 已恢复 editable 就必须以 canonical doc 自愈，不能继续展示半成品，
    // 更不能因为一个残留对象把 TipTap 降级成静态快照。
    generationDraftDoc:
      dimensions.editor === "locked" && dimensions.overlay === null
        ? generationDraftDoc
        : null,
    showPatches,
    overlay: dimensions.overlay,
  });
  if (!renderDoc) return <DocInit />;
  const surfaceDoc = showPatches && dimensions.content.kind === "pendingReview" && doc
    ? doc
    : renderDoc;
  const baseEditable = canEditDocument(dimensions, viewingVersion);
  const presentationMatchesRenderDoc = presentationRun?.docVersion === surfaceDoc.version;
  // inline askUser(中途反问)期间 overlay 锁住 → baseEditable=false → 原本会落到静态 .wf-doc 渲染,
  // 而 editing 态下静态文档分支会被隐藏(display:none)→ 右侧整片黑("文档消失")。
  // 修法:askUser 浮层期文档仍挂 TipTap(走和正常 editing 一致、确定可见的渲染路径),
  // 但 interactiveEditable 保持 false(只读,不可编辑)。
  const mountEditableSurface =
    baseEditable ||
    presentationMatchesRenderDoc ||
    dimensions.overlay === "askUser" ||
    dimensions.content.kind === "pendingReview";
  const interactiveEditable = baseEditable && !presentationRun;
  const canInterruptPresentationForEdit =
    baseEditable && presentationMatchesRenderDoc;

  // 大改(≥70%):整篇新旧版审 —— 右侧直接展示选中版本的完整文档(干净,无内联红绿),
  // 底部条换成 [新版‖旧版] 互斥选择器 + [应用新版][退回旧版]。切换带动效、新旧各记滚动位置。
  if (wholeDocReview && !viewingHistory) {
    const shownDoc =
      wholeDocVersion === "old" ? (doc ?? renderDoc) : (editedNewDoc ?? renderDoc);
    const wholeDocReviewScopeKey = [
      sessionId ?? "",
      shownDoc.version,
      remainingCount,
      visiblePatchCount,
    ].join(":");
    return (
      <>
        <WholeDocReviewNav
          reviewScopeKey={wholeDocReviewScopeKey}
          version={wholeDocVersion}
          isSubmitting={isReviewSubmitting}
          onVersionChange={onWholeDocVersionChange}
          onApply={onAcceptAll ?? onCommit}
          onRevert={onRejectAll}
          onToast={onToast}
        />
        <div className="wdr-swap" key={wholeDocVersion}>
          <DocumentSnapshotView
            ref={docViewRef}
            doc={shownDoc}
            docId={sessionId}
            editable={true}
            interactiveEditable={false}
            deferBlockIdNormalization
            showPatches={false}
            acceptedPatches={new Set<string>()}
            rejectedPatches={new Set<string>()}
            patchMeta={patchMeta}
            activePatchId={null}
            onEditorReady={onEditorReady}
            onEditorContentReady={onEditorContentReady}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <RightPaneBranchLog
        branch={presentationRun?.docVersion === renderDoc.version ? "main-presentation" : "main-document"}
        sessionId={sessionId}
        docVersion={surfaceDoc.version}
        runId={presentationRun?.id ?? null}
      />
      {historyBanner}
      {/* 审批条:揭示动画一开始(patchRevealing)就出条并同体平移进来(不再等揭示跑完),
          这样"光标刚开始在正文打字"时条就立刻转移过去。 */}
      {showReviewActions && (
        <PatchNav
          remainingCount={remainingCount}
          totalCount={visiblePatchCount}
          activePatchIndex={activePatchIndex}
          isSubmitting={isReviewSubmitting}
          retryOnly={reviewSettlementRetryPending}
          unrenderableOnly={!showPatches && !reviewSettlementRetryPending}
          onJumpPrev={onJumpPrev}
          onJumpNext={onJumpNext}
          onRejectAll={onRejectAll}
          onCommit={onCommit}
        />
      )}
      {showUnrenderableHint && (
        <div
          className="wf-region"
          data-wf="PatchUnrenderableHint"
          style={{ marginBottom: 10, color: "var(--ink-3)", fontSize: 12.5 }}
        >
          另有 {unrenderablePatchCount} 处改动无法在正文定位，不能逐处查看；仍可提交或放弃整轮候选。
        </div>
      )}
      <DocumentSnapshotView
        ref={docViewRef}
        doc={surfaceDoc}
        docId={sessionId}
        editable={mountEditableSurface}
        interactiveEditable={interactiveEditable}
        canInterruptPresentationForEdit={canInterruptPresentationForEdit}
        deferBlockIdNormalization={dimensions.content.kind === "pendingReview"}
        showPatches={showPatches}
        acceptedPatches={patchesAccepted}
        rejectedPatches={patchesRejected}
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
        onEditorReady={onEditorReady}
        onEditorContentReady={onEditorContentReady}
        onEditorChange={onEditorChange}
        onToast={onToast}
        onAiModify={onAiModify}
        presentationRun={presentationRun}
        presentationReducedMotion={presentationReducedMotion}
        onPresentationFinish={onPresentationFinish}
        onPresentationCancel={onPresentationCancel}
      />
      {/* 右下角字数浮标去掉,改成文末落款区块(DocColophon,在 DocumentSnapshotView 内渲染) */}
    </>
  );
}

// —— doc-topbar 图标(无文字,描线水墨风) ——
function HistoryIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4l3 2" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="M8 7l4-4 4 4" />
      <path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />
    </svg>
  );
}

export { extractAskUser, HistoryIcon, ExportIcon };

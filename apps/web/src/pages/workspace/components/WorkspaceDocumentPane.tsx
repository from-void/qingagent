import { AssetPreview } from "./AssetPreview";
import { DocFindBar } from "./DocFindBar";
import { DocToolbar } from "./DocToolbar";
import { RightPane } from "./RightPane";
import { canUseDocumentEditing } from "../data/reviewActions";
import type { WorkspacePageController } from "../hooks/useWorkspacePageController";

export function WorkspaceDocumentPane({
  controller,
}: {
  controller: WorkspacePageController;
}) {
  const {
    previewExit,
    docScrollRef,
    dim,
    agentActive,
    handleFillTemplate,
    handleCreateBlankDoc,
    state,
    wholeDocReview,
    wholeDocVersion,
    editedNewDoc,
    handleWholeDocVersionChange,
    patchesAccepted,
    patchesRejected,
    reviewedCount,
    remainingPatches,
    activePatchIndex,
    visiblePatchCount,
    unrenderablePatchCount,
    inlinePatchReview,
    awaitingWholeDocReviewMaterial,
    fullpageAsk,
    submittingAskUserId,
    docViewRef,
    patchMeta,
    currentPatchId,
    overlayInputs,
    blockPatchInputs,
    patchPresentation,
    currentReviewTargetId,
    revealedPatchIds,
    revealCursors,
    typedByPatch,
    tableTypedByPatch,
    streamRef,
    effectivePresentationRun,
    reducedMotion,
    showToast,
    handleAiModify,
    handleSubmitPlan,
    handleJumpPrev,
    handleJumpNext,
    handleRejectAll,
    handleAcceptAll,
    handleCommit,
    handlePatchVerdict,
    handleCancelAskUser,
    closeViewingVersion,
    setTiptapEditor,
    handleEditorChange,
    clearPresentationRun,
    findOpen,
    findMode,
    tiptapEditor,
    findInitialQuery,
    setFindOpen,
    setFindInitialQuery,
    setPreviewSource,
    handleEditSummary,
  } = controller;

  return (
    <div
      className={`ws-right${previewExit.source ? " is-previewing" : ""}`}
      ref={docScrollRef}
    >
      <RightPane
        dimensions={dim}
        agentReasoning={agentActive}
        onFillTemplate={handleFillTemplate}
        onCreateBlank={handleCreateBlankDoc}
        doc={state.doc}
        streamError={state.streamError}
        generationDraftDoc={state.generationDraft?.doc ?? null}
        viewingSnapshotDoc={state.viewingSnapshotDoc}
        wholeDocReview={wholeDocReview}
        wholeDocVersion={wholeDocVersion}
        editedNewDoc={editedNewDoc}
        onWholeDocVersionChange={handleWholeDocVersionChange}
        patchesAccepted={patchesAccepted}
        patchesRejected={patchesRejected}
        reviewedCount={reviewedCount}
        remainingCount={remainingPatches}
        activePatchIndex={activePatchIndex}
        visiblePatchCount={visiblePatchCount}
        unrenderablePatchCount={unrenderablePatchCount}
        effectiveReview={inlinePatchReview}
        reviewMaterializing={awaitingWholeDocReviewMaterial}
        fullpageAsk={fullpageAsk}
        submittingAskUserId={submittingAskUserId}
        viewingVersion={state.viewingVersion}
        docViewRef={docViewRef}
        patchMeta={patchMeta}
        activePatchId={currentPatchId}
        reviewSuggestions={state.docDiff?.suggestions ?? []}
        reviewOverlayInputs={overlayInputs}
        reviewBlockPatches={blockPatchInputs}
        reviewAppliedPatches={patchPresentation?.applied ?? []}
        reviewTargets={patchPresentation?.reviewTargets ?? []}
        activeReviewTargetId={currentReviewTargetId}
        revealedPatchIds={revealedPatchIds}
        revealCursors={revealCursors}
        typedByPatch={typedByPatch}
        tableTypedByPatch={tableTypedByPatch}
        patchRevealing={controller.effectivePatchRevealing}
        sessionId={state.sessionId}
        stream={streamRef.current}
        presentationRun={effectivePresentationRun}
        presentationReducedMotion={reducedMotion}
        onToast={showToast}
        onAiModify={handleAiModify}
        onSubmitPlan={handleSubmitPlan}
        onJumpPrev={handleJumpPrev}
        onJumpNext={handleJumpNext}
        onRejectAll={handleRejectAll}
        onAcceptAll={handleAcceptAll}
        onCommit={handleCommit}
        onPatchVerdict={handlePatchVerdict}
        onCancelAskUser={handleCancelAskUser}
        onCloseViewingVersion={closeViewingVersion}
        onEditorReady={setTiptapEditor}
        onEditorChange={handleEditorChange}
        onPresentationFinish={clearPresentationRun}
        onPresentationCancel={clearPresentationRun}
      />
      {findOpen && findMode !== "hidden" && (
        <DocFindBar
          editor={tiptapEditor}
          mode={findMode}
          docVersion={state.doc?.version ?? 0}
          initialQuery={findInitialQuery}
          onClose={() => {
            setFindOpen(false);
            setFindInitialQuery("");
          }}
          onToast={showToast}
        />
      )}
      <DocToolbar
        active={canUseDocumentEditing(
          dim,
          state.viewingVersion,
          effectivePresentationRun,
        )}
        editor={tiptapEditor}
        containerSelector="#view-workspace .ws-right"
        onAiModify={handleAiModify}
        onToast={showToast}
      />
      {previewExit.source && (
        <AssetPreview
          key={previewExit.source.id}
          source={previewExit.source}
          sessionId={state.sessionId}
          onClose={() => setPreviewSource(null)}
          onEditSummary={handleEditSummary}
          summaryEditDisabled={agentActive}
          closing={previewExit.closing}
        />
      )}
    </div>
  );
}

import { pmToPlainText } from "@qingagent/pm-schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnnotationCarousel, buildAnnotationInstruction } from "./AnnotationCarousel";
import { AssetPreview } from "./AssetPreview";
import { DocFindBar } from "./DocFindBar";
import { DocToolbar } from "./DocToolbar";
import { DerivTabBar } from "./derivatives/DerivTabBar";
import { DerivativeGenerateModal } from "./derivatives/DerivativeGenerateModal";
import { DerivativeView } from "./derivatives/DerivativeView";
import {
  DTYPE_REGISTRY,
  type DerivativeDtype,
} from "./derivatives/dtypeRegistry";
import { ExportMenu } from "./ExportMenu";
import {
  buildReviewActionCard,
  buildReviewContext,
  buildReviewQuery,
  REVIEW_META,
  ReviewLaunchModal,
} from "./ReviewLaunchModal";
import { ReviewIcon, ReviewMenu } from "./ReviewMenu";
import { ExportIcon } from "./RightPane";
import { RightPane } from "./RightPane";
import { canUseDocumentEditing } from "../data/reviewActions";
import {
  annotationMutationKey,
  workspaceMutations,
} from "../data/revisionedMutation";
import type { WorkspacePageController } from "../hooks/useWorkspacePageController";
import type { DerivativeItem } from "./derivatives/types";
import type { DerivativeDocument } from "./derivatives/types";

function staleDismissKey(item: DerivativeItem): string {
  return `${item.docId}:${item.currentSourceVersion}`;
}

export function WorkspaceDocumentPane({
  controller,
}: {
  controller: WorkspacePageController;
}) {
  const [dismissedStaleKeys, setDismissedStaleKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [derivativeDocCache, setDerivativeDocCache] = useState<
    Map<string, DerivativeDocument>
  >(() => new Map());
  const derivativeTabRequestRef = useRef(0);
  const isStaleDismissed = useCallback(
    (item: DerivativeItem) => dismissedStaleKeys.has(staleDismissKey(item)),
    [dismissedStaleKeys],
  );
  const dismissStale = useCallback((item: DerivativeItem) => {
    const key = staleDismissKey(item);
    setDismissedStaleKeys((keys) => {
      if (keys.has(key)) return keys;
      return new Set(keys).add(key);
    });
  }, []);
  const {
    title,
    setTitle,
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
    isReviewSubmitting,
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
    markDocumentSurfaceReady,
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
    derivatives,
    activeTab,
    setActiveTab,
    derivativeCreateOpen,
    setDerivativeCreateOpen,
    derivativeCreateDtype,
    setDerivativeCreateDtype,
    derivativeCreating,
    pendingDerivativeGeneration,
    setPendingDerivativeGeneration,
    handleCreateDerivative,
    refreshDerivatives,
    sendDerivativeQuery,
    exportAnchorRef,
    reviewAnchorRef,
    exportDisabledReason,
    derivativeCreateDisabledReason,
    exportMenuOpen,
    setExportMenuOpen,
    reviewMenuOpen,
    setReviewMenuOpen,
    reviewLaunchType,
    setReviewLaunchType,
    flushPendingDocSave,
    getLatestExportPmDoc,
    loadReviewTemplates,
    saveReviewTemplate,
    deleteReviewTemplate,
    selectReviewTemplate,
    loadReviewSupplement,
    saveReviewSupplement,
    loadLexicons,
    loadLexiconEntries,
    chatInputEditorDisabled,
    chatInputRef,
  } = controller;

  useEffect(() => {
    if (
      controller.hydration.phase !== "waiting" ||
      !controller.hydration.documentSeen
    ) {
      return;
    }
    const pane = docScrollRef.current;
    if (!pane) return;
    const markWhenPaintable = () => {
      if (!pane.querySelector(".wf-doc")) return false;
      markDocumentSurfaceReady();
      return true;
    };
    if (markWhenPaintable()) return;
    const observer = new MutationObserver(() => {
      if (!markWhenPaintable()) return;
      observer.disconnect();
    });
    observer.observe(pane, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [
    controller.hydration.documentSeen,
    controller.hydration.phase,
    docScrollRef,
    markDocumentSurfaceReady,
  ]);

  const derivativeActive = activeTab !== "main";
  const translationItems = derivatives.filter(
    (item) => item.dtype === "translate",
  );
  const activeDerivative =
    activeTab === "translate"
      ? translationItems[0]
      : derivatives.find((item) => item.docId === activeTab);
  const activeDerivativeCacheKey =
    state.sessionId && activeDerivative
      ? `${state.sessionId}:${activeDerivative.docId}:${activeDerivative.generatedAt ?? ""}`
      : null;
  const activateDocumentTab = useCallback(
    (nextTab: "main" | string) => {
      const requestId = derivativeTabRequestRef.current + 1;
      derivativeTabRequestRef.current = requestId;
      if (nextTab === "main" || !state.sessionId || !streamRef.current) {
        setActiveTab(nextTab);
        return;
      }
      const target =
        nextTab === "translate"
          ? translationItems[0]
          : derivatives.find((item) => item.docId === nextTab);
      if (!target) return;
      const cacheKey = `${state.sessionId}:${target.docId}:${target.generatedAt ?? ""}`;
      if (
        derivativeDocCache.has(cacheKey) ||
        pendingDerivativeGeneration === target.docId ||
        state.translationGen.has(target.docId)
      ) {
        setActiveTab(nextTab);
        return;
      }

      // 既有衍生稿先取正文再换 tab：网络等待期保留当前稳定纸面，避免先挂空纸再替换。
      void streamRef.current
        .getDerivativeDoc(state.sessionId, target.docId)
        .then((document) => {
          if (
            derivativeTabRequestRef.current !== requestId ||
            document?.meta.docId !== target.docId
          ) {
            return;
          }
          setDerivativeDocCache((current) => {
            const next = new Map(current);
            next.set(cacheKey, document);
            return next;
          });
          setActiveTab(nextTab);
        })
        .catch((error) => {
          if (derivativeTabRequestRef.current !== requestId) return;
          console.error("[workspace] preload derivative tab failed", error);
          showToast("稿件打开失败 · 请重试");
        });
    },
    [
      derivativeDocCache,
      derivatives,
      pendingDerivativeGeneration,
      setActiveTab,
      showToast,
      state.sessionId,
      state.translationGen,
      streamRef,
      translationItems,
    ],
  );

  return (
    <>
      {streamRef.current && state.sessionId ? (
        <DerivativeGenerateModal
          descriptor={DTYPE_REGISTRY[derivativeCreateDtype]}
          sessionId={state.sessionId}
          stream={streamRef.current}
          open={derivativeCreateOpen}
          submitting={derivativeCreating}
          initial={{
            templateId: DTYPE_REGISTRY[derivativeCreateDtype].templates[0]!.id,
            privatePrompt: "",
          }}
          onClose={() => setDerivativeCreateOpen(false)}
          onGenerate={handleCreateDerivative}
        />
      ) : null}
      <div
        className={`ws-right${previewExit.source ? " is-previewing" : ""}`}
        ref={docScrollRef}
      >
        <div
          className="ws-paper-shell"
          data-wf="WorkspacePaperShell"
          aria-hidden="true"
        />
        <div
          className="ws-document-content"
          data-wf="WorkspaceHydrationDocumentContent"
        >
          {dim.content.kind === "empty" && derivatives.length === 0 ? null : (
            <DerivTabBar
              title={title}
              items={derivatives}
              activeTab={activeTab}
              onActivate={activateDocumentTab}
              onCreate={(dtype) => {
                setDerivativeCreateDtype(dtype);
                setDerivativeCreateOpen(true);
              }}
              createDisabledReason={derivativeCreateDisabledReason}
              isStaleDismissed={isStaleDismissed}
              onRename={async (nextTitle) => {
                const previousTitle = title;
                setTitle(nextTitle);
                try {
                  const stream = streamRef.current;
                  if (!stream || !state.sessionId) throw new Error("会话未就绪");
                  await stream.renameSession(state.sessionId, nextTitle);
                } catch (error) {
                  setTitle(previousTitle);
                  console.error("[workspace] rename session failed", error);
                  showToast("标题修改失败 · 请重试");
                }
              }}
            />
          )}

        {!derivativeActive && dim.content.kind !== "empty" ? (
          <div className="ws-docfns" data-wf="WorkspaceDocFunctions">
            <div className="ws-export-anchor" ref={reviewAnchorRef}>
              <button
                type="button"
                className={`ws-docfn-btn${exportDisabledReason ? " is-disabled" : ""}`}
                title={exportDisabledReason ?? "审查"}
                aria-haspopup="menu"
                aria-expanded={reviewMenuOpen}
                onClick={() => {
                  if (!exportDisabledReason) {
                    setReviewMenuOpen((value) => !value);
                  }
                }}
              >
                <ReviewIcon />
              </button>
              {reviewMenuOpen && !exportDisabledReason ? (
                <ReviewMenu
                  anchorRef={reviewAnchorRef}
                  onClose={() => setReviewMenuOpen(false)}
                  onSensitiveReview={() => {
                    setReviewMenuOpen(false);
                    setReviewLaunchType("sensitive");
                  }}
                  onDeaiReview={() => {
                    setReviewMenuOpen(false);
                    setReviewLaunchType("deai");
                  }}
                  onSourceCheck={() => {
                    setReviewMenuOpen(false);
                    setReviewLaunchType("source");
                  }}
                  onConsistencyReview={() => {
                    setReviewMenuOpen(false);
                    setReviewLaunchType("consistency");
                  }}
                  onPrivacyReview={() => {
                    setReviewMenuOpen(false);
                    setReviewLaunchType("privacy");
                  }}
                  onFormatReview={() => {
                    setReviewMenuOpen(false);
                    setReviewLaunchType("format");
                  }}
                  onRoleReview={() => {
                    setReviewMenuOpen(false);
                    setReviewLaunchType("role");
                  }}
                  onCustomReview={() => {
                    setReviewMenuOpen(false);
                    setReviewLaunchType("custom");
                  }}
                />
              ) : null}
            </div>
            <div className="ws-export-anchor" ref={exportAnchorRef}>
              <button
                type="button"
                className={`ws-doc-btn ws-docfn-btn${exportDisabledReason ? " is-disabled" : ""}`}
                title={exportDisabledReason ?? "导出"}
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen}
                aria-disabled={exportDisabledReason ? true : undefined}
                onClick={() => {
                  if (!exportDisabledReason) {
                    setExportMenuOpen((value) => !value);
                  }
                }}
              >
                <ExportIcon />
              </button>
              {exportMenuOpen && !exportDisabledReason ? (
                <ExportMenu
                  anchorRef={exportAnchorRef}
                  onClose={() => setExportMenuOpen(false)}
                  onAction={showToast}
                  flushPendingDocSave={flushPendingDocSave}
                  getLatestPmDoc={getLatestExportPmDoc}
                />
              ) : null}
            </div>
          </div>
        ) : null}

        {activeTab === "main" ? (
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
            isReviewSubmitting={isReviewSubmitting}
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
        ) : state.sessionId && streamRef.current && activeDerivative ? (
          <DerivativeView
            key={
              activeTab === "translate" ? "translate" : activeDerivative.docId
            }
            sessionId={state.sessionId}
            item={activeDerivative}
            initialDocument={
              activeDerivativeCacheKey
                ? derivativeDocCache.get(activeDerivativeCacheKey) ?? null
                : null
            }
            items={activeTab === "translate" ? translationItems : undefined}
            stream={streamRef.current}
            streamActive={agentActive}
            translationGen={state.translationGen}
            generatingInitially={
              pendingDerivativeGeneration === activeDerivative.docId
            }
            onRefresh={async () => {
              setPendingDerivativeGeneration(null);
              await refreshDerivatives();
            }}
            onDeleted={() => {
              if (
                activeDerivative.dtype !== "translate" ||
                translationItems.length <= 1
              ) {
                setActiveTab("main");
              }
              setPendingDerivativeGeneration(null);
              void refreshDerivatives();
              showToast(
                `${DTYPE_REGISTRY[activeDerivative.dtype as DerivativeDtype]?.label ?? "稿件"}已删除`,
              );
            }}
            onToast={showToast}
            onSendQuery={sendDerivativeQuery}
            isStaleDismissed={isStaleDismissed}
            onDismissStale={dismissStale}
          />
        ) : null}

        {activeTab === "main" &&
        dim.content.kind !== "pendingReview" &&
        state.annotationGroups.some((group) => group.status === "reviewing") ? (
          <AnnotationCarousel
            groups={state.annotationGroups}
            editorDom={
              tiptapEditor && !tiptapEditor.isDestroyed
                ? tiptapEditor.view.dom
                : null
            }
            onAccept={(group, suggestion) => {
              if (chatInputEditorDisabled || !chatInputRef.current) {
                showToast("输入框当前不可用,请稍后再接受批注");
                return false;
              }
              const shortTitle = Array.from(group.summary).slice(0, 15).join("");
              const inserted = chatInputRef.current.insertChip({
                kind: "annotation",
                label: `批注·${shortTitle}`,
                text: buildAnnotationInstruction(group, suggestion),
              });
              if (!inserted) {
                showToast("批注标记插入失败,请重试");
                return false;
              }
              controller.dispatchAnnotationGroups(
                state.annotationGroups.map((item) =>
                  item.id === group.id ? { ...item, status: "accepted" } : item,
                ),
              );
              return true;
            }}
            onIgnore={(group, rememberDismissal) => {
              const sessionId = state.sessionId;
              const stream = streamRef.current;
              if (!sessionId || !stream) {
                showToast("连接还没准备好");
                return;
              }
              const snapshot = state.annotationGroups;
              const mutation = workspaceMutations.tryRun(
                annotationMutationKey(sessionId, group.id),
                {
                  capture: () => snapshot,
                  applyOptimistic: () => {
                    controller.dispatchAnnotationGroups(
                      snapshot.map((item) =>
                        item.id === group.id
                          ? { ...item, status: "ignored" }
                          : item,
                      ),
                    );
                  },
                  commit: () =>
                    stream.ignoreAnnotationGroups(sessionId, "item_ignored", {
                      groupIds: [group.id],
                      rememberDismissal,
                    }),
                  rollback: (previous) => {
                    controller.dispatchAnnotationGroups(previous);
                  },
                },
              );
              if (!mutation) return;
              void mutation.promise.catch((error) => {
                console.error("[workspace] ignoreAnnotationGroups failed", error);
                showToast("批注忽略状态保存失败，已恢复");
              });
            }}
          />
        ) : null}

        {reviewLaunchType ? (
          <ReviewLaunchModal
            open
            type={reviewLaunchType}
            documentTitle={title}
            documentText={
              state.doc?.pmDoc ? pmToPlainText(state.doc.pmDoc) : ""
            }
            loadTemplates={loadReviewTemplates}
            saveTemplate={saveReviewTemplate}
            deleteTemplate={deleteReviewTemplate}
            selectTemplate={selectReviewTemplate}
            loadSupplement={loadReviewSupplement}
            saveSupplement={saveReviewSupplement}
            loadLexicons={loadLexicons}
            loadLexiconEntries={loadLexiconEntries}
            onAiDraft={async (intent, abortSignal) => {
              const sessionId = state.sessionId;
              const stream = streamRef.current;
              if (!sessionId || !stream) throw new Error("会话未就绪");
              return stream.draftTemplate(
                {
                  sessionId,
                  scene: {
                    kind: "review",
                    type: reviewLaunchType,
                    label: REVIEW_META[reviewLaunchType].title,
                  },
                  intent,
                },
                abortSignal,
              );
            }}
            onClose={() => setReviewLaunchType(null)}
            onConfirm={(template, supplement, lexicons) => {
              const type = reviewLaunchType;
              setReviewLaunchType(null);
              sendDerivativeQuery(
                buildReviewQuery(type, template, supplement, lexicons),
                buildReviewActionCard(type, template.name, supplement),
                buildReviewContext(type, template),
              );
            }}
          />
        ) : null}
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
          active={
            activeTab === "main" &&
            canUseDocumentEditing(
              dim,
              state.viewingVersion,
              effectivePresentationRun,
            )
          }
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
      </div>
    </>
  );
}

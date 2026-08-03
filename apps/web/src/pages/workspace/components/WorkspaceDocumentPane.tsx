import { pmToPlainText } from "@qingagent/pm-schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WORKSPACE_PAPER_DOM } from "../../../system/workspacePaperGeometry";
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
import { selectTranslationItem } from "./derivatives/translationSelection";
import { prepareEditorDrawioCaches } from "./drawioExportPreparation";
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
import { isCurrentDerivativePrefetch } from "../data/derivativeSessionIsolation";
import { isCurrentSessionTitleRename } from "../data/sessionTitleRename";
import { viewDocumentSyncRevision } from "../data/viewDocHtml";
import { retryDisposedServerStreamOnce } from "../data/serverStream";
import type { WorkspacePageController } from "../hooks/useWorkspacePageController";
import { useWorkspaceEditorSelection } from "../hooks/useWorkspaceEditorSelection";
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
    handleRetryRestore,
    sessionRestoreBlocked,
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
    reviewUiState,
    isReviewSubmitting,
    reviewSettlementRetryPending,
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
    activeTranslationDocId,
    setActiveTranslationDocId,
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
    reviewDisabledReason,
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
    saveLexiconSelection,
    loadLexiconEntries,
    materialParseRows,
    chatInputEditorDisabled,
    chatInputRef,
  } = controller;
  const currentSessionIdRef = useRef(state.sessionId);
  const currentTitleRef = useRef(title);
  const renameGenerationBySessionRef = useRef(new Map<string, number>());
  currentSessionIdRef.current = state.sessionId;
  currentTitleRef.current = title;
  const sourceMaterialAvailable = materialParseRows.some(
    (row) => row.state === "ready",
  );
  // 该缓存只跟踪主稿；衍生稿由 DerivativeView 独立承载，故主稿以 sessionId
  // 作为稳定作用域即可，不会与同会话下的衍生稿互相覆盖。
  const mainSelectionRevision = useMemo(
    () => state.doc ? viewDocumentSyncRevision(state.doc) : null,
    [state.doc],
  );
  const {
    handleEditorReady: handleMainEditorReady,
    handleEditorContentReady: handleMainEditorContentReady,
  } = useWorkspaceEditorSelection(
    state.sessionId,
    setTiptapEditor,
    controller.hydration.sessionId === state.sessionId &&
      controller.hydration.phase === "ready",
    mainSelectionRevision,
  );

  useEffect(() => {
    derivativeTabRequestRef.current += 1;
  }, [state.sessionId]);

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

  const prepareDrawioForExport = useCallback(
    async (onProgress: (current: number, total: number) => void) => {
      if (!tiptapEditor || tiptapEditor.isDestroyed) return;
      await prepareEditorDrawioCaches(tiptapEditor, {
        onProgress,
        onRenderError: (block, error) => {
          console.warn(
            `[workspace] drawio export cache render failed: ${block.blockId}`,
            error,
          );
        },
      });
    },
    [tiptapEditor],
  );

  const derivativeActive = activeTab !== "main";
  const translationItems = derivatives.filter(
    (item) => item.dtype === "translate",
  );
  const activeDerivative =
    activeTab === "translate"
      ? selectTranslationItem(translationItems, activeTranslationDocId)
      : derivatives.find((item) => item.docId === activeTab);
  const activeDerivativeCacheKey =
    state.sessionId && activeDerivative
      ? `${state.sessionId}:${activeDerivative.docId}:${activeDerivative.generatedAt ?? ""}`
      : null;
  const activateDocumentTab = useCallback(
    (nextTab: "main" | string) => {
      const requestId = derivativeTabRequestRef.current + 1;
      derivativeTabRequestRef.current = requestId;
      const requestStream = streamRef.current;
      if (nextTab === "main" || !state.sessionId || !requestStream) {
        setActiveTab(nextTab);
        return;
      }
      const target =
        nextTab === "translate"
          ? selectTranslationItem(translationItems, activeTranslationDocId)
          : derivatives.find((item) => item.docId === nextTab);
      if (!target) return;
      const cacheKey = `${state.sessionId}:${target.docId}:${target.generatedAt ?? ""}`;
      if (
        derivativeDocCache.has(cacheKey) ||
        pendingDerivativeGeneration === target.docId
      ) {
        setActiveTab(nextTab);
        return;
      }

      // 既有衍生稿先取正文再换 tab：网络等待期保留当前稳定纸面，避免先挂空纸再替换。
      const requestSessionId = state.sessionId;
      void retryDisposedServerStreamOnce(
        requestStream,
        () => streamRef.current,
        (stream) => stream.getDerivativeDoc(requestSessionId, target.docId),
      )
        .then((document) => {
          if (!isCurrentDerivativePrefetch({
            currentRequestId: derivativeTabRequestRef.current,
            currentSessionId: currentSessionIdRef.current,
            documentDocId: document?.meta.docId,
            requestDocId: target.docId,
            requestId,
            requestSessionId,
          })) {
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
          if (
            derivativeTabRequestRef.current !== requestId ||
            currentSessionIdRef.current !== requestSessionId
          ) {
            return;
          }
          console.error("[workspace] preload derivative tab failed", error);
          showToast("稿件打开失败 · 请重试");
        });
    },
    [
      derivativeDocCache,
      derivatives,
      activeTranslationDocId,
      pendingDerivativeGeneration,
      setActiveTab,
      showToast,
      state.sessionId,
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
          excludedTargetLanguages={
            derivativeCreateDtype === "translate"
              ? translationItems.map((item) => item.targetLang).filter((language): language is string => Boolean(language))
              : undefined
          }
          onClose={() => setDerivativeCreateOpen(false)}
          onGenerate={handleCreateDerivative}
        />
      ) : null}
      <div
        className={`${WORKSPACE_PAPER_DOM.paperColumnClass}${previewExit.source ? " is-previewing" : ""}`}
        ref={docScrollRef}
      >
        <div
          className={WORKSPACE_PAPER_DOM.paperShellClass}
          data-wf={WORKSPACE_PAPER_DOM.paperShellDataWf}
          aria-hidden="true"
        />
        {sessionRestoreBlocked &&
        (state.streamError?.kind !== "failed" ||
          controller.hydration.phase === "waiting") ? (
          <div
            className="ws-hydration-status"
            data-wf="WorkspaceHydrationStatus"
            role="status"
            aria-live="polite"
          >
            {state.streamError?.kind === "failed"
              ? "会话恢复未完成"
              : "正在恢复会话…"}
          </div>
        ) : null}
        <div
          className={WORKSPACE_PAPER_DOM.documentContentClass}
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
                const requestSessionId = state.sessionId;
                const stream = streamRef.current;
                if (!stream || !requestSessionId) {
                  showToast("标题修改失败 · 请重试");
                  return;
                }
                const previousTitle = currentTitleRef.current;
                const requestGeneration =
                  (renameGenerationBySessionRef.current.get(requestSessionId) ??
                    0) + 1;
                renameGenerationBySessionRef.current.set(
                  requestSessionId,
                  requestGeneration,
                );
                currentTitleRef.current = nextTitle;
                setTitle(nextTitle);
                try {
                  await stream.renameSession(requestSessionId, nextTitle);
                } catch (error) {
                  if (!isCurrentSessionTitleRename({
                    currentGeneration:
                      renameGenerationBySessionRef.current.get(requestSessionId),
                    currentSessionId: currentSessionIdRef.current,
                    currentTitle: currentTitleRef.current,
                    requestGeneration,
                    requestSessionId,
                    requestTitle: nextTitle,
                  })) {
                    return;
                  }
                  currentTitleRef.current = previousTitle;
                  setTitle((currentTitle) =>
                    currentTitle === nextTitle ? previousTitle : currentTitle,
                  );
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
                className={`ws-docfn-btn${reviewDisabledReason ? " is-disabled" : ""}`}
                title={reviewDisabledReason ?? "审查"}
                aria-haspopup="menu"
                aria-expanded={reviewMenuOpen}
                onClick={() => {
                  if (!reviewDisabledReason) {
                    setReviewMenuOpen((value) => !value);
                  }
                }}
              >
                <ReviewIcon />
              </button>
              {reviewMenuOpen && !reviewDisabledReason ? (
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
                aria-label="导出"
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
                  prepareDrawioForExport={prepareDrawioForExport}
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
            onRetryRestore={handleRetryRestore}
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
            reviewSettlementRetryPending={reviewSettlementRetryPending}
            visiblePatchCount={visiblePatchCount}
            unrenderablePatchCount={unrenderablePatchCount}
            effectiveReview={inlinePatchReview || reviewSettlementRetryPending}
            reviewResolutionAvailable={
              reviewUiState.reviewResolutionAvailable ||
              reviewSettlementRetryPending
            }
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
            onEditorReady={handleMainEditorReady}
            onEditorContentReady={handleMainEditorContentReady}
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
            activeDocId={
              activeTab === "translate" ? activeDerivative.docId : undefined
            }
            onActiveDocIdChange={
              activeTab === "translate" ? setActiveTranslationDocId : undefined
            }
            stream={streamRef.current}
            currentStreamRef={streamRef}
            streamActive={agentActive}
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
                showToast("输入框当前不可用，请稍后再回填批注");
                return false;
              }
              const inserted = chatInputRef.current.appendText(
                buildAnnotationInstruction(group, suggestion),
                { separateBlock: true },
              );
              if (!inserted) {
                showToast("批注意见回填失败，请重试");
                return false;
              }
              showToast("已填入修改要求，请点击发送");
              return true;
            }}
            onIgnore={(group) => {
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
            saveLexiconSelection={saveLexiconSelection}
            loadLexiconEntries={loadLexiconEntries}
            sourceMaterialAvailable={sourceMaterialAvailable}
            onAddMaterial={() => {
              setReviewLaunchType(null);
              if (!chatInputRef.current?.openFileMenu()) {
                showToast("素材入口当前不可用，请稍后重试");
              }
            }}
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

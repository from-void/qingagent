import { createPortal } from "react-dom";
import { ContextDebugPill } from "./ContextDebugPill";
import { HumanCursorOverlay } from "./HumanCursorOverlay";
import { HumanCursorTuningPanel } from "./HumanCursorTuningPanel";
import { MorphDebugPanel } from "./MorphDebugPanel";
import { RevealTuningPanel } from "./RevealTuningPanel";
import { WorkspaceTooltip } from "./WorkspaceTooltip";
import type { WorkspacePageController } from "../hooks/useWorkspacePageController";

export function WorkspaceOverlays({
  controller,
}: {
  controller: WorkspacePageController;
}) {
  const {
    editLockHint,
    editLockPortalTarget,
    devToolsOpen,
    reviewUiState,
    inlinePatchReview,
    handleRevealReplay,
    demoBarKind,
    demoBarShown,
    handleMorphKind,
    handleMorphEnter,
    handleMorphReturn,
    setDevToolsOpen,
    state,
    effectivePatchRevealing,
    effectivePresentationRun,
    previewSource,
    docScrollRef,
  } = controller;

  return (
    <>
      {editLockHint && editLockPortalTarget
        ? createPortal(
            <div
              className="ws-edit-lock"
              aria-hidden="true"
              data-wf="WorkspaceEditLockHint"
            >
              <div className="ws-edit-lock-hint">
                <span className="ws-edit-lock-hint-dot" aria-hidden="true" />
                {editLockHint}
              </div>
            </div>,
            editLockPortalTarget,
          )
        : null}
      {devToolsOpen && (
        <>
          <RevealTuningPanel
            canReplay={reviewUiState.canReplayReviewReveal && inlinePatchReview}
            onReplay={handleRevealReplay}
          />
          <MorphDebugPanel
            kind={demoBarKind}
            shown={demoBarShown}
            onKind={handleMorphKind}
            onEnter={handleMorphEnter}
            onReturn={handleMorphReturn}
            onClose={() => setDevToolsOpen(false)}
          />
          <div className="ctx-debug-float">
            <ContextDebugPill sessionId={state.sessionId} />
          </div>
        </>
      )}
      {demoBarShown && demoBarKind === "bigplan" && (
        <div
          className="ws-float-bar"
          data-wf="MorphDemoBar"
          data-morph-demo="1"
        >
          <span className="ws-float-bar-label">
            <span className="ws-float-bar-dot" aria-hidden="true" />
            写作方向
          </span>
          <span className="ws-float-bar-spacer" />
          <button type="button" className="wf-btn primary">
            确认方向
          </button>
          <button type="button" className="wf-btn ghost">
            问我更多
          </button>
          <button type="button" className="wf-btn ghost">
            放弃本轮
          </button>
        </div>
      )}
      {demoBarShown && demoBarKind === "patch" && (
        <div className="patch-nav" data-wf="MorphDemoPatch" data-morph-demo="1">
          <span className="pn-dot" aria-hidden="true" />
          <span className="pn-label">
            修改 · <b>5</b> 处
          </span>
          <button type="button" className="pn-jump">
            <span>↑</span>上一处
          </button>
          <button type="button" className="pn-jump">
            <span>↓</span>下一处
          </button>
          <span style={{ flex: "1 1 auto" }} />
          <button type="button" className="pn-ghost">
            撤销全部
          </button>
          <button type="button" className="pn-commit">
            提交 ↵
          </button>
        </div>
      )}
      <HumanCursorOverlay
        active={
          (effectivePatchRevealing || effectivePresentationRun != null) &&
          !previewSource
        }
        scrollRef={docScrollRef}
      />
      <WorkspaceTooltip />
      {devToolsOpen && (
        <HumanCursorTuningPanel
          canReplay={reviewUiState.canReplayReviewReveal && inlinePatchReview}
          onReplay={handleRevealReplay}
        />
      )}
    </>
  );
}

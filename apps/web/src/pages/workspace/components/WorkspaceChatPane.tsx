import { useEffect, useState } from "react";
import { goConfigureModel } from "../../../system/modelKeyGate";
import { CoachMark } from "../../../system/onboarding/CoachMark";
import { useOnboardingSettings } from "../../../system/onboarding/OnboardingSettingsContext";
import { WORKSPACE_PAPER_DOM } from "../../../system/workspacePaperGeometry";
import { AskUserOverlay } from "./AskUserOverlay";
import { ChatInput } from "./ChatInput";
import { ChatMessageList, shouldShowPreTokenLoading } from "./ChatMessageList";
import { ConfirmOverlay, ConfirmRecordBar } from "./ConfirmOverlay";
import { extractAskUser } from "./RightPane";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { TaskPill } from "./TaskPill";
import type { WorkspacePageController } from "../hooks/useWorkspacePageController";
import { useConfirmCard } from "../hooks/useConfirmCard";

export function WorkspaceChatPane({
  controller,
}: {
  controller: WorkspacePageController;
}) {
  const onboarding = useOnboardingSettings();
  const {
    state,
    effectivePatchRevealing,
    reviewUiState,
    liveHunkKey,
    wholeDocReview,
    wholeDocReviewKeysRef,
    chatScrollRef,
    debugMode,
    inputHandedOff,
    inputMorphRef,
    chatInputEditorDisabled,
    inputContentOut,
    chatInputRef,
    chatInputPlaceholder,
    agentActive,
    chatInputSendEnabledWhenDisabled,
    handleSubmitChat,
    handleCancelActiveStream,
    setPreviewSource,
    handleRemoveMaterial,
    showToast,
    folderSource,
    folderCapability,
    handleAttachFolder,
    handleDetachFolder,
    materialParseRows,
    handleRetryMaterialParse,
    materialPanelOpenSignal,
    hasModelKey,
    modelKeyGate,
    handleBackHome,
    inlineAsk,
    handleCancelAskUser,
    handleSubmitAskUserAnswers,
  } = controller;
  const {
    confirmRecord,
    handleConfirmDecision,
    inlineConfirm,
    decisionError,
    isLiveConfirm,
  } = useConfirmCard({
    debugMode,
    blocked: inputHandedOff || Boolean(inlineAsk),
    sessionId: state.sessionId,
    stream: controller.streamRef.current,
  });
  const inputHidden = inputHandedOff || Boolean(inlineConfirm);
  const editorCoachPending = onboarding.state !== null
    && !onboarding.coachSeen.has("editor-input");
  const [coachReady, setCoachReady] = useState(false);
  useEffect(() => {
    if (inputHidden || controller.hydration.phase === "waiting" || !onboarding.state) {
      setCoachReady(false);
      return;
    }
    const timer = window.setTimeout(() => setCoachReady(true), 420);
    return () => window.clearTimeout(timer);
  }, [controller.hydration.phase, inputHidden, onboarding.state]);

  return (
    <div className={WORKSPACE_PAPER_DOM.chatColumnClass}>
      <div
        className="ws-chat-content"
        data-wf="WorkspaceHydrationChatContent"
      >
        <ChatMessageList
          messages={state.messages}
          turnActive={agentActive}
          streamActive={state.streamActive}
          showLoading={shouldShowPreTokenLoading(
            state.messages,
            state.streamActive,
          )}
          patchRevealing={effectivePatchRevealing}
          livePatchCount={reviewUiState.livePatchCount}
          liveHunkKey={liveHunkKey}
          sessionId={state.sessionId}
          wholeDocReview={wholeDocReview}
          wholeDocReviewKeys={wholeDocReviewKeysRef.current}
          scrollRef={chatScrollRef}
          debugMode={debugMode}
        />
      </div>
      <div className="ws-input-wrap">
        {confirmRecord && !inlineConfirm && (
          <ConfirmRecordBar record={confirmRecord} />
        )}
        <TaskPill todos={state.todos} inputHidden={inputHidden} />
        <ScrollToBottomButton
          scrollRef={chatScrollRef}
          inputHidden={inputHidden}
        />
        <div
          ref={inputMorphRef}
          className={`ws-input-morph${chatInputEditorDisabled ? " is-morph-out" : ""}${inputContentOut ? " is-content-out" : ""}${inputHidden ? " is-morph-hidden" : ""}${inlineConfirm ? " is-confirm-hidden" : ""}`}
        >
          <ChatInput
            ref={chatInputRef}
            placeholder={chatInputPlaceholder}
            disabled={chatInputEditorDisabled}
            agentActive={agentActive}
            sendEnabledWhenDisabled={chatInputSendEnabledWhenDisabled}
            onSubmit={handleSubmitChat}
            showStop={agentActive && !state.externalEditing}
            onStop={handleCancelActiveStream}
            onOpenSkillMenu={() => undefined}
            onPreviewMaterial={setPreviewSource}
            onPreviewFolderFile={setPreviewSource}
            onRemoveMaterial={handleRemoveMaterial}
            onToast={showToast}
            onPanelClose={() => setPreviewSource(null)}
            folderSource={folderSource}
            folderCapability={folderCapability}
            onAttachFolder={handleAttachFolder}
            onDetachFolder={handleDetachFolder}
            materialParseRows={materialParseRows}
            onRetryMaterialParse={handleRetryMaterialParse}
            openMaterialSignal={materialPanelOpenSignal}
            noModelKey={!hasModelKey}
            modelKeyGate={modelKeyGate}
            suppressModelKeyTip={editorCoachPending}
            onConfigureModel={(provider) => goConfigureModel(handleBackHome, provider)}
          />
        </div>
        {inlineAsk && (
          <AskUserOverlay
            spec={extractAskUser(inlineAsk)!}
            onClose={() => handleCancelAskUser(inlineAsk)}
            onSubmit={(answers) =>
              handleSubmitAskUserAnswers(inlineAsk.id, answers, "已提交答案")
            }
            onAbort={() => handleCancelAskUser(inlineAsk)}
          />
        )}
        {inlineConfirm && (
          <ConfirmOverlay
            key={inlineConfirm.id}
            sessionId={state.sessionId}
            spec={inlineConfirm}
            inputBoxRef={inputMorphRef}
            onDecision={handleConfirmDecision}
            submissionError={decisionError}
            waitForResolution={isLiveConfirm}
          />
        )}
        <CoachMark
          id="editor-input"
          anchor={() => inputMorphRef.current}
          visible={coachReady}
          placement="top-start"
          title="告诉青简写什么"
        >
          比如:写一篇 2000 字的公众号文章,主题是慢生活。素材、要求都可以直接说。
        </CoachMark>
      </div>
    </div>
  );
}

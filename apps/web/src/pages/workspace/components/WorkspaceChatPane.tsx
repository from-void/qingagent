import { goConfigureModel } from "../../../system/modelKeyGate";
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
    hasModelKey,
    handleBackHome,
    inlineAsk,
    handleCancelAskUser,
    handleSubmitAskUserAnswers,
  } = controller;
  const { confirmRecord, handleConfirmDecision, inlineConfirm } = useConfirmCard({
    debugMode,
    blocked: inputHandedOff || Boolean(inlineAsk),
    sessionId: state.sessionId,
  });
  const inputHidden = inputHandedOff || Boolean(inlineConfirm);

  return (
    <div className="ws-left">
      <ChatMessageList
        messages={state.messages}
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
            showStop={agentActive}
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
            noModelKey={!hasModelKey}
            onConfigureModel={() => goConfigureModel(handleBackHome)}
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
            spec={inlineConfirm}
            inputBoxRef={inputMorphRef}
            onDecision={handleConfirmDecision}
          />
        )}
      </div>
    </div>
  );
}

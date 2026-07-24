import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Command } from "@qingagent/contract-ts";
import { validateCommand } from "../../../system/validators";
import type { ServerStream } from "../data/serverStream";
import {
  selectPatches,
  type WorkspaceAction,
  type WorkspaceState,
} from "../data/workspaceState";
import {
  buildPatchVerdictCommand,
  buildReviewGroupCommitSelection,
  buildReviewGroupRejectSelection,
  buildReviewOutcome,
  reviewBatchIdFromPatch,
  sendReviewOutcomeFollowup,
} from "../data/reviewActions";
import {
  reviewCommitFramesAppliedCount,
  reviewCommitFramesCommitted,
  reviewCommitFramesConflictCount,
  reviewCommitFramesLeavePendingReview,
  reviewCommitFramesNoop,
} from "../data/pendingDocSave";
import { stepReviewTargetId } from "../data/reviewNavigation";
import type {
  AskUserAnswers,
  ReviewTarget,
  ToolCallSpec,
} from "../data/protocol";
import type { ReviewTableTypedByPatch } from "../data/tableTypewriter";

const GENRE_LABELS: Record<string, string> = {
  prd: "PRD",
  weekly: "周报",
  essay: "公众号文章",
  academic: "学术/创作",
};

export function useWorkspaceReviewActions(input: {
  state: WorkspaceState;
  stateRef: MutableRefObject<WorkspaceState>;
  streamRef: MutableRefObject<ServerStream | null>;
  reviewCloseInFlightRef: MutableRefObject<Promise<void> | null>;
  dispatch: Dispatch<WorkspaceAction>;
  showToast: (message: string, durationMs?: number) => void;
  allReviewPatches: readonly ToolCallSpec[];
  pendingReviewPatches: readonly ToolCallSpec[];
  visibleReviewTargets: readonly ReviewTarget[];
  visibleReviewTargetIds: readonly string[];
  activeReviewTargetId: string | null;
  setActiveReviewTargetId: Dispatch<SetStateAction<string | null>>;
  finalizeReviewTablePatch: (patchId: string) => void;
  setTableTypedByPatch: Dispatch<
    SetStateAction<ReviewTableTypedByPatch | null>
  >;
}) {
  const {
    state,
    stateRef,
    streamRef,
    reviewCloseInFlightRef,
    dispatch,
    showToast,
    allReviewPatches,
    pendingReviewPatches,
    visibleReviewTargets,
    visibleReviewTargetIds,
    activeReviewTargetId,
    setActiveReviewTargetId,
    finalizeReviewTablePatch,
    setTableTypedByPatch,
  } = input;
  const [submittingAskUserId, setSubmittingAskUserId] = useState<string | null>(
    null,
  );
  const askUserMutationIdsRef = useRef(new Set<string>());
  const [, setGoalLabel] = useState<string | null>(null);
  const autoCommitReviewKeyRef = useRef<string | null>(null);
  const reviewSettlementInFlightRef = useRef<Promise<void> | null>(null);
  const [isReviewSubmitting, setIsReviewSubmitting] = useState(false);

  const runReviewSettlement = useCallback(
    (execute: () => Promise<void>): Promise<void> => {
      if (reviewSettlementInFlightRef.current) {
        return reviewSettlementInFlightRef.current;
      }
      setIsReviewSubmitting(true);
      const settlement = Promise.resolve()
        .then(execute)
        .finally(() => {
          if (reviewSettlementInFlightRef.current === settlement) {
            reviewSettlementInFlightRef.current = null;
            setIsReviewSubmitting(false);
          }
        });
      reviewSettlementInFlightRef.current = settlement;
      return settlement;
    },
    [],
  );

  const trackReviewClose = useCallback(
    (closePromise: Promise<void>): Promise<void> => {
      const trackedClosePromise = closePromise.finally(() => {
        if (reviewCloseInFlightRef.current === trackedClosePromise) {
          reviewCloseInFlightRef.current = null;
        }
      });
      reviewCloseInFlightRef.current = trackedClosePromise;
      return trackedClosePromise;
    },
    [],
  );

  const handleRejectAll = useCallback(() => {
    if (stateRef.current.viewingVersion !== null) {
      showToast("正在查看历史版本，先返回当前版本");
      return;
    }
    // Read patches from the ref for the same freshness guarantee
    // as handleCommit — see the comment there for the rationale.
    const currentPatches = selectPatches(stateRef.current);
    const stream = streamRef.current;
    const currentSessionId = stateRef.current.sessionId;
    // "放弃全部"只作用于尚未采纳的候选:已采纳(accepted)的处保留提交,
    // 其余拒绝——否则半采纳后点放弃会把用户确认过的改动一起回滚丢失
    // (e2e-loop-0704 P1)。反馈卡口径(rejectUndecided)与提交口径同源。
    const { acceptReviewBatchIds, rejectReviewBatchIds } =
      buildReviewGroupRejectSelection(currentPatches);
    const reviewOutcome = buildReviewOutcome(currentPatches, {
      rejectUndecided: true,
    });

    setTableTypedByPatch(null);
    dispatch({ kind: "forceUnlockReview" });
    setActiveReviewTargetId(null);
    if (acceptReviewBatchIds.length === 0) showToast("已撤销本轮全部修改");

    if (
      !stream ||
      !currentSessionId ||
      currentPatches.length === 0 ||
      (rejectReviewBatchIds.length === 0 && acceptReviewBatchIds.length === 0)
    )
      return;

    // Cancel any in-flight SSE connections (same rationale as handleCommit).
    stream.stop();

    const send = async () => {
      await stream
        .commitReviewGroups(currentSessionId, {
          acceptReviewBatchIds,
          rejectReviewBatchIds,
        })
        .then((frames) => {
          const commitNoop = reviewCommitFramesNoop(frames);
          const commitSucceeded = reviewCommitFramesCommitted(frames);
          const appliedCount = reviewCommitFramesAppliedCount(frames);
          const conflictCount = reviewCommitFramesConflictCount(frames);
          const commitFailed =
            acceptReviewBatchIds.length > 0 &&
            !commitSucceeded &&
            !commitNoop;
          if (commitFailed) {
            showToast("本次修改未写入，正文保持上一版");
          } else if (acceptReviewBatchIds.length > 0 && !commitNoop) {
            showToast(
              conflictCount !== null && conflictCount > 0
                ? `${appliedCount ?? 0} 处已写入，${conflictCount} 处因文档变化失效 · 撤销其余修改`
                : `已保留已采纳的 ${appliedCount ?? reviewOutcome.acceptedCount} 处 · 撤销其余修改`,
            );
          }
          if (!reviewCommitFramesLeavePendingReview(frames)) {
            dispatch({ kind: "forceUnlockReview" });
            showToast("审阅状态未自动退出，已恢复编辑");
          }
          if (!commitNoop && !commitFailed && (acceptReviewBatchIds.length === 0 || commitSucceeded)) {
            sendReviewOutcomeFollowup(stream, currentSessionId, reviewOutcome);
          }
        });
    };

    const closePromise = send().catch((e) => {
      console.error("[workspace] rejectAll failed", e);
      dispatch({ kind: "forceUnlockReview" });
      showToast("操作失败 · 请重试");
    });
    const trackedClosePromise = closePromise.finally(() => {
      if (reviewCloseInFlightRef.current === trackedClosePromise) {
        reviewCloseInFlightRef.current = null;
      }
    });
    reviewCloseInFlightRef.current = trackedClosePromise;
  }, [showToast]);

  const handleAcceptAll = useCallback((): Promise<void> => {
    if (stateRef.current.viewingVersion !== null) {
      showToast("正在查看历史版本，先返回当前版本");
      return Promise.resolve();
    }
    setTableTypedByPatch(null);
    const currentPatches = selectPatches(stateRef.current);
    const stream = streamRef.current;
    const currentSessionId = stateRef.current.sessionId;
    if (!stream || !currentSessionId || currentPatches.length === 0) {
      showToast("没有改动可提交");
      return Promise.resolve();
    }

    const acceptReviewBatchIds = [
      ...new Set(currentPatches.map(reviewBatchIdFromPatch)),
    ];
    const closePromise = runReviewSettlement(async () => {
      // commitReviewGroups 已走独立 REST，并会自行保持当前 session 的 EventSource。
      // 这里不能 stop：stop 会终止同一工作区的在途保存/恢复并清本地流状态，导致
      // commit 已落库后界面误回空白起稿态，随后把被中断请求的失败冒充成提交失败。
      await stream
        .commitReviewGroups(currentSessionId, { acceptReviewBatchIds })
        .then((frames) => {
          if (!reviewCommitFramesCommitted(frames)) {
            showToast(
              reviewCommitFramesNoop(frames)
                ? "候选已失效，本次未写入；当前候选已保留"
                : "提交未完成 · 候选已保留，请重试",
            );
            return;
          }
          if (!reviewCommitFramesLeavePendingReview(frames)) {
            dispatch({ kind: "forceUnlockReview" });
            showToast("审阅状态未自动退出，已恢复编辑");
          }
        })
        .catch((e) => {
          console.error("[workspace] acceptAll commitReviewGroups failed", e);
          showToast("提交失败 · 候选已保留，请重试");
        });
    });
    return trackReviewClose(closePromise);
  }, [runReviewSettlement, showToast, trackReviewClose]);

  const handleJumpNext = useCallback(() => {
    const allPatchIds = visibleReviewTargetIds;
    if (allPatchIds.length === 0) return;
    const nextId = stepReviewTargetId(
      allPatchIds,
      activeReviewTargetId,
      "next",
    );
    if (!nextId) return;
    setActiveReviewTargetId(nextId);
    const el = document.querySelector(reviewTargetSelector(nextId));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [visibleReviewTargetIds, activeReviewTargetId]);

  const handleJumpPrev = useCallback(() => {
    const allPatchIds = visibleReviewTargetIds;
    if (allPatchIds.length === 0) return;
    const prevId = stepReviewTargetId(
      allPatchIds,
      activeReviewTargetId,
      "previous",
    );
    if (!prevId) return;
    setActiveReviewTargetId(prevId);
    const el = document.querySelector(reviewTargetSelector(prevId));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [visibleReviewTargetIds, activeReviewTargetId]);

  const handlePatchVerdict = useCallback(
    (patchId: string, verdict: "accepted" | "rejected") => {
      if (stateRef.current.viewingVersion !== null) {
        showToast("正在查看历史版本，先返回当前版本");
        return;
      }
      finalizeReviewTablePatch(patchId);
      const command = buildPatchVerdictCommand(
        selectPatches(stateRef.current),
        patchId,
        verdict,
      );
      try {
        validateCommand(command);
      } catch (e) {
        console.error(`[workspace] ${command.kind} validation failed`, e);
        return;
      }
      const stream = streamRef.current;
      if (!stream) return;
      stream.sendCommand(command).catch((e) => {
        console.error(`[workspace] ${command.kind} failed`, e);
        showToast("操作失败 · 请重试");
      });
      showToast(verdict === "accepted" ? "已保留这处改动" : "已取消这处改动");
    },
    [finalizeReviewTablePatch, showToast],
  );

  const handleCommit = useCallback((): Promise<void> => {
    if (stateRef.current.viewingVersion !== null) {
      showToast("正在查看历史版本，先返回当前版本");
      return Promise.resolve();
    }
    // Read patches from the ref to guarantee freshness — the useCallback
    // closure can go stale when React batches state updates from the SSE
    // stream listener (dispatch is called inside an async reader loop,
    // and the re-render that would refresh allReviewPatches may not have
    // committed yet when the user clicks the button).
    const currentPatches = selectPatches(stateRef.current);
    const total = currentPatches.length;
    if (total === 0) {
      showToast("没有改动可提交");
      return Promise.resolve();
    }
    const stream = streamRef.current;
    if (!stream) return Promise.resolve();
    const currentSessionId = stateRef.current.sessionId;
    if (!currentSessionId) {
      showToast("会话未就绪");
      return Promise.resolve();
    }

    const { acceptReviewBatchIds, rejectReviewBatchIds } =
      buildReviewGroupCommitSelection(currentPatches);

    // 在提交前从当前审阅快照归并审核结果（commit 语义:每处 hunk 独立表态）。
    // 提交成功后,若非全量采纳则以用户名义回流给模型。
    const reviewOutcome = buildReviewOutcome(currentPatches);

    const closePromise = runReviewSettlement(async () => {
      await stream
        .commitReviewGroups(currentSessionId, {
          acceptReviewBatchIds,
          rejectReviewBatchIds,
        })
        .then((frames) => {
          if (!reviewCommitFramesCommitted(frames)) {
            showToast(
              reviewCommitFramesNoop(frames)
                ? "候选已失效，本次未写入；当前候选已保留"
                : "提交未完成 · 候选已保留，请重试",
            );
            return;
          }
          // 与 handleAcceptAll / handleRejectAll 对称的兜底(review-loop-0702 lane-B):
          // commit 响应若缺状态转移帧(stale pendingReview),不兜底就永久锁输入。
          // 逐条处理完的 auto-commit 也汇入本路径,该洞影响面比手动提交更大。
          if (!reviewCommitFramesLeavePendingReview(frames)) {
            dispatch({ kind: "forceUnlockReview" });
            showToast("审阅状态未自动退出，已恢复编辑");
          }
          sendReviewOutcomeFollowup(stream, currentSessionId, reviewOutcome);
        })
        .catch((e) => {
          console.error("[workspace] commitReviewGroups failed", e);
          showToast("提交失败 · 候选已保留，请重试");
        });
    });
    return trackReviewClose(closePromise);
  }, [runReviewSettlement, showToast, trackReviewClose]);

  /**
   * 问卷作答统一提交(BigPlan 全页问卷 + 内联反问卡共用):先乐观把 askUser 卡置 done
   * (reducer 会同步清 askUser overlay),立即收起弹层、恢复输入/导出,不等服务端
   * resume 回帧;发送失败按快照回滚(restoreAskUser)。
   * e2e-loop-0704 R1/R12 回归:内联问卷(审核回流追问等)提交后弹层滞留、输入/导出
   * 持续被禁,需手动点"关闭"才恢复——根因是内联路径只发 resumeAskUser 命令、没有
   * BigPlan 路径同款的乐观收口(服务端 resume 后 askUser done 帧要等整轮结束才回)。
   */
  const handleSubmitAskUserAnswers = useCallback(
    (
      toolCallId: string,
      answers: AskUserAnswers,
      successToast: string,
    ): boolean => {
      const current = stateRef.current;
      const originalTc = current.toolCalls.get(toolCallId);
      if (!originalTc) {
        showToast("问卷已不在");
        return false;
      }
      if (!current.sessionId) {
        showToast("会话未就绪");
        return false;
      }
      const stream = streamRef.current;
      if (!stream) {
        showToast("连接还没准备好");
        return false;
      }
      const ownerMsg = current.messages.find((m) =>
        m.parts.some((p) => p.kind === "toolCall" && p.data.id === toolCallId),
      );
      const ownerMsgId = ownerMsg?.id ?? toolCallId;
      const originalOverlay = current.activeOverlay;
      const originalDocState = current.docState;
      const originalAgentBusy = current.agentBusy;
      const optimisticTc: ToolCallSpec = {
        ...originalTc,
        status: { kind: "done" },
        result: { kind: "askUserAnswers", data: answers },
      };
      try {
        validateCommand({
          kind: "resumeAskUser",
          data: { sessionId: current.sessionId, toolCallId, answers },
        });
      } catch (e) {
        console.error("[workspace] resumeAskUser validation failed", e);
        showToast("操作失败，请重试");
        return false;
      }

      setSubmittingAskUserId(toolCallId);
      dispatch({
        kind: "toolCallUpdated",
        data: {
          messageId: ownerMsgId,
          toolCallId,
          spec: optimisticTc,
        },
      });
      stream
        .sendCommand({
          kind: "resumeAskUser",
          data: { sessionId: current.sessionId, toolCallId, answers },
        })
        .catch((e) => {
          console.error("[workspace] resumeAskUser failed", e);
          const latest = stateRef.current.toolCalls.get(toolCallId);
          const stillOptimistic =
            latest?.status.kind === "done" &&
            latest.result?.kind === "askUserAnswers" &&
            latest.result.data === answers;
          if (stillOptimistic) {
            dispatch({
              kind: "restoreAskUser",
              messageId: ownerMsgId,
              toolCall: originalTc,
              overlay: originalOverlay,
              docState: originalDocState,
              agentBusy: originalAgentBusy,
            });
          }
          showToast("提交失败,请重试");
        })
        .finally(() => {
          setSubmittingAskUserId((currentId) =>
            currentId === toolCallId ? null : currentId,
          );
        });

      showToast(successToast);
      return true;
    },
    [showToast],
  );

  const handleSubmitPlan = useCallback(
    (toolCallId: string, answers: AskUserAnswers) => {
      if (
        !handleSubmitAskUserAnswers(toolCallId, answers, "方向已确认，开始写作")
      ) {
        return;
      }
      const genreVal = answers["q-genre"]?.chosen[0];
      if (genreVal) {
        setGoalLabel(GENRE_LABELS[genreVal] ?? genreVal);
      }
    },
    [handleSubmitAskUserAnswers],
  );

  const handleCancelAskUser = useCallback(
    (toolCall: ToolCallSpec) => {
      const current = stateRef.current;
      if (askUserMutationIdsRef.current.has(toolCall.id)) return;
      if (!current.sessionId) {
        showToast("会话未就绪");
        return;
      }
      const originalTc = current.toolCalls.get(toolCall.id);
      if (!originalTc) {
        showToast("问卷已不在");
        return;
      }

      const command: Command = {
        kind: "cancelAskUser",
        data: { sessionId: current.sessionId, toolCallId: toolCall.id },
      };
      try {
        validateCommand(command);
      } catch (e) {
        console.error("[workspace] cancelAskUser validation failed", e);
        showToast("操作失败，请重试");
        return;
      }

      const stream = streamRef.current;
      if (!stream) {
        showToast("连接还没准备好");
        return;
      }

      const ownerMsg = current.messages.find((m) =>
        m.parts.some((p) => p.kind === "toolCall" && p.data.id === toolCall.id),
      );
      const ownerMsgId = ownerMsg?.id ?? toolCall.id;
      const originalOverlay = current.activeOverlay;
      const originalDocState = current.docState;
      const originalAgentBusy = current.agentBusy;
      const optimisticTc: ToolCallSpec = {
        ...originalTc,
        status: {
          kind: "failed",
          data: { retriable: false, reason: "用户已放弃本轮问卷" },
        },
      };

      askUserMutationIdsRef.current.add(toolCall.id);
      setSubmittingAskUserId(toolCall.id);
      dispatch({
        kind: "toolCallUpdated",
        data: {
          messageId: ownerMsgId,
          toolCallId: toolCall.id,
          spec: optimisticTc,
        },
      });
      stream
        .sendCommand(command)
        .then(() => {
          showToast("已放弃本轮");
        })
        .catch((e) => {
          console.error("[workspace] cancelAskUser failed", e);
          const latest = stateRef.current.toolCalls.get(toolCall.id);
          const stillOptimistic =
            latest?.status.kind === "failed" &&
            latest.status.data.reason === "用户已放弃本轮问卷";
          if (stillOptimistic) {
            dispatch({
              kind: "restoreAskUser",
              messageId: ownerMsgId,
              toolCall: originalTc,
              overlay: originalOverlay,
              docState: originalDocState,
              agentBusy: originalAgentBusy,
            });
          }
          showToast("放弃失败 · 问卷已恢复，请重试");
        })
        .finally(() => {
          askUserMutationIdsRef.current.delete(toolCall.id);
          setSubmittingAskUserId((currentId) =>
            currentId === toolCall.id ? null : currentId,
          );
        });
    },
    [showToast],
  );

  const reviewedCount = allReviewPatches.filter(
    (p) => p.status.kind === "accepted" || p.status.kind === "rejected",
  ).length;
  const remainingPatches = pendingReviewPatches.length;
  const currentReviewTarget =
    visibleReviewTargets.find((target) => target.id === activeReviewTargetId) ??
    visibleReviewTargets[0] ??
    null;
  const currentPatchId = currentReviewTarget?.patchId ?? null;
  const currentReviewTargetId = currentReviewTarget?.id ?? null;
  const activePatchIndex = currentReviewTargetId
    ? visibleReviewTargetIds.indexOf(currentReviewTargetId)
    : -1;
  const autoCommitReviewKey = useMemo(
    () =>
      allReviewPatches
        .map(
          (patch) =>
            `${reviewBatchIdFromPatch(patch)}:${patch.id}:${patch.status.kind}`,
        )
        .join("|"),
    [allReviewPatches],
  );
  useEffect(() => {
    if (remainingPatches !== 0 || allReviewPatches.length === 0) {
      autoCommitReviewKeyRef.current = null;
      return;
    }
    const key = `${state.sessionId ?? ""}:${autoCommitReviewKey}`;
    if (autoCommitReviewKeyRef.current === key) return;
    autoCommitReviewKeyRef.current = key;
    handleCommit();
  }, [
    allReviewPatches.length,
    autoCommitReviewKey,
    handleCommit,
    remainingPatches,
    state.sessionId,
  ]);
  return {
    activePatchIndex,
    currentPatchId,
    currentReviewTargetId,
    handleAcceptAll,
    handleCancelAskUser,
    handleCommit,
    handleJumpNext,
    handleJumpPrev,
    handlePatchVerdict,
    handleRejectAll,
    handleSubmitAskUserAnswers,
    handleSubmitPlan,
    isReviewSubmitting,
    remainingPatches,
    reviewedCount,
    submittingAskUserId,
  };
}

function patchIdSelector(patchId: string): string {
  const escape =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape
      : (value: string) => value.replace(/["\\]/g, "\\$&");
  return `[data-patch-id="${escape(patchId)}"]:not(.wf-patch-del)`;
}

function reviewTargetSelector(targetId: string): string {
  const escape =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape
      : (value: string) => value.replace(/["\\]/g, "\\$&");
  return `[data-review-target-id="${escape(targetId)}"],${patchIdSelector(targetId)}`;
}

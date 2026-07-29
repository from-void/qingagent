import type { ContentDocState } from "./protocol";
import type { ActiveOverlay } from "./docDimensions";

export interface ReviewUiStateInput {
  content: ContentDocState;
  overlay: ActiveOverlay;
  hasPatchCalls: boolean;
  visiblePatchCount: number;
  patchRevealing: boolean;
  presentationCount: number;
}

export interface ReviewUiState {
  hasPatchCalls: boolean;
  visiblePatchCount: number;
  hasVisibleReviewPatches: boolean;
  /** 候选可提交/放弃；不依赖正文 diff 能否定位。 */
  reviewResolutionAvailable: boolean;
  /** 坏帧/恢复缺口没有带回候选明细时，至少保留对话重说入口。 */
  pendingReviewChatFallback: boolean;
  effectiveReview: boolean;
  showPatchNav: boolean;
  livePatchCount: number | null;
  showPatches: boolean;
  canReplayReviewReveal: boolean;
}

export function deriveReviewUiState({
  content,
  overlay,
  hasPatchCalls,
  visiblePatchCount,
  patchRevealing,
  presentationCount,
}: ReviewUiStateInput): ReviewUiState {
  const hasVisibleReviewPatches = hasPatchCalls && visiblePatchCount > 0;
  const hasPendingReview = content.kind === "pendingReview";
  const reviewResolutionAvailable = hasPendingReview && hasPatchCalls;
  const effectiveReview =
    content.kind === "pendingReview" &&
    hasVisibleReviewPatches &&
    overlay === null;

  return {
    hasPatchCalls,
    visiblePatchCount,
    hasVisibleReviewPatches,
    reviewResolutionAvailable,
    pendingReviewChatFallback: hasPendingReview && !hasPatchCalls,
    effectiveReview,
    showPatchNav: effectiveReview && !patchRevealing,
    livePatchCount: hasPendingReview && overlay === null ? presentationCount : null,
    showPatches: effectiveReview,
    canReplayReviewReveal: effectiveReview,
  };
}

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
  const effectiveReview =
    content.kind === "pendingReview" &&
    hasVisibleReviewPatches &&
    overlay === null;

  return {
    hasPatchCalls,
    visiblePatchCount,
    hasVisibleReviewPatches,
    effectiveReview,
    showPatchNav: effectiveReview && !patchRevealing,
    livePatchCount: hasPendingReview && overlay === null ? presentationCount : null,
    showPatches: effectiveReview,
    canReplayReviewReveal: effectiveReview,
  };
}

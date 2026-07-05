import { describe, expect, it } from "vitest";
import { getChatInputBlockReason } from "./chatInputBlockReason";
import { DOC_EDITABLE } from "./protocol";
import { deriveReviewUiState } from "./reviewUiState";

function derive(
  overrides: Partial<Parameters<typeof deriveReviewUiState>[0]> = {},
) {
  return deriveReviewUiState({
    content: { kind: "pendingReview" },
    overlay: null,
    hasPatchCalls: false,
    visiblePatchCount: 0,
    patchRevealing: false,
    presentationCount: 0,
    ...overrides,
  });
}

describe("deriveReviewUiState", () => {
  it("pendingReview with no patch calls still exposes force-unlock recovery", () => {
    const state = derive();

    expect(state.effectiveReview).toBe(false);
    expect(state.showPatchNav).toBe(false);
    expect(state.showPatches).toBe(false);
    expect(state.livePatchCount).toBe(0);
    expect(state.showForceUnlock).toBe(true);
    expect(state.canReplayReviewReveal).toBe(false);
  });

  it("review with no visible patches still exposes force-unlock recovery", () => {
    const state = derive({ hasPatchCalls: true, visiblePatchCount: 0 });

    expect(state.hasVisibleReviewPatches).toBe(false);
    expect(state.effectiveReview).toBe(false);
    expect(state.showPatchNav).toBe(false);
    expect(state.showForceUnlock).toBe(true);
    expect(state.livePatchCount).toBe(0);
  });

  it("shows PatchNav for effective review and uses visible patch count", () => {
    const state = derive({
      hasPatchCalls: true,
      visiblePatchCount: 2,
      presentationCount: 2,
    });

    expect(state.effectiveReview).toBe(true);
    expect(state.showPatchNav).toBe(true);
    expect(state.visiblePatchCount).toBe(2);
    expect(state.livePatchCount).toBe(2);
    expect(state.showForceUnlock).toBe(false);
    expect(state.showPatches).toBe(true);
    expect(state.canReplayReviewReveal).toBe(true);
  });

  it("keeps PatchNav hidden during reveal while overlays stay effective", () => {
    const state = derive({
      hasPatchCalls: true,
      visiblePatchCount: 1,
      presentationCount: 1,
      patchRevealing: true,
    });

    expect(state.effectiveReview).toBe(true);
    expect(state.showPatchNav).toBe(false);
    expect(state.showPatches).toBe(true);
  });

  it("pendingReview 但 0 可见 patch 时仍显示逃生入口", () => {
    const state = derive({
      hasPatchCalls: true,
      visiblePatchCount: 0,
      presentationCount: 0,
    });

    expect(state.effectiveReview).toBe(false);
    expect(state.showPatchNav).toBe(false);
    expect(state.showForceUnlock).toBe(true);
    expect(state.livePatchCount).toBe(0);
  });

  it("keeps existing review gates blocked when there is no effective review", () => {
    const state = derive({ hasPatchCalls: true, visiblePatchCount: 0 });

    expect(state.effectiveReview).toBe(false);
    expect(DOC_EDITABLE.pendingReview).toBe(false);
    expect(getChatInputBlockReason({
      content: { kind: "pendingReview" },
      editor: "pendingReview",
      overlay: null,
      agentBusy: false,
    }, false)).not.toBeNull();
  });
});

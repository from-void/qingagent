import { describe, expect, it } from "vitest";
import { getChatInputBlockReason } from "./chatInputBlockReason";
import type { ActiveOverlay, DocDimensions } from "./docDimensions";
import type { ContentDocState, EditorState } from "./protocol";

function dim(
  content: ContentDocState["kind"],
  editor: EditorState,
  overlay: ActiveOverlay = null,
  agentBusy = false,
): DocDimensions {
  return {
    content: { kind: content },
    editor,
    overlay,
    agentBusy,
  };
}

describe("getChatInputBlockReason", () => {
  it.each([
    dim("empty", "empty"),
    dim("editing", "editable"),
  ])("returns null in editable non-overlay states", (input) => {
    expect(getChatInputBlockReason(input, false)).toBeNull();
  });

  it("blocks when askUser disables input", () => {
    expect(getChatInputBlockReason(dim("editing", "editable"), true)).toEqual({
      toast: "请先完成问卷",
      placeholder: "请先完成问卷",
    });
  });

  it("blocks askUser overlay with questionnaire copy", () => {
    expect(getChatInputBlockReason(dim("editing", "locked", "askUser"), false)).toEqual({
      toast: "请先完成问卷",
      placeholder: "请先完成问卷",
    });
  });

  it("blocks pendingReview content with patch resolution guidance", () => {
    expect(getChatInputBlockReason(dim("pendingReview", "pendingReview"), false)).toEqual({
      toast: "请先提交或撤销上方修改，再继续对话",
      placeholder: "先提交或撤销上方修改，再继续对话",
      durationMs: 3500,
    });
  });

  it("allows chat fallback when pendingReview has no resolvable candidate details", () => {
    expect(
      getChatInputBlockReason(
        dim("pendingReview", "pendingReview"),
        false,
        false,
        false,
        false,
      ),
    ).toBeNull();
  });

  it("blocks chat submit while viewing a history snapshot", () => {
    expect(getChatInputBlockReason(dim("editing", "editable"), false, true)).toEqual({
      toast: "正在看历史版本，回到当前版本后可继续对话",
      placeholder: "回到当前版本后可继续对话",
      durationMs: 3500,
    });
  });

  it("does not set a custom toast duration for askUser overlay", () => {
    const input = dim("editing", "locked", "askUser");
    expect(getChatInputBlockReason(input, false)).not.toHaveProperty("durationMs");
  });

  it("does not set a custom toast duration for askUser blocking", () => {
    expect(getChatInputBlockReason(dim("editing", "editable"), true)).not.toHaveProperty(
      "durationMs",
    );
  });

  it.each([
    dim("editing", "locked", "imageProgress"),
    dim("editing", "locked", null, true),
  ])("allows locked agent work as the interrupt-and-resteer channel", (input) => {
    expect(getChatInputBlockReason(input, false)).toBeNull();
  });
});

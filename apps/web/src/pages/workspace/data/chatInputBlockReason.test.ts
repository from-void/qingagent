import { describe, expect, it } from "vitest";
import {
  getChatInputBlockReason,
  sessionRestoreChatInputBlockReason,
} from "./chatInputBlockReason";
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
  it("恢复既有会话期间与失败后都给出不可提交的明确身份", () => {
    expect(sessionRestoreChatInputBlockReason(false)).toEqual({
      toast: "正在恢复会话，请稍候",
      placeholder: "正在恢复会话…",
    });
    expect(sessionRestoreChatInputBlockReason(true)).toEqual({
      toast: "请先重试恢复会话",
      placeholder: "恢复会话后可继续对话",
    });
  });

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

  it("blocks askUser overlay only when a visible questionnaire card is actionable", () => {
    expect(getChatInputBlockReason(dim("editing", "locked", "askUser"), false, false, true)).toEqual({
      toast: "请先完成问卷",
      placeholder: "请先完成问卷",
    });
  });

  it("恢复后 askUser overlay 没有可见卡时默认放开发送", () => {
    expect(
      getChatInputBlockReason(dim("editing", "locked", "askUser"), false),
    ).toBeNull();
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
    expect(getChatInputBlockReason(input, false, false, true)).not.toHaveProperty("durationMs");
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

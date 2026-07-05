import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldForwardEditorUpdate } from "../../data/nativeDiffAnimation";

describe("editorUpdateGuard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not read editor JSON after the editor is destroyed", () => {
    vi.useFakeTimers();
    const editor = new Editor({
      extensions: createQingagentExtensions(),
      content: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [{ type: "paragraph", attrs: { blockId: "block-p" }, content: [{ type: "text", text: "正文" }] }],
      },
    });
    const onEditorChange = vi.fn();
    const getJSON = vi.spyOn(editor, "getJSON");

    setTimeout(() => {
      if (
        !editor.isDestroyed &&
        shouldForwardEditorUpdate({
          isApplyingRemote: false,
          isAnimating: false,
        })
      ) {
        onEditorChange(editor.getJSON());
      }
    }, 400);

    editor.destroy();
    vi.advanceTimersByTime(401);

    expect(getJSON).not.toHaveBeenCalled();
    expect(onEditorChange).not.toHaveBeenCalled();
  });

  it("keeps remote apply and animation updates out of editor change forwarding", () => {
    expect(shouldForwardEditorUpdate({ isApplyingRemote: true, isAnimating: false })).toBe(false);
    expect(shouldForwardEditorUpdate({ isApplyingRemote: false, isAnimating: true })).toBe(false);
    expect(shouldForwardEditorUpdate({ isApplyingRemote: false, isAnimating: false })).toBe(true);
  });
});

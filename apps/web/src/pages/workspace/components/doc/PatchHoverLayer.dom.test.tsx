// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PatchHoverLayer } from "./PatchHoverLayer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PatchHoverLayer 锚点生命周期", () => {
  let editor: Editor | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    editor?.destroy();
    editor = null;
    document.body.innerHTML = "";
  });

  it("滚动时重算位置，裁决前清空浮层", async () => {
    const mounted = await mountLayer();
    editor = mounted.editor;
    root = mounted.root;
    const onPatchVerdict = mounted.onPatchVerdict;
    mounted.anchor.dataset.patchId = "patch-1";
    mounted.anchor.dataset.patchState = "delete";
    let anchorTop = 100;
    mounted.anchor.getBoundingClientRect = () => rect(20, anchorTop, 80, 20);

    await act(async () => {
      mounted.anchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const popup = mounted.workspace.querySelector<HTMLElement>(".patch-hover-popup")!;
    expect(popup.style.top).toBe("90px");

    anchorTop = 220;
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(popup.style.top).toBe("210px");

    anchorTop = 340;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(popup.style.top).toBe("330px");

    await act(async () => {
      popup.querySelector<HTMLButtonElement>(".patch-popup-btn")?.click();
    });
    expect(onPatchVerdict).toHaveBeenCalledWith("patch-1", "rejected");
    expect(mounted.workspace.querySelector(".patch-hover-popup")).toBeNull();
  });

  it("事务发生时发现锚点已脱离 DOM 会立即关闭", async () => {
    const mounted = await mountLayer();
    editor = mounted.editor;
    root = mounted.root;
    mounted.anchor.dataset.patchId = "patch-1";
    mounted.anchor.dataset.patchState = "delete";
    await act(async () => {
      mounted.anchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(mounted.workspace.querySelector(".patch-hover-popup")).not.toBeNull();

    mounted.anchor.remove();
    await act(async () => {
      mounted.emitTransaction();
    });

    expect(mounted.workspace.querySelector(".patch-hover-popup")).toBeNull();
  });
});

async function mountLayer(): Promise<{
  editor: Editor;
  root: Root;
  workspace: HTMLElement;
  anchor: HTMLElement;
  onPatchVerdict: ReturnType<typeof vi.fn>;
  emitTransaction: () => void;
}> {
  const workspace = document.createElement("div");
  workspace.id = "view-workspace";
  const editorElement = document.createElement("div");
  const reactHost = document.createElement("div");
  workspace.append(editorElement, reactHost);
  document.body.appendChild(workspace);
  const anchor = document.createElement("span");
  editorElement.appendChild(anchor);
  const transactionListeners = new Set<() => void>();
  const editor = {
    view: { dom: editorElement },
    on: (event: string, listener: () => void) => {
      if (event === "transaction") transactionListeners.add(listener);
    },
    off: (event: string, listener: () => void) => {
      if (event === "transaction") transactionListeners.delete(listener);
    },
    destroy: vi.fn(),
  } as unknown as Editor;
  const onPatchVerdict = vi.fn();
  const root = createRoot(reactHost);
  await act(async () => {
    root.render(<PatchHoverLayer editor={editor} onPatchVerdict={onPatchVerdict} />);
  });
  return {
    editor,
    root,
    workspace,
    anchor,
    onPatchVerdict,
    emitTransaction: () => transactionListeners.forEach((listener) => listener()),
  };
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

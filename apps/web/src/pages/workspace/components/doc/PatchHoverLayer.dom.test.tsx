// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PatchMeta } from "../../data/patchMeta";
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

  it("替换只从新值绿段打开替换卡，并完整展示原文", async () => {
    const original = `未开启照明${"，需逐项核对原始安全条款".repeat(15)}`;
    const patchMeta = new Map<string, PatchMeta>([[
      "patch-replace",
      { before: original, after: "开启防爆照明", kind: "replace", index: 2 },
    ]]);
    const mounted = await mountLayer(patchMeta);
    editor = mounted.editor;
    root = mounted.root;
    const inserted = document.createElement("span");
    inserted.dataset.patchId = "patch-replace";
    inserted.dataset.patchState = "replace";
    inserted.className = "wf-patch-replace-wrap";
    const greenText = document.createElement("span");
    greenText.className = "wf-patch-ins";
    greenText.textContent = "开启防爆照明";
    inserted.appendChild(greenText);
    mounted.anchor.after(inserted);

    await act(async () => {
      greenText.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const insertPopup = mounted.workspace.querySelector(".patch-hover-popup");
    expect(insertPopup?.textContent).toContain("#2 · 替换");
    expect(insertPopup?.textContent).toContain("原文");
    expect(insertPopup?.querySelector(".patch-popup-original-text")?.textContent).toBe(original);
    expect(insertPopup?.querySelectorAll("button")).toHaveLength(1);
    expect(insertPopup?.querySelector("button")?.textContent).toBe("撤销");
    await act(async () => {
      insertPopup?.querySelector<HTMLButtonElement>("button")?.click();
    });
    expect(mounted.onPatchVerdict).toHaveBeenCalledWith("patch-replace", "rejected");
  });

  it("纯新增绿段打开新增卡并展示新增内容摘要", async () => {
    const patchMeta = new Map<string, PatchMeta>([[
      "patch-insert",
      { before: "", after: "交接前检查照明、护栏与通信设备。", kind: "insert", index: 3 },
    ]]);
    const mounted = await mountLayer(patchMeta);
    editor = mounted.editor;
    root = mounted.root;
    mounted.anchor.dataset.patchId = "patch-insert";
    mounted.anchor.dataset.patchState = "insert";
    mounted.anchor.className = "wf-patch-ins-wrap";
    mounted.anchor.textContent = "交接前检查照明、护栏与通信设备。";

    await act(async () => {
      mounted.anchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    const popup = mounted.workspace.querySelector(".patch-hover-popup");
    expect(popup?.textContent).toContain("#3 · 新增");
    expect(popup?.textContent).toContain("新增内容");
    expect(popup?.textContent).toContain("交接前检查照明、护栏与通信设备。");
    expect(Array.from(popup?.querySelectorAll(".patch-popup-label") ?? [], (node) => node.textContent)).not.toContain("原文");
    expect(popup?.querySelector("button")?.textContent).toBe("撤销");
    await act(async () => {
      popup?.querySelector<HTMLButtonElement>("button")?.click();
    });
    expect(mounted.onPatchVerdict).toHaveBeenCalledWith("patch-insert", "rejected");
  });

  it("granular 局部锚点继续让位且空白命中回落整块卡，避免重复或无反馈", async () => {
    const patchMeta = new Map<string, PatchMeta>([[
      "patch-granular",
      { before: "旧清单", after: "新清单", kind: "replace", index: 4 },
    ]]);
    const mounted = await mountLayer(patchMeta);
    editor = mounted.editor;
    root = mounted.root;
    mounted.anchor.dataset.patchId = "patch-granular";
    mounted.anchor.dataset.patchState = "replace";
    mounted.anchor.className = "wf-blockmark insert is-granular";
    const localTarget = document.createElement("span");
    localTarget.dataset.reviewTargetId = "patch-granular::row-1";
    localTarget.textContent = "局部新值";
    mounted.anchor.appendChild(localTarget);

    await act(async () => {
      localTarget.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(mounted.workspace.querySelector(".patch-hover-popup")).toBeNull();

    await act(async () => {
      mounted.anchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(mounted.workspace.querySelectorAll(".patch-hover-popup")).toHaveLength(1);
    expect(mounted.workspace.querySelector(".patch-hover-popup")?.textContent).toContain("#4 · 替换");

    await act(async () => {
      localTarget.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: mounted.anchor }));
    });
    expect(mounted.workspace.querySelector(".patch-hover-popup")).toBeNull();
  });
});

async function mountLayer(patchMeta?: Map<string, PatchMeta>): Promise<{
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
    root.render(<PatchHoverLayer editor={editor} patchMeta={patchMeta} onPatchVerdict={onPatchVerdict} />);
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

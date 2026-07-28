import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DocDimensions } from "../data/docDimensions";
import { useWorkspaceFind } from "./useWorkspaceFind";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function FindHarness({ dim }: { dim: DocDimensions }) {
  const editorRef = useRef<Editor | null>(null);
  useWorkspaceFind({
    dim,
    viewingVersion: null,
    presentationRun: null,
    editorRef,
  });
  return null;
}

async function render(dim: DocDimensions): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<FindHarness dim={dim} />);
  });
}

function findEvent(): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: "f",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
}

describe("useWorkspaceFind", () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
  });

  it("hidden 模式不接管 Ctrl/Cmd+F，让浏览器原生查找继续处理", async () => {
    await render({
      content: { kind: "editing" },
      editor: "locked",
      overlay: "askUser",
      agentBusy: false,
    });
    const event = findEvent();

    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
  });

  it("可用模式仍接管 Ctrl/Cmd+F 并打开工作区查找", async () => {
    await render({
      content: { kind: "editing" },
      editor: "editable",
      overlay: null,
      agentBusy: false,
    });
    const event = findEvent();

    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });
});

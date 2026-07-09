// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { normalizePmDoc, type PmDoc } from "@qingagent/pm-schema";
import type { DocSuggestion } from "@qingagent/contract-ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentSnapshotView } from "../../components/DocumentSnapshotView";
import { pmDocToViewDocumentSnapshot, type AppliedPatch, type BlockPatchInput, type ViewBlock } from "../../data/protocol";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, source: string) => ({
      svg: `<svg data-mmd="1" data-src="${encodeURIComponent(source)}"><g/></svg>`,
    })),
  },
}));

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  host.id = "view-workspace";
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("审阅态 PM patch decorations", () => {
  it("只读 PM 上屏补丁 decoration 时不改 editor.state.doc", async () => {
    const baselineDoc = paragraphDoc("abcdef");
    const suggestion = docSuggestion("patch-1", 2, 4, "bc", "XY");
    const applied = appliedPatch("patch-1", 1, "replace", "bc", "XY");
    let editor: Editor | null = null;

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)}
          editable
          interactiveEditable={false}
          showPatches
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          reviewSuggestions={[suggestion]}
          reviewAppliedPatches={[applied]}
          patchMeta={new Map([
            ["patch-1", { before: "bc", after: "XY", kind: "replace", index: 1 }],
          ])}
          onEditorReady={(ed) => {
            editor = ed;
          }}
        />,
      );
    });

    await flush();

    expect(editor).not.toBeNull();
    expect(normalizePmDoc(editor!.state.doc.toJSON())).toEqual(normalizePmDoc(baselineDoc));
    expect(host.querySelector(".ProseMirror")).not.toBeNull();
    expect(host.querySelector(".wf-patch-ins")).not.toBeNull();
    expect(host.querySelector(".wf-patch-del")).not.toBeNull();
    expect(host.querySelector(".wf-patch-del-marker .patch-del-cursor")).not.toBeNull();
    expect(host.querySelector('[data-patch-id="patch-1"]')).not.toBeNull();
  });

  it("只读 PM 上屏块级新增 decoration 时渲出待接受块且不改 editor.state.doc", async () => {
    const baselineDoc = twoParagraphDoc();
    const applied = appliedPatch("block-ins", 2, "insert", "", "新增段落");
    let editor: Editor | null = null;

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)}
          editable
          interactiveEditable={false}
          showPatches
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          reviewBlockPatches={[blockPatch("block-ins", "insert", { anchorBlockId: "p-1", gravity: "after" })]}
          reviewAppliedPatches={[applied]}
          patchMeta={new Map([
            ["block-ins", { before: "", after: "新增段落", kind: "insert", index: 2 }],
          ])}
          onEditorReady={(ed) => {
            editor = ed;
          }}
        />,
      );
    });

    await flush();

    expect(editor).not.toBeNull();
    expect(normalizePmDoc(editor!.state.doc.toJSON())).toEqual(normalizePmDoc(baselineDoc));
    const inserted = host.querySelector('[data-patch-id="block-ins"].wf-blockmark.insert') as HTMLElement | null;
    expect(inserted).not.toBeNull();
    expect(inserted?.querySelector(".wf-patch-ins p")?.textContent).toBe("新增段落");
  });

  it("只读 PM 上屏块级删除 decoration 时标记基线整块并保留原文", async () => {
    const baselineDoc = twoParagraphDoc();
    const applied = appliedPatch("block-del", 3, "delete", "第二段", "");

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)}
          editable
          interactiveEditable={false}
          showPatches
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          reviewBlockPatches={[blockPatch("block-del", "delete", { anchorBlockId: "p-2" })]}
          reviewAppliedPatches={[applied]}
          patchMeta={new Map([
            ["block-del", { before: "第二段", after: "", kind: "delete", index: 3 }],
          ])}
        />,
      );
    });

    await flush();

    const deleted = host.querySelector('[data-patch-id="block-del"].wf-blockmark.delete') as HTMLElement | null;
    expect(deleted).not.toBeNull();
    expect(deleted?.textContent).toContain("第二段");
    expect(host.querySelector('[data-patch-id="block-del"].wf-blockmark-del .wf-blockmark-del-line')).not.toBeNull();
  });

  it("只读 PM 上屏块级替换 decoration 时同时渲出旧块标记和新块 widget", async () => {
    const baselineDoc = twoParagraphDoc();
    const applied = appliedPatch("block-rep", 4, "replace", "第一段", "新增段落");

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)}
          editable
          interactiveEditable={false}
          showPatches
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          reviewBlockPatches={[blockPatch("block-rep", "replace", { anchorBlockId: "p-1" })]}
          reviewAppliedPatches={[applied]}
          patchMeta={new Map([
            ["block-rep", { before: "第一段", after: "新增段落", kind: "replace", index: 4 }],
          ])}
        />,
      );
    });

    await flush();

    expect(host.querySelector('[data-patch-id="block-rep"].wf-blockmark.delete')).not.toBeNull();
    const inserted = host.querySelector('[data-patch-id="block-rep"].wf-blockmark.insert') as HTMLElement | null;
    expect(inserted).not.toBeNull();
    expect(inserted?.dataset.patchState).toBe("replace");
    expect(inserted?.querySelector(".wf-patch-ins p")?.textContent).toBe("新增段落");
  });
});

async function flush(times = 6) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function paragraphDoc(text: string): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "p-1" },
        content: [{ type: "text", text }],
      },
    ],
  } as PmDoc;
}

function twoParagraphDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "p-1" },
        content: [{ type: "text", text: "第一段" }],
      },
      {
        type: "paragraph",
        attrs: { blockId: "p-2" },
        content: [{ type: "text", text: "第二段" }],
      },
    ],
  } as PmDoc;
}

function docSuggestion(
  id: string,
  pmFrom: number,
  pmTo: number,
  deleteText: string,
  insertText: string,
): DocSuggestion {
  return {
    id,
    docId: "doc-1",
    baseVersion: 1,
    baseSchemaVersion: 1,
    status: "reviewing",
    anchor: {
      blockId: "p-1",
      pmFrom,
      pmTo,
      quote: deleteText,
      textHash: "hash",
    },
    patch: {
      kind: "prosemirror_steps",
      steps: [{ stepType: "replace", from: pmFrom, to: pmTo }],
    },
    preview: { deleteText, insertText },
    summary: "替换文字",
  };
}

function appliedPatch(
  id: string,
  index: number,
  kind: AppliedPatch["kind"],
  before: string,
  after: string,
): AppliedPatch {
  return {
    id,
    reviewBatchId: id,
    groupMode: "independent",
    before,
    after,
    kind,
    index,
  };
}

const insertedBlock: ViewBlock = {
  kind: "p",
  blockId: "p-new",
  spans: [{ kind: "text", text: "新增段落" }],
};

function blockPatch(
  patchId: string,
  op: BlockPatchInput["op"],
  overrides: Partial<BlockPatchInput> = {},
): BlockPatchInput {
  return {
    patchId,
    op,
    anchorBlockId: "p-1",
    blocks: [insertedBlock],
    blockCount: 1,
    ...overrides,
  };
}

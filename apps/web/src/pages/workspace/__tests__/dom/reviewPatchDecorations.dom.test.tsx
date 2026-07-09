// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { normalizePmDoc, type PmDoc } from "@qingagent/pm-schema";
import type { DocSuggestion } from "@qingagent/contract-ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentSnapshotView } from "../../components/DocumentSnapshotView";
import { pmDocToViewDocumentSnapshot, type AppliedPatch } from "../../data/protocol";

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

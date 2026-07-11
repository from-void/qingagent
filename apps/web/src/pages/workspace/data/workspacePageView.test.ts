import { describe, expect, it } from "vitest";
import type { ToolCallSpec, ViewDocumentSnapshot } from "./protocol";
import type { DocDimensions } from "./docDimensions";
import {
  buildCancelStreamCommands,
  canEditDocument,
  generationDraftHasContent,
  selectFullpageAsk,
  selectRenderDoc,
  workspaceDataAttrs,
  workspaceHashWithViewingVersion,
  workspaceHistorySnapshotUrl,
  workspaceSessionIdFromHash,
  workspaceViewingVersionFromHash,
  workspaceViewingVersionIdFromHash,
  workspaceVisualState,
} from "./workspacePageView";

function snapshot(id: string, sectionCount: number): ViewDocumentSnapshot {
  return {
    version: 1,
    ts: "2026-06-20T00:00:00.000Z",
    sections: Array.from({ length: sectionCount }, (_, i) => ({
      kind: "p" as const,
      blockId: `${id}-b${i}`,
      spans: [{ kind: "text" as const, text: `${id} 段落${i}` }],
    })),
  };
}

function dim(overrides: Partial<DocDimensions>): DocDimensions {
  return {
    content: { kind: "editing" },
    editor: "editable",
    overlay: null,
    agentBusy: false,
    ...overrides,
  };
}

function askUser(mode: "fullpage" | "overlay"): ToolCallSpec {
  return {
    id: `ask-${mode}`,
    name: "askUser",
    render: { kind: "chatInline" },
    status: { kind: "pending" },
    body: {
      kind: "askUser",
      data: {
        id: "ask",
        mode: { kind: mode },
        purpose: null,
        source: null,
        rationale: null,
        questions: [],
      },
    },
    result: null,
  };
}

describe("workspace page R3 view derivations", () => {
  it("selects fullpage askUser only from askUser overlay", () => {
    const fullpage = askUser("fullpage");

    expect(selectFullpageAsk(dim({ overlay: null }), fullpage)).toBeNull();
    expect(selectFullpageAsk(dim({ overlay: "askUser", editor: "locked" }), fullpage)?.id).toBe(
      "ask-fullpage",
    );
    expect(selectFullpageAsk(dim({ overlay: "askUser", editor: "locked" }), askUser("overlay"))).toBeNull();
  });

  it("generationDraftHasContent treats empty (sections=[]) draft as no content", () => {
    expect(generationDraftHasContent(null)).toBe(false);
    expect(generationDraftHasContent(snapshot("draft", 0))).toBe(false);
    expect(generationDraftHasContent(snapshot("draft", 3))).toBe(true);
  });

  it("selectRenderDoc keeps canonical doc during askUser even with an empty generation draft (problem 2 regression)", () => {
    const doc = snapshot("doc", 11);
    const emptyDraft = snapshot("draft", 0);
    // 中途反问:overlay=askUser + 空草稿。必须渲染 canonical doc,绝不渲染空草稿(=文档消失)。
    const rendered = selectRenderDoc({
      viewingHistory: false,
      viewingSnapshotDoc: null,
      doc,
      generationDraftDoc: emptyDraft,
      showPatches: false,
      overlay: "askUser",
    });
    expect(rendered).toBe(doc);
    expect(rendered?.sections.length).toBe(11);
  });

  it("selectRenderDoc never prefers an empty draft over the doc even outside askUser", () => {
    const doc = snapshot("doc", 5);
    const emptyDraft = snapshot("draft", 0);
    expect(
      selectRenderDoc({
        viewingHistory: false,
        viewingSnapshotDoc: null,
        doc,
        generationDraftDoc: emptyDraft,
        showPatches: false,
        overlay: null,
      }),
    ).toBe(doc);
  });

  it("selectRenderDoc prefers a non-empty generation draft while actively generating (overlay null)", () => {
    const doc = snapshot("doc", 5);
    const draft = snapshot("draft", 2);
    expect(
      selectRenderDoc({
        viewingHistory: false,
        viewingSnapshotDoc: null,
        doc,
        generationDraftDoc: draft,
        showPatches: false,
        overlay: null,
      }),
    ).toBe(draft);
  });

  it("selectRenderDoc still shows the doc (not a non-empty draft) while askUser overlay is up", () => {
    const doc = snapshot("doc", 5);
    const draft = snapshot("draft", 2);
    // 反问浮层期间即便草稿有内容,也优先 canonical doc(挂起态不应展示半成品草稿)。
    expect(
      selectRenderDoc({
        viewingHistory: false,
        viewingSnapshotDoc: null,
        doc,
        generationDraftDoc: draft,
        showPatches: false,
        overlay: "askUser",
      }),
    ).toBe(doc);
  });

  it("maps workspace visual state from editor and overlay dimensions", () => {
    expect(workspaceVisualState(dim({ content: { kind: "empty" }, editor: "empty" }))).toBe("idle");
    expect(workspaceVisualState(dim({ editor: "editable" }))).toBe("editing");
    expect(workspaceVisualState(dim({ editor: "locked", overlay: "askUser" }))).toBe("bigplan");
    expect(workspaceVisualState(dim({ editor: "locked", agentBusy: true }))).toBe("running");
    expect(workspaceVisualState(dim({ content: { kind: "pendingReview" }, editor: "pendingReview" }))).toBe("running");
  });

  it("emits data-content/data-tool state hooks", () => {
    expect(workspaceDataAttrs(dim({ editor: "editable" }))).toEqual({
      content: "editing",
      tool: "none",
    });
    expect(workspaceDataAttrs(dim({ editor: "locked", overlay: "askUser" }))).toEqual({
      content: "editing",
      tool: "askUser",
    });
    expect(workspaceDataAttrs(dim({ editor: "locked", agentBusy: true }))).toEqual({
      content: "editing",
      tool: "agentBusy",
    });
    expect(workspaceDataAttrs(dim({ content: { kind: "pendingReview" }, editor: "pendingReview" }))).toEqual({
      content: "pendingReview",
      tool: "none",
    });
  });

  it("uses viewingVersion as a read-only guard without changing editor/content", () => {
    const editable = dim({ editor: "editable" });

    expect(canEditDocument(editable, null)).toBe(true);
    expect(canEditDocument(editable, 2)).toBe(false);
  });

  it("keeps the editor locked while patch review is pending", () => {
    expect(canEditDocument(dim({ content: { kind: "pendingReview" }, editor: "pendingReview" }), null)).toBe(false);
  });

  it("builds one cancelStream command per active stream id", () => {
    expect(buildCancelStreamCommands(["s-1", "s-2"])).toEqual([
      { kind: "cancelStream", data: { streamId: "s-1" } },
      { kind: "cancelStream", data: { streamId: "s-2" } },
    ]);
  });

  it("parses and clears history viewing from the workspace hash without touching other params", () => {
    const hash = "#/workspace?session=abc&viewingVersion=4;modal-import";

    expect(workspaceViewingVersionFromHash(hash)).toBe(4);
    expect(workspaceSessionIdFromHash(hash)).toBe("abc");
    expect(workspaceViewingVersionIdFromHash("#/workspace?session=abc&viewingVersion=4&viewingVersionId=v4;modal-import")).toBe("v4");
    expect(workspaceHashWithViewingVersion("#/workspace?session=abc&viewingVersion=4&viewingVersionId=v4", null)).toBe("#/workspace?session=abc");
    expect(workspaceHashWithViewingVersion("#/workspace?session=abc", 6, "version-6")).toBe(
      "#/workspace?session=abc&viewingVersion=6&viewingVersionId=version-6",
    );
    expect(workspaceHistorySnapshotUrl("version / 6", "session-a")).toBe(
      "/api/v1/history/version%20%2F%206?sessionId=session-a",
    );
  });
});

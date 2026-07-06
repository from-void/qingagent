// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PmBlockNode } from "@qingagent/pm-schema";
import type { ViewDocumentSnapshot } from "../../data/protocol";
import { DocumentSnapshotView, type PatchMeta } from "../../components/DocumentSnapshotView";

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
});

function renderDoc(doc: ViewDocumentSnapshot) {
  const patchMeta = new Map<string, PatchMeta>([
    ["rep-list", { before: "保留\n旧行\n删掉", after: "保留\n新行\n新增", kind: "replace", index: 1 }],
    ["rep-task", { before: "[x] 梳理需求\n[ ] 评审纪要", after: "[x] 梳理需求\n[x] 评审纪要", kind: "replace", index: 2 }],
  ]);
  act(() => {
    root.render(
      <DocumentSnapshotView
        doc={doc}
        editable={false}
        showPatches
        acceptedPatches={new Set()}
        rejectedPatches={new Set()}
        patchMeta={patchMeta}
      />,
    );
  });
}

describe("列表 replace 三态渲染", () => {
  it("列表 replace 收敛为单一替换态,不再展开 changed/removed/added 行混合态", () => {
    renderDoc({
      version: 1,
      ts: "t",
      sections: [
        {
          kind: "list",
          ordered: false,
          items: ["保留", "新行", "新增"],
          blockPatch: {
            patchId: "rep-list",
            op: "replace",
            beforeBlock: { kind: "list", ordered: false, items: ["保留", "旧行", "删掉"] },
          },
          rowDiff: [
            { status: "same", spans: [{ kind: "text", text: "保留" }] },
            {
              status: "changed",
              oldText: "旧行",
              spans: [{ kind: "patchIns", text: "新", patchId: "rep-list" }, { kind: "text", text: "行" }],
            },
            { status: "removed", oldText: "删掉" },
            { status: "added", spans: [{ kind: "patchIns", text: "新增", patchId: "rep-list" }] },
          ],
        },
      ],
    });

    const replace = host.querySelector('[data-patch-state="replace"].wf-patch-replace-wrap') as HTMLElement;
    expect(replace).not.toBeNull();
    expect(host.querySelector("[data-row-status]")).toBeNull();
    expect(host.querySelector(".row-del")).toBeNull();
    expect(host.querySelector(".wf-patch-ins-wrap")).toBeNull();
    expect(replace.textContent).toContain("新行");
    expect(replace.textContent).toContain("新增");

    const popup = replace.querySelector(".patch-hover-popup") as HTMLElement;
    expect(popup.classList.contains("is-visible")).toBe(false);
    act(() => {
      replace.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    expect(popup.classList.contains("is-visible")).toBe(true);
    expect(popup.textContent).toContain("原文");
    expect(popup.textContent).toContain("旧行");
    expect(popup.textContent).toContain("删掉");
  });

  it("taskList replace 保留真实复选框,不再渲染勾选变更绿圈子态", () => {
    const taskNode: PmBlockNode = {
      type: "taskList",
      attrs: { blockId: "tasks-1" },
      content: [
        {
          type: "taskItem",
          attrs: { blockId: "task-1", checked: true },
          content: [{ type: "paragraph", attrs: { blockId: "task-p-1" }, content: [{ type: "text", text: "梳理需求" }] }],
        },
        {
          type: "taskItem",
          attrs: { blockId: "task-2", checked: true },
          content: [{ type: "paragraph", attrs: { blockId: "task-p-2" }, content: [{ type: "text", text: "评审纪要" }] }],
        },
      ],
    } as PmBlockNode;

    renderDoc({
      version: 1,
      ts: "t",
      sections: [
        {
          kind: "taskList",
          node: taskNode,
          text: "[x] 梳理需求\n[x] 评审纪要",
          blockPatch: {
            patchId: "rep-task",
            op: "replace",
            beforeBlock: { kind: "taskList", node: taskNode, text: "[x] 梳理需求\n[ ] 评审纪要" },
          },
          rowDiff: [
            { status: "same", spans: [{ kind: "text", text: "梳理需求" }], checked: true },
            {
              status: "changed",
              spans: [{ kind: "text", text: "评审纪要" }],
              oldText: "评审纪要",
              checked: true,
              checkedChanged: true,
            },
          ],
        },
      ],
    });

    const replace = host.querySelector('[data-patch-state="replace"].wf-patch-replace-wrap') as HTMLElement;
    expect(replace).not.toBeNull();
    const checkboxes = [...host.querySelectorAll('input[type="checkbox"]')]
      .filter((checkbox) => !checkbox.closest(".patch-hover-popup"));
    expect(checkboxes).toHaveLength(2);
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(true);
    expect(host.querySelector("[data-row-status]")).toBeNull();
    expect(host.querySelector("input.cb-changed")).toBeNull();
  });
});

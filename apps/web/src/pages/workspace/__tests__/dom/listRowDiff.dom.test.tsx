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

describe("列表行级 diff 渲染", () => {
  it("same 行不标绿,changed 行有绿色词级标记和 hover,removed 行折叠红线", () => {
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

    expect(host.querySelector('[data-row-status="same"] .wf-patch-ins')).toBeNull();
    const changed = host.querySelector('[data-row-status="changed"] .wf-patch-ins');
    expect(changed?.textContent).toBe("新");

    const changedWrap = host.querySelector('[data-row-status="changed"] .wf-patch-ins-wrap') as HTMLElement;
    const popup = changedWrap.querySelector(".patch-hover-popup") as HTMLElement;
    expect(popup.classList.contains("is-visible")).toBe(false);
    act(() => {
      changedWrap.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    expect(popup.classList.contains("is-visible")).toBe(true);
    // 每处改动各自 hover:绿块「新」的卡片只展示该处改前原文「旧」(算过 diff 的那段),不再整行原文
    expect(popup.textContent).toContain("原文");
    expect(popup.querySelector(".patch-popup-del-seg")?.textContent).toBe("旧");

    expect(host.querySelector('[data-row-status="removed"] .row-del')).not.toBeNull();
    expect(host.querySelector('[data-row-status="removed"] .row-del-line')).not.toBeNull();
  });

  it("taskList rowDiff 的 same 行仍渲染真实复选框,勾选变更有绿圈", () => {
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

    const sameCheckbox = host.querySelector('[data-row-status="same"] input[type="checkbox"]') as HTMLInputElement;
    expect(sameCheckbox).not.toBeNull();
    expect(sameCheckbox.checked).toBe(true);
    expect(host.querySelector('[data-row-status="same"] .wf-patch-ins')).toBeNull();
    expect(host.querySelector('[data-row-status="changed"] input.cb-changed')).not.toBeNull();
  });
});

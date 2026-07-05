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

function paragraph(blockId: string, text: string): PmBlockNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [{ type: "text", text }] : [],
  };
}

function callout(blockId: string, rows: readonly string[]): PmBlockNode {
  return {
    type: "callout",
    attrs: { blockId, emoji: "!", tone: "warning" },
    content: rows.map((text, index) => paragraph(`${blockId}-p-${index}`, text)),
  } as PmBlockNode;
}

function columnList(blockId: string, leftText: string, rightText: string): PmBlockNode {
  return {
    type: "columnList",
    attrs: { blockId },
    content: [
      {
        type: "column",
        attrs: { blockId: `${blockId}-left`, widthRatio: 0.45 },
        content: [paragraph(`${blockId}-left-p`, leftText)],
      },
      {
        type: "column",
        attrs: { blockId: `${blockId}-right`, widthRatio: 0.55 },
        content: [paragraph(`${blockId}-right-p`, rightText)],
      },
    ],
  } as PmBlockNode;
}

function renderDoc(doc: ViewDocumentSnapshot) {
  const patchMeta = new Map<string, PatchMeta>([
    ["rep-callout", { before: "旧风险提示", after: "新风险提示", kind: "replace", index: 1 }],
    ["rep-columns", { before: "左栏旧文", after: "左栏新文", kind: "replace", index: 2 }],
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

describe("容器递归 diff 渲染", () => {
  it("callout 保留外壳,内部 changed 段有词级绿色标记和 hover", () => {
    const afterNode = callout("callout-1", ["保留提示", "新风险提示", "补充事项"]);
    const beforeNode = callout("callout-1", ["保留提示", "旧风险提示", "归档旧块"]);

    renderDoc({
      version: 1,
      ts: "t",
      sections: [
        {
          kind: "callout",
          node: afterNode,
          text: "保留提示\n新风险提示\n补充事项",
          blockPatch: {
            patchId: "rep-callout",
            op: "replace",
            beforeBlock: { kind: "callout", node: beforeNode, text: "保留提示\n旧风险提示\n归档旧块" },
          },
          bodyDiff: [
            { status: "same", block: paragraph("callout-1-p-0", "保留提示") },
            {
              status: "changed",
              kind: "text",
              node: paragraph("callout-1-p-1", "新风险提示"),
              oldText: "旧风险提示",
              spans: [
                { kind: "patchIns", text: "新", patchId: "rep-callout" },
                { kind: "text", text: "风险提示" },
              ],
            },
            { status: "removed", oldText: "归档旧块" },
            { status: "added", block: paragraph("callout-1-p-2", "补充事项") },
          ],
        },
      ],
    });

    expect(host.querySelector(".pm-callout.pm-callout--warning")).not.toBeNull();
    expect(host.querySelector(".pm-callout .pm-callout-emoji")?.textContent).toBe("!");
    const changed = host.querySelector(".pm-callout .wf-patch-ins");
    expect(changed?.textContent).toBe("新");

    const changedWrap = host.querySelector(".pm-callout .wf-patch-ins-wrap") as HTMLElement;
    const popup = changedWrap.querySelector(".patch-hover-popup") as HTMLElement;
    expect(popup.classList.contains("is-visible")).toBe(false);
    act(() => {
      changedWrap.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    expect(popup.classList.contains("is-visible")).toBe(true);
    // 每处改动各自 hover:绿块「新」只展示该处改前的「旧」(diff 片段),不再整段原文
    expect(popup.textContent).toContain("原文");
    expect(popup.querySelector(".patch-popup-del-seg")?.textContent).toBe("旧");
    expect(host.querySelector(".pm-callout .row-del")).not.toBeNull();
  });

  it("columnList 保留分栏,某栏内部渲染局部 diff", () => {
    const afterNode = columnList("columns-1", "左栏新文", "右栏保留");
    const beforeNode = columnList("columns-1", "左栏旧文", "右栏保留");

    renderDoc({
      version: 1,
      ts: "t",
      sections: [
        {
          kind: "columnList",
          node: afterNode,
          text: "左栏新文\n右栏保留",
          blockPatch: {
            patchId: "rep-columns",
            op: "replace",
            beforeBlock: { kind: "columnList", node: beforeNode, text: "左栏旧文\n右栏保留" },
          },
          columnsDiff: [
            [
              {
                status: "changed",
                kind: "text",
                node: paragraph("columns-1-left-p", "左栏新文"),
                oldText: "左栏旧文",
                spans: [
                  { kind: "text", text: "左栏" },
                  { kind: "patchIns", text: "新", patchId: "rep-columns" },
                  { kind: "text", text: "文" },
                ],
              },
            ],
            [{ status: "same", block: paragraph("columns-1-right-p", "右栏保留") }],
          ],
        },
      ],
    });

    expect(host.querySelector(".pm-column-list[data-pm-node='columnList']")).not.toBeNull();
    expect(host.querySelectorAll(".pm-column")).toHaveLength(2);
    const leftColumn = host.querySelector(".pm-column") as HTMLElement;
    expect(leftColumn.querySelector(".wf-patch-ins")?.textContent).toBe("新");
    expect(host.textContent).toContain("右栏保留");
  });
});

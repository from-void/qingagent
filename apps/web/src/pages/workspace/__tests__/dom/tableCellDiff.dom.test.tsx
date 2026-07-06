// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    ["rep-table", { before: "指标\tQ1\tQ2\n用户数\t100\t200", after: "指标\tQ1\tQ2\n用户数\t100\t250", kind: "replace", index: 1 }],
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

describe("表格 replace 三态渲染", () => {
  it("表格 replace 收敛为单一替换态,不再展开 changed/removed/added 单元格混合态", () => {
    renderDoc({
      version: 1,
      ts: "t",
      sections: [
        {
          kind: "table",
          head: ["指标", "Q1", "Q2"],
          rows: [
            ["用户数", "100", "250"],
            ["留存", "50%", "55%"],
            ["新渠道", "12", "18"],
          ],
          blockPatch: {
            patchId: "rep-table",
            op: "replace",
            beforeBlock: {
              kind: "table",
              head: ["指标", "Q1", "Q2"],
              rows: [
                ["用户数", "100", "200"],
                ["旧渠道", "10", "20"],
                ["留存", "50%", "55%"],
              ],
            },
          },
          cellDiff: [
            {
              status: "same",
              cells: [
                { status: "same", spans: [{ kind: "text", text: "指标" }] },
                { status: "same", spans: [{ kind: "text", text: "Q1" }] },
                { status: "same", spans: [{ kind: "text", text: "Q2" }] },
              ],
            },
            {
              status: "changed",
              cells: [
                { status: "same", spans: [{ kind: "text", text: "用户数" }] },
                { status: "same", spans: [{ kind: "text", text: "100" }] },
                {
                  status: "changed",
                  oldText: "200",
                  spans: [
                    { kind: "text", text: "2" },
                    { kind: "patchIns", text: "5", patchId: "rep-table" },
                    { kind: "text", text: "0" },
                  ],
                },
              ],
            },
            {
              status: "removed",
              cells: [
                { status: "same", spans: [{ kind: "text", text: "旧渠道" }] },
                { status: "same", spans: [{ kind: "text", text: "10" }] },
                { status: "same", spans: [{ kind: "text", text: "20" }] },
              ],
            },
            {
              status: "same",
              cells: [
                { status: "same", spans: [{ kind: "text", text: "留存" }] },
                { status: "same", spans: [{ kind: "text", text: "50%" }] },
                { status: "same", spans: [{ kind: "text", text: "55%" }] },
              ],
            },
            {
              status: "added",
              cells: [
                { status: "same", spans: [{ kind: "text", text: "新渠道" }] },
                { status: "same", spans: [{ kind: "text", text: "12" }] },
                { status: "same", spans: [{ kind: "text", text: "18" }] },
              ],
            },
          ],
        },
      ],
    });

    const replace = host.querySelector('[data-patch-state="replace"].wf-patch-replace-wrap') as HTMLElement;
    expect(replace).not.toBeNull();
    expect(host.querySelector(".wf-table-diff")).toBeNull();
    expect(host.querySelector("[data-row-status]")).toBeNull();
    expect(host.querySelector("[data-cell-status]")).toBeNull();
    expect(host.querySelector(".wf-patch-ins-wrap")).toBeNull();
    expect(host.querySelector(".row-del")).toBeNull();
    expect(host.querySelector("tr.row-add")).toBeNull();
    expect(replace.textContent).toContain("250");
    expect(replace.textContent).toContain("新渠道");

    const popup = replace.querySelector(".patch-hover-popup") as HTMLElement;
    expect(popup.classList.contains("is-visible")).toBe(false);
    act(() => {
      replace.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    expect(popup.classList.contains("is-visible")).toBe(true);
    expect(popup.textContent).toContain("原文");
    expect(popup.textContent).toContain("200");
    expect(popup.textContent).toContain("旧渠道");
    expect(popup.textContent).not.toContain("改为");
  });
});

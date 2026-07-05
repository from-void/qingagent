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

describe("表格单元格级 diff 渲染", () => {
  it("same 格无绿,changed 格有绿色词级标记和 hover,removed/added 行用行级样式", () => {
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

    expect(host.querySelector('[data-row-status="same"] [data-cell-status="same"] .wf-patch-ins')).toBeNull();
    const changed = host.querySelector('[data-cell-status="changed"] .wf-patch-ins');
    expect(changed?.textContent).toBe("5");

    const changedWrap = host.querySelector('[data-cell-status="changed"] .wf-patch-ins-wrap') as HTMLElement;
    const popup = changedWrap.querySelector(".patch-hover-popup") as HTMLElement;
    expect(popup.classList.contains("is-visible")).toBe(false);
    act(() => {
      changedWrap.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    expect(popup.classList.contains("is-visible")).toBe(true);
    // 每处改动各自 hover,卡片只展示该处改前原文的 diff 片段(200→250 即「0」),不再展示「改为」
    expect(popup.textContent).toContain("原文");
    expect(popup.querySelector(".patch-popup-del-seg")?.textContent).toBe("0");
    expect(popup.textContent).not.toContain("改为");

    expect(host.querySelector('[data-row-status="removed"] .row-del')).not.toBeNull();
    expect(host.querySelector('[data-row-status="removed"] .row-del-line')).not.toBeNull();
    expect(host.querySelector("tr.row-add[data-row-status='added']")).not.toBeNull();
  });
});

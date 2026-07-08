// @vitest-environment jsdom

// 回归:审核态(showPatches=true)格式保真。根因是审核态曾走 ViewBlock 降级渲染器,
// 把 taskList 降成 [ ] 字面列表、callout 降成引用、blockMath 降成 latex 代码块、columnList
// 拍平成纵向堆叠;现在这几类携带原始 pm 节点,用 PmBlockView 渲染,与最终态一致。
// 同时校验:文字块整块新增不再套块状背景(无 .wf-blockpatch)。

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PmBlockNode, PmDoc } from "@qingagent/pm-schema";
import { pmDocToViewDocumentSnapshot, type ViewDocumentSnapshot } from "../../data/protocol";
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

function renderReview(content: PmBlockNode[]) {
  const doc: PmDoc = { type: "doc", attrs: { schemaVersion: 1 }, content };
  const snapshot = pmDocToViewDocumentSnapshot(doc, 1, "t");
  renderSnapshot(snapshot);
}

function renderSnapshot(
  snapshot: ViewDocumentSnapshot,
  patchMeta: Map<string, PatchMeta> = new Map(),
  activePatchId: string | null = null,
) {
  act(() => {
    root.render(
      <DocumentSnapshotView
        doc={snapshot}
        editable={false}
        showPatches
        acceptedPatches={new Set()}
        rejectedPatches={new Set()}
        patchMeta={patchMeta}
        activePatchId={activePatchId}
      />,
    );
  });
}

function textOutsideKatex(root: HTMLElement): string {
  const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    if (!parent?.closest(".katex, .tiptap-mathematics-render")) parts.push(node.textContent ?? "");
    node = walker.nextNode();
  }
  return parts.join("");
}

describe("审核态格式保真(showPatches)", () => {
  it("taskList 渲染真实复选框,不再是 [ ]/[x] 字面文本", () => {
    renderReview([
      {
        type: "taskList",
        attrs: { blockId: "tl-1" },
        content: [
          { type: "taskItem", attrs: { blockId: "ti-1", checked: true }, content: [{ type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text: "已完成项" }] }] },
          { type: "taskItem", attrs: { blockId: "ti-2", checked: false }, content: [{ type: "paragraph", attrs: { blockId: "p-2" }, content: [{ type: "text", text: "待办项" }] }] },
        ],
      } as PmBlockNode,
    ]);

    const checkboxes = host.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);
    expect(host.querySelector('[data-type="taskList"]')).not.toBeNull();
    // 不得出现转义前的字面 [ ] / [x]
    expect(host.textContent).not.toContain("[ ]");
    expect(host.textContent).not.toContain("[x]");
    expect(host.textContent).toContain("待办项");
  });

  it("callout 渲染提示框(emoji + tone),不再降级成引用块", () => {
    renderReview([
      {
        type: "callout",
        attrs: { blockId: "c-1", emoji: "💡", tone: "info" },
        content: [{ type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text: "提示文案" }] }],
      } as PmBlockNode,
    ]);

    expect(host.querySelector(".pm-callout")).not.toBeNull();
    expect(host.querySelector(".pm-callout--info")).not.toBeNull();
    expect(host.querySelector("blockquote")).toBeNull();
    expect(host.textContent).toContain("提示文案");
  });

  it("columnList 保留并排分栏,不再拍平成纵向堆叠", () => {
    renderReview([
      {
        type: "columnList",
        attrs: { blockId: "cl-1" },
        content: [
          { type: "column", attrs: { blockId: "col-1", widthRatio: 0.5 }, content: [{ type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text: "左栏" }] }] },
          { type: "column", attrs: { blockId: "col-2", widthRatio: 0.5 }, content: [{ type: "paragraph", attrs: { blockId: "p-2" }, content: [{ type: "text", text: "右栏" }] }] },
        ],
      } as PmBlockNode,
    ]);

    expect(host.querySelector(".pm-column-list")).not.toBeNull();
    expect(host.querySelectorAll(".pm-column")).toHaveLength(2);
    expect(host.textContent).toContain("左栏");
    expect(host.textContent).toContain("右栏");
  });

  it("blockMath 渲染 KaTeX,不再降级成 latex 源码代码块", () => {
    renderReview([
      { type: "blockMath", attrs: { blockId: "m-1", latex: "E = mc^2" } } as PmBlockNode,
    ]);

    // KaTeX 渲染产物(MathView 用 tiptap-mathematics-render 容器),不是裸代码块
    expect(host.querySelector(".tiptap-mathematics-render, .katex")).not.toBeNull();
    expect(host.querySelector("pre.md-code-block")).toBeNull();
  });

  it("普通段落内 inlineMath 渲染 KaTeX,不在正文吐 latex 源码", () => {
    const latex = String.raw`\sqrt{\sigma^{}}`;
    renderReview([
      {
        type: "paragraph",
        attrs: { blockId: "p-inline-math" },
        content: [
          { type: "text", text: "标准差 " },
          { type: "inlineMath", attrs: { latex } },
          { type: "text", text: " 完成" },
        ],
      } as PmBlockNode,
    ]);

    expect(host.querySelector(".tiptap-mathematics-render .katex")).not.toBeNull();
    expect(textOutsideKatex(host)).not.toContain(String.raw`\sqrt`);
    expect(textOutsideKatex(host)).toContain("标准差");
    expect(textOutsideKatex(host)).toContain("完成");
  });

  it("dirty inlineMath latex 含空上标、&、< 时审阅态不 crash、不漏到普通文本", () => {
    const latex = String.raw`\sqrt{\sigma^{}} & x < y`;
    renderReview([
      {
        type: "paragraph",
        attrs: { blockId: "p-inline-math-dirty" },
        content: [
          { type: "text", text: "脏公式 " },
          { type: "inlineMath", attrs: { latex } },
          { type: "text", text: " 结束" },
        ],
      } as PmBlockNode,
    ]);

    expect(host.querySelector(".tiptap-mathematics-render, .pm-math-error")).not.toBeNull();
    expect(textOutsideKatex(host)).not.toContain(String.raw`\sqrt`);
    expect(textOutsideKatex(host)).toContain("脏公式");
    expect(textOutsideKatex(host)).toContain("结束");
  });

  it("截断/非法 inlineMath latex 审阅态降级为错误代码,不抛异常", () => {
    const latex = String.raw`\sqrt{`;
    renderReview([
      {
        type: "paragraph",
        attrs: { blockId: "p-inline-math-truncated" },
        content: [{ type: "inlineMath", attrs: { latex } }],
      } as PmBlockNode,
    ]);

    expect(host.querySelector(".tiptap-mathematics-render, .pm-math-error")).not.toBeNull();
  });

  it("patchIns / patchDel 里的 inlineMath 仍渲染 KaTeX", () => {
    const latex = String.raw`\sqrt{\sigma^{}}`;
    renderSnapshot(
      {
        version: 1,
        ts: "t",
        sections: [{
          kind: "p",
          spans: [
            { kind: "text", text: "新增 " },
            { kind: "patchInsMath", latex, patchId: "ins-math" },
            { kind: "text", text: " 删除 " },
            { kind: "patchDelMath", latex, patchId: "del-math" },
          ],
        }],
      },
      new Map([
        ["ins-math", { before: "", after: latex, kind: "insert", index: 1 }],
        ["del-math", { before: latex, after: "", kind: "delete", index: 2 }],
      ]),
    );

    const inserted = host.querySelector('[data-patch-id="ins-math"] .tiptap-mathematics-render .katex');
    const deletedPopup = host.querySelector('[data-patch-id="del-math"] .patch-hover-popup .tiptap-mathematics-render .katex');
    expect(inserted).not.toBeNull();
    expect(deletedPopup).not.toBeNull();
    expect(textOutsideKatex(host)).not.toContain(String.raw`\sqrt`);
  });

  it("textColor mark 在审阅态保留 data-text-color,与结果态 CSS 对齐", () => {
    renderReview([
      {
        type: "paragraph",
        attrs: { blockId: "p-color" },
        content: [{ type: "text", text: "红色文字", marks: [{ type: "textColor", attrs: { color: "red" } }] }],
      } as PmBlockNode,
    ]);

    expect(host.querySelector('span[data-text-color="red"]')?.textContent).toBe("红色文字");
  });

  it("table 静态审阅路径使用与 PmBlockView 一致的 tbody/th 结构", () => {
    renderReview([
      {
        type: "table",
        attrs: { blockId: "tbl-head" },
        content: [{
          type: "tableRow",
          content: [{
            type: "tableHeader",
            content: [{ type: "paragraph", attrs: { blockId: "tbl-head-h" }, content: [{ type: "text", text: "指标" }] }],
          }],
        }],
      } as PmBlockNode,
    ]);

    expect(host.querySelector("table > thead")).toBeNull();
    expect(host.querySelector("table > tbody > tr > th")?.textContent).toBe("指标");
  });

  it("容器内列表行/表格单元格 changed diff 中 inlineMath 保持 KaTeX,不退回 latex 文本", () => {
    const latex = String.raw`\sqrt{\sigma^{}}`;
    renderSnapshot(
      {
        version: 1,
        ts: "t",
        sections: [{
          kind: "callout",
          text: "公式 old",
          node: {
            type: "callout",
            attrs: { blockId: "callout-math-change", emoji: "💡", tone: "info" },
            content: [
              { type: "paragraph", attrs: { blockId: "callout-p" }, content: [{ type: "text", text: "公式 old" }] },
            ],
          } as PmBlockNode,
          blockPatch: { patchId: "container-math-change", op: "replace" },
          bodyDiff: [
            {
              status: "changed",
              kind: "list",
              node: {
                type: "bulletList",
                attrs: { blockId: "list-math-change" },
                content: [{
                  type: "listItem",
                  attrs: { blockId: "li-math-change" },
                  content: [{ type: "paragraph", attrs: { blockId: "li-p" }, content: [] }],
                }],
              } as PmBlockNode,
              rowDiff: [{
                status: "changed",
                oldText: "公式 old",
                spans: [
                  { kind: "text", text: "公式 " },
                  { kind: "patchInsMath", latex, patchId: "container-math-change" },
                ],
              }],
            },
            {
              status: "changed",
              kind: "table",
              node: {
                type: "table",
                attrs: { blockId: "table-math-change" },
                content: [{ type: "tableRow", content: [{ type: "tableCell", content: [] }] }],
              } as PmBlockNode,
              cellDiff: [{
                status: "changed",
                cells: [{
                  status: "changed",
                  oldText: "公式 old",
                  spans: [
                    { kind: "text", text: "公式 " },
                    { kind: "patchInsMath", latex, patchId: "container-math-change" },
                  ],
                }],
              }],
            },
          ],
        }],
      },
      new Map([["container-math-change", { before: "公式 old", after: `公式 ${latex}`, kind: "replace", index: 1 }]]),
    );

    expect(host.querySelectorAll('[data-patch-id="container-math-change"] .tiptap-mathematics-render .katex').length).toBeGreaterThanOrEqual(2);
    expect(textOutsideKatex(host)).not.toContain(String.raw`\sqrt`);
  });

  it("quote 静态审阅路径保留内部段落结构,不拍平成单段文本", () => {
    renderReview([
      {
        type: "blockquote",
        attrs: { blockId: "quote-2p" },
        content: [
          { type: "paragraph", attrs: { blockId: "quote-p1" }, content: [{ type: "text", text: "第一段" }] },
          { type: "paragraph", attrs: { blockId: "quote-p2" }, content: [{ type: "text", text: "第二段" }] },
        ],
      } as PmBlockNode,
    ]);

    expect(Array.from(host.querySelectorAll("blockquote > p")).map((node) => node.textContent)).toEqual(["第一段", "第二段"]);
  });

  it("文字块(标题/段落)保真渲染,审核态不套块状背景", () => {
    renderReview([
      { type: "heading", attrs: { blockId: "h-1", level: 2, textAlign: "center" }, content: [{ type: "text", text: "居中标题" }] } as PmBlockNode,
    ]);

    const h2 = host.querySelector("h2");
    expect(h2).not.toBeNull();
    expect(h2?.textContent).toContain("居中标题");
    // 文字对齐保真(此前审核态丢失)
    expect((h2 as HTMLElement).style.textAlign).toBe("center");
    // 旧的块状背景类彻底移除
    expect(host.querySelector(".wf-blockpatch")).toBeNull();
    expect(host.querySelector(".wf-block-patch-marker")).toBeNull();
  });

  it("整块新增渲染为 B 新增态:新内容 + 新增标识,不带金黄 active 类", () => {
    renderSnapshot(
      {
        version: 1,
        ts: "t",
        sections: [{
          kind: "p",
          blockPatch: { patchId: "ins-block", op: "insert" },
          spans: [{ kind: "patchIns", text: "新增段落", patchId: "ins-block" }],
        }],
      },
      new Map([["ins-block", { before: "", after: "新增段落", kind: "insert", index: 1 }]]),
      "ins-block",
    );

    const insert = host.querySelector('[data-patch-state="insert"].wf-patch-ins-wrap') as HTMLElement;
    expect(insert).not.toBeNull();
    expect(insert.classList.contains("is-current")).toBe(true);
    // 审阅态减负:不再有常显「新增」文字徽章,标签只在 hover 弹层「#N · 新增」里
    expect(insert.querySelector(".wf-patch-add-badge")).toBeNull();
    expect(insert.querySelector(".patch-hover-popup")?.textContent).toContain("新增");
    expect(insert.querySelector(".wf-patch-ins")?.textContent).toBe("新增段落");
    expect(host.querySelector(".wf-patch-ins-wrap.active")).toBeNull();
    expect(host.querySelector('[data-patch-state="delete"]')).toBeNull();
  });

  it("块内替换渲染为 A 替换态:正文只显示新内容,hover 原文,不出现删除标记混合态", () => {
    renderSnapshot(
      {
        version: 1,
        ts: "t",
        sections: [{
          kind: "p",
          spans: [
            { kind: "text", text: "前 " },
            { kind: "patchDel", text: "旧词", patchId: "rep-inline" },
            { kind: "patchIns", text: "新词", patchId: "rep-inline" },
            { kind: "text", text: " 后" },
          ],
        }],
      },
      new Map([["rep-inline", { before: "旧词", after: "新词", kind: "replace", index: 1 }]]),
    );

    const replace = host.querySelector('[data-patch-state="replace"].wf-patch-replace-wrap') as HTMLElement;
    expect(replace).not.toBeNull();
    expect(replace.querySelector(".wf-patch-ins")?.textContent).toBe("新词");
    expect(host.querySelector(".wf-patch-del-marker")).toBeNull();
    expect(host.querySelector(".wf-patch-ins-wrap.active")).toBeNull();
    const popup = replace.querySelector(".patch-hover-popup") as HTMLElement;
    expect(popup.textContent).toContain("原文");
    expect(popup.textContent).toContain("旧词");
    expect((popup.querySelector(".patch-popup-original-text") as HTMLElement).tagName).toBe("SPAN");
  });

  it("追加文本渲染为 B 新增态:锚点原样显示,只高亮新增后缀", () => {
    renderSnapshot(
      {
        version: 1,
        ts: "t",
        sections: [{
          kind: "p",
          spans: [
            { kind: "text", text: "前 " },
            { kind: "patchIns", text: "标题说明", patchId: "append-inline" },
            { kind: "text", text: " 后" },
          ],
        }],
      },
      new Map([["append-inline", { before: "标题", after: "标题说明", kind: "replace", index: 1 }]]),
    );

    const insert = host.querySelector('[data-patch-state="insert"].wf-patch-ins-wrap') as HTMLElement;
    expect(insert).not.toBeNull();
    // 审阅态减负:不再有常显「新增」文字徽章,标签只在 hover 弹层里
    expect(insert.querySelector(".wf-patch-add-badge")).toBeNull();
    expect(insert.querySelector(".wf-patch-ins")?.textContent).toBe("说明");
    expect(insert.previousSibling?.textContent).toContain("标题");
    expect(insert.nextSibling?.textContent).toContain(" 后");
    expect(host.querySelector('[data-patch-state="replace"]')).toBeNull();
    expect(host.querySelector(".wf-patch-ins-wrap.active")).toBeNull();
  });

  it("纯删减渲染为 C 删除态:正文只留红杆圆点标记,hover 原文", () => {
    renderSnapshot(
      {
        version: 1,
        ts: "t",
        sections: [{
          kind: "p",
          spans: [
            { kind: "text", text: "前" },
            { kind: "patchDel", text: "删掉", patchId: "del-inline" },
            { kind: "text", text: "后" },
          ],
        }],
      },
      new Map([["del-inline", { before: "删掉", after: "", kind: "delete", index: 1 }]]),
      "del-inline",
    );

    const deleted = host.querySelector('[data-patch-state="delete"].wf-patch-del-marker') as HTMLElement;
    expect(deleted).not.toBeNull();
    expect(deleted.classList.contains("is-current")).toBe(true);
    expect(deleted.querySelector(".patch-del-cursor")).not.toBeNull();
    expect(host.querySelector('[data-patch-state="insert"]')).toBeNull();
    expect(host.querySelector('[data-patch-state="replace"]')).toBeNull();
    expect(deleted.querySelector(".patch-hover-popup")?.textContent).toContain("删掉");
  });

  it("结构 replace 收敛为单一 A 替换态,不再展开 added/removed/changed 混合子态", () => {
    renderSnapshot(
      {
        version: 1,
        ts: "t",
        sections: [{
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
            { status: "changed", oldText: "旧行", spans: [{ kind: "patchIns", text: "新", patchId: "rep-list" }, { kind: "text", text: "行" }] },
            { status: "removed", oldText: "删掉" },
            { status: "added", spans: [{ kind: "patchIns", text: "新增", patchId: "rep-list" }] },
          ],
        }],
      },
      new Map([["rep-list", { before: "保留\n旧行\n删掉", after: "保留\n新行\n新增", kind: "replace", index: 1 }]]),
    );

    const replace = host.querySelector('[data-patch-state="replace"].wf-patch-replace-wrap') as HTMLElement;
    expect(replace).not.toBeNull();
    expect(host.querySelector("[data-row-status]")).toBeNull();
    expect(host.querySelector(".row-del")).toBeNull();
    expect(host.querySelector(".wf-patch-ins-wrap")).toBeNull();
    expect(replace.textContent).toContain("新行");
    expect(replace.textContent).toContain("新增");
    expect(replace.querySelector(".patch-hover-popup")?.textContent).toContain("旧行");
    const originalText = replace.querySelector(".patch-popup-original-text") as HTMLElement;
    expect(originalText.tagName).toBe("DIV");
    expect(originalText.querySelector(".patch-popup-preview")).not.toBeNull();
    expect(host.querySelector(".wf-patch-ins-wrap.active")).toBeNull();
  });

  it("结构新增列表整块有 hover,并能响应 patch-nav 当前定位态", () => {
    renderSnapshot(
      {
        version: 1,
        ts: "t",
        sections: [{
          kind: "list",
          ordered: false,
          items: ["第一条", "第二条"],
          blockPatch: {
            patchId: "ins-list",
            op: "insert",
            marker: { kind: "patchIns", text: "新增列表", patchId: "ins-list" },
          },
        }],
      },
      new Map([["ins-list", { before: "", after: "第一条\n第二条", kind: "insert", index: 3 }]]),
      "ins-list",
    );

    const listBlock = host.querySelector('[data-patch-id="ins-list"].wf-blockmark.insert') as HTMLElement;
    expect(listBlock).not.toBeNull();
    expect(listBlock.dataset.patchState).toBe("insert");
    expect(listBlock.classList.contains("is-current")).toBe(true);
    expect(listBlock.textContent).toContain("第一条");
    expect(listBlock.textContent).toContain("第二条");

    const popup = listBlock.querySelector(".patch-hover-popup") as HTMLElement;
    expect(popup.classList.contains("is-visible")).toBe(false);
    act(() => {
      listBlock.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    expect(popup.classList.contains("is-visible")).toBe(true);
    expect(popup.textContent).toContain("#3 · 新增");
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { normalizePmDoc, type PmDoc } from "@qingagent/pm-schema";
import type { DocSuggestion } from "@qingagent/contract-ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentSnapshotView } from "../../components/DocumentSnapshotView";
import { deriveReviewTargets, pmDocToViewDocumentSnapshot, type AppliedPatch, type BlockPatchInput, type ViewBlock } from "../../data/protocol";

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
    expect(host.querySelector(".wf-patch-replace-wrap")).not.toBeNull();
    // 替换处不叠加红删除光标球(原文进 hover 卡),只留绿色新文本作唯一标记
    expect(host.querySelector(".patch-del-cursor")).toBeNull();
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

  it("块级替换:隐藏旧块 + 渲新块 widget,但不出红删标记(替换走'新块+hover原文',与行级/正文统一;codex 回归)", async () => {
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

    // 旧块 node 装饰仍在(pendingReview 下 CSS 隐藏原位),新块 widget 渲出
    expect(host.querySelector('[data-patch-id="block-rep"].wf-blockmark.delete')).not.toBeNull();
    const inserted = host.querySelector('[data-patch-id="block-rep"].wf-blockmark.insert') as HTMLElement | null;
    expect(inserted).not.toBeNull();
    expect(inserted?.dataset.patchState).toBe("replace");
    expect(inserted?.querySelector(".wf-patch-ins p")?.textContent).toBe("新增段落");
    // 替换不再出块级红删标记 widget(只纯删除才出)——原文经 hover 看
    expect(host.querySelector(".wf-blockmark-del")).toBeNull();
  });

  it("块级新增图表走 PmBlockView 渲染出图表节点(而非 raw innerHTML 空 div/源码)", async () => {
    const baselineDoc = paragraphDoc("正文");
    const applied = appliedPatch("block-diag", 5, "insert", "", "流程图");

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)}
          editable
          interactiveEditable={false}
          showPatches
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          reviewBlockPatches={[blockPatch("block-diag", "insert", { anchorBlockId: "p-1", gravity: "after", blocks: [diagramBlock] })]}
          reviewAppliedPatches={[applied]}
          patchMeta={new Map([
            ["block-diag", { before: "", after: "流程图", kind: "insert", index: 5 }],
          ])}
        />,
      );
    });

    await flush();

    const inserted = host.querySelector('[data-patch-id="block-diag"].wf-blockmark.insert') as HTMLElement | null;
    expect(inserted).not.toBeNull();
    // .pm-diagram 是 PmBlockView 的 DiagramRenderer 容器;raw innerHTML 的退化路径只有
    // data-pm-node=diagram 空 div、无此 class。据此确认图表走了 PmBlockView 而非退化路径。
    expect(inserted?.querySelector(".pm-diagram")).not.toBeNull();
    expect(inserted?.querySelector("[data-pm-node=diagram]:not(.pm-diagram)")).toBeNull();
  });

  it("同 id 同时在 suggestions + blockPatches:只渲块级图表,不重复产 inline 拍平文本副本(回归)", async () => {
    const baselineDoc = paragraphDoc("正文");

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)}
          editable
          interactiveEditable={false}
          showPatches
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          reviewSuggestions={[docSuggestion("dup-diag", 0, 0, "", "文章结构\nflowchart TD\nA --> B")]}
          reviewBlockPatches={[blockPatch("dup-diag", "insert", { anchorBlockId: "p-1", gravity: "after", blocks: [diagramBlock] })]}
          reviewAppliedPatches={[appliedPatch("dup-diag", 1, "insert", "", "文章结构")]}
          patchMeta={new Map([
            ["dup-diag", { before: "", after: "文章结构", kind: "insert", index: 1 }],
          ])}
        />,
      );
    });

    await flush();

    // 块级 patch 正常上屏(图表走 PmBlockView)
    expect(host.querySelector('.wf-blockmark.insert[data-patch-id="dup-diag"]')).not.toBeNull();
    // 同 id 不再产 inline 文本副本(preview.insertText 拍平的那条绿字源码)
    expect(host.querySelector('.wf-patch-ins-wrap[data-patch-id="dup-diag"]')).toBeNull();
  });

  it("块级新增 taskList 用原始 PM node 渲染真 checkbox(而非降级成 [x] 文本)", async () => {
    const baselineDoc = paragraphDoc("正文");
    const taskListBlock = {
      kind: "taskList",
      blockId: "tl",
      node: {
        type: "taskList",
        attrs: { blockId: "tl" },
        content: [
          { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", attrs: { blockId: "ti1" }, content: [{ type: "text", text: "完成项" }] }] },
          { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", attrs: { blockId: "ti2" }, content: [{ type: "text", text: "待办项" }] }] },
        ],
      },
      text: "",
    } as unknown as ViewBlock;

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)}
          editable
          interactiveEditable={false}
          showPatches
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          reviewBlockPatches={[blockPatch("block-task", "insert", { anchorBlockId: "p-1", gravity: "after", blocks: [taskListBlock] })]}
          reviewAppliedPatches={[appliedPatch("block-task", 6, "insert", "", "待办")]}
          patchMeta={new Map([
            ["block-task", { before: "", after: "待办", kind: "insert", index: 6 }],
          ])}
        />,
      );
    });

    await flush();

    const inserted = host.querySelector('[data-patch-id="block-task"].wf-blockmark.insert') as HTMLElement | null;
    expect(inserted).not.toBeNull();
    // 真 taskList + 两个 checkbox(而非 legacy 降级的 "[x]" 文本 + bullet)
    expect(inserted?.querySelector(".pm-task-list")).not.toBeNull();
    const boxes = inserted?.querySelectorAll('input[type="checkbox"]');
    expect(boxes?.length).toBe(2);
    expect((boxes?.[0] as HTMLInputElement)?.checked).toBe(true);
    expect((boxes?.[1] as HTMLInputElement)?.checked).toBe(false);
    expect(inserted?.textContent ?? "").not.toMatch(/\[[ x]\]/);
  });

  it("待办清单 removed 正文不显旧文，只留标记且 hover 出原文", async () => {
    const baselineDoc = paragraphDoc("正文");
    // 行级渲染:每个保留/新增/改动行都用原始 after PM item 走 PmBlockView(嵌套子项保真);
    // node.content 的 item 顺序对应 rowDiff 里非 removed 行的顺序。
    const taskListDiffBlock = {
      kind: "taskList",
      blockId: "tl",
      node: {
        type: "taskList",
        attrs: { blockId: "tl" },
        content: [
          { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: "保留项" }] }] },
          { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: "新增项", marks: [{ type: "bold" }] }] }] },
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [
              { type: "paragraph", attrs: {}, content: [{ type: "text", text: "改后项" }] },
              // 嵌套子项:必须保真渲染,不能消失
              { type: "bulletList", attrs: {}, content: [
                { type: "listItem", attrs: {}, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: "子项甲" }] }] },
              ] },
            ],
          },
        ],
      },
      text: "",
      rowDiff: [
        { status: "same", spans: [{ kind: "text", text: "保留项" }], checked: false },
        // added 行走字符级(整行 patchIns 绿),marks 由 span 携带保真
        { status: "added", spans: [{ kind: "patchIns", text: "新增项", marks: [{ type: "bold" }], patchId: "block-tl-rep" }], checked: false },
        { status: "changed", oldText: "改前项", spans: [{ kind: "patchIns", text: "改后项", patchId: "block-tl-rep" }], checked: false },
        { status: "removed", oldText: "删除项", checked: true },
      ],
    } as unknown as ViewBlock;

    const reviewApplied = appliedPatch("block-tl-rep", 7, "replace", "删除项", "新增项");
    const reviewBlockPatch = blockPatch("block-tl-rep", "replace", {
      anchorBlockId: "p-1", blocks: [taskListDiffBlock], replaceBeforeBlocks: [taskListDiffBlock], granular: true,
    });
    const reviewTargets = deriveReviewTargets([reviewApplied], [reviewBlockPatch]);
    expect(reviewTargets).toHaveLength(3);

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)}
          editable
          interactiveEditable={false}
          showPatches
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          reviewBlockPatches={[reviewBlockPatch]}
          reviewAppliedPatches={[reviewApplied]}
          reviewTargets={reviewTargets}
          activeReviewTargetId={reviewTargets[1]!.id}
          patchMeta={new Map([
            ["block-tl-rep", { before: "删除项", after: "新增项", kind: "replace", index: 7 }],
          ])}
        />,
      );
    });

    await flush();

    const inserted = host.querySelector('[data-patch-id="block-tl-rep"].wf-blockmark.insert') as HTMLElement | null;
    expect(inserted).not.toBeNull();
    // granular:抑制块级冗余标记——insert 挂 is-granular(去整块绿竖线)、不产块级红删标记 widget
    expect(inserted?.classList.contains("is-granular")).toBe(true);
    expect(host.querySelector('[data-patch-id="block-tl-rep"] .wf-blockmark-del-line')).toBeNull();
    expect(host.querySelector('.wf-blockmark-del[data-patch-id="block-tl-rep"]')).toBeNull();
    // 行级:真 taskList 里逐行标注,而不是把整个新块当一坨插入
    expect(inserted?.querySelector(".pm-task-list")).not.toBeNull();
    const targetAnchors = inserted?.querySelectorAll("[data-review-target-id]");
    expect(targetAnchors).toHaveLength(3);
    expect(Array.from(targetAnchors ?? []).map((anchor) => anchor.getAttribute("data-review-target-index"))).toEqual(["1", "2", "3"]);
    expect(inserted?.querySelectorAll("[data-review-target-id].is-current")).toHaveLength(1);
    expect(inserted?.querySelector("[data-review-target-id].is-current")?.getAttribute("data-review-target-id")).toBe(reviewTargets[1]!.id);
    const added = inserted?.querySelector(".wf-list-row--added");
    expect(added?.textContent).toContain("新增项");
    // 新增项的加粗 mark 保真(走 PmBlockView,非拍平)
    expect(added?.querySelector("strong")?.textContent).toBe("新增项");
    act(() => added!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null })));
    await flush();
    expect(host.querySelectorAll(".patch-hover-popup")).toHaveLength(1);
    expect(host.querySelector(".patch-row-popup .patch-popup-label")?.textContent).toBe("本处");
    expect(host.querySelector(".patch-row-popup")?.textContent).toContain("新增项");
    act(() => added!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: null })));
    await new Promise((resolve) => setTimeout(resolve, 180));
    const removed = inserted?.querySelector(".wf-list-row--removed");
    expect(removed?.textContent).not.toContain("删除项");
    expect(removed?.querySelector(".wf-row-del")).toBeNull();
    expect(removed?.querySelector(".wf-review-delete-marker")).not.toBeNull();
    act(() => removed!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null })));
    await flush();
    expect(host.querySelectorAll(".patch-hover-popup")).toHaveLength(1);
    expect(host.querySelector(".patch-row-popup")?.textContent).toContain("删除项");
    // 改动行:显示新内容(改后项),整项走 PmBlockView;不再假造行内删除片段
    const changed = inserted?.querySelector(".wf-list-row--changed");
    expect(changed?.textContent).toContain("改后项");
    // 改动行的嵌套子项保真渲染(不消失)
    expect(changed?.textContent).toContain("子项甲");
    expect(changed?.querySelector("ul li")).not.toBeNull();
    // 四行齐全,保留行既不带绿条也不带删除线
    const rows = inserted?.querySelectorAll(".wf-list-row");
    expect(rows?.length).toBe(4);
    const same = inserted?.querySelector(".wf-list-row--same");
    expect(same?.textContent).toContain("保留项");
    expect(same?.querySelector(".wf-row-del")).toBeNull();
  });

  it("granular 列表 changed 行 hover 只弹本行原文(旧勾选/旧格式),不弹整块列表卡(codex 回归)", async () => {
    const baselineDoc = paragraphDoc("正文");
    // before:待办原态(第2项未勾、纯文本);after:第2项已勾 + 加粗。
    const beforeTaskNode = {
      type: "taskList",
      attrs: { blockId: "tl" },
      content: [
        { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: "保留项" }] }] },
        { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: "改的项" }] }] },
      ],
    };
    const afterTaskBlock = {
      kind: "taskList",
      blockId: "tl",
      node: {
        type: "taskList",
        attrs: { blockId: "tl" },
        content: [
          { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: "保留项" }] }] },
          { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: "改的项", marks: [{ type: "bold" }] }] }] },
        ],
      },
      text: "",
      rowDiff: [
        { status: "same", spans: [{ kind: "text", text: "保留项" }], checked: false },
        { status: "changed", oldText: "改的项", spans: [{ kind: "text", text: "改的项" }], checked: true, checkedChanged: true },
      ],
    } as unknown as ViewBlock;

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)}
          editable
          interactiveEditable={false}
          showPatches
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          reviewBlockPatches={[blockPatch("tl-rep", "replace", {
            anchorBlockId: "p-1",
            blocks: [afterTaskBlock],
            replaceBeforeBlocks: [afterTaskBlock],
            granular: true,
            beforePmNodes: [beforeTaskNode as unknown as import("@qingagent/pm-schema").PmBlockNode],
          })]}
          reviewAppliedPatches={[appliedPatch("tl-rep", 8, "replace", "改的项", "改的项")]}
          patchMeta={new Map([["tl-rep", { before: "改的项", after: "改的项", kind: "replace", index: 8 }]])}
        />,
      );
    });
    await flush();

    const changed = host.querySelector(".wf-list-row--changed") as HTMLElement | null;
    expect(changed).not.toBeNull();
    // 触发行 hover
    act(() => {
      changed!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    await flush();

    const rowPopup = host.querySelector(".patch-row-popup");
    expect(rowPopup).not.toBeNull();
    // 行 hover 卡带补丁序号 #N(与其它补丁 hover 一致,不丢标号)
    expect(rowPopup?.querySelector(".patch-popup-title")?.textContent).toContain("#8");
    // 只显本行原文:含旧文本"改的项",旧勾选=未勾,旧无加粗
    expect(rowPopup?.textContent).toContain("改的项");
    const oldCb = rowPopup?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(oldCb?.checked).toBe(false);
    expect(rowPopup?.querySelector("strong")).toBeNull();
    // 不含另一行"保留项"——不是整块列表卡
    expect(rowPopup?.textContent).not.toContain("保留项");
    // 块级整列表 hover 卡不出现(PatchHoverLayer 对 granular 让位)
    expect(host.querySelector(".patch-hover-popup:not(.patch-row-popup)")).toBeNull();
  });

  it("三级嵌套列表只把深层叶子渲成 changed,hover 只显示该叶子旧文且 marks/公式保真", async () => {
    const baselineDoc = paragraphDoc("正文");
    const leafList = (changedText: string, changedMarks?: Array<{ type: "bold" }>) => ({
      type: "bulletList",
      attrs: { blockId: "leaves" },
      content: [
        {
          type: "listItem",
          attrs: { blockId: "leaf-changed" },
          content: [{
            type: "paragraph",
            attrs: { blockId: "leaf-changed-p" },
            content: [
              { type: "text", text: changedText, ...(changedMarks ? { marks: changedMarks } : {}) },
              { type: "text", text: " " },
              { type: "inlineMath", attrs: { latex: "x^2" } },
            ],
          }],
        },
        {
          type: "listItem",
          attrs: { blockId: "leaf-same" },
          content: [{ type: "paragraph", attrs: { blockId: "leaf-same-p" }, content: [{ type: "text", text: "空气凝滞" }] }],
        },
      ],
    });
    const listNode = (changedText: string, changedMarks?: Array<{ type: "bold" }>) => ({
      type: "bulletList",
      attrs: { blockId: "rain" },
      content: [{
        type: "listItem",
        attrs: { blockId: "rain-root" },
        content: [
          { type: "paragraph", attrs: { blockId: "rain-root-p" }, content: [{ type: "text", text: "雨的层次" }] },
          {
            type: "bulletList",
            attrs: { blockId: "phases" },
            content: [{
              type: "listItem",
              attrs: { blockId: "phase-before" },
              content: [
                { type: "paragraph", attrs: { blockId: "phase-before-p" }, content: [{ type: "text", text: "雨前：万物屏息" }] },
                leafList(changedText, changedMarks),
              ],
            }],
          },
        ],
      }],
    });
    const beforeNode = listNode("天色暗下来");
    const afterNode = listNode("天色骤暗", [{ type: "bold" }]);
    const afterBlock = {
      kind: "list",
      blockId: "rain",
      ordered: false,
      items: ["雨的层次"],
      node: afterNode,
      rowDiff: [{
        status: "same",
        spans: [{ kind: "text", text: "雨的层次" }],
        childLists: [{
          beforeListIndex: 0,
          afterListIndex: 0,
          rowDiff: [{
            status: "same",
            spans: [{ kind: "text", text: "雨前：万物屏息" }],
            childLists: [{
              beforeListIndex: 0,
              afterListIndex: 0,
              rowDiff: [
                {
                  status: "changed",
                  oldText: "天色暗下来 x^2",
                  // 真实字符级 diff:保留"天色"(bold)、删"暗下来"、增"骤暗"(bold)、" "与公式不变;
                  // 与 after 段落(bold"天色骤暗"+" "+inlineMath)逐单元对齐,字符级保真 marks/公式。
                  spans: [
                    { kind: "text", text: "天色", marks: [{ type: "bold" }] },
                    { kind: "patchDel", text: "暗下来", patchId: "rain-rep" },
                    { kind: "patchIns", text: "骤暗", marks: [{ type: "bold" }], patchId: "rain-rep" },
                    { kind: "text", text: " " },
                    { kind: "math", latex: "x^2" },
                  ],
                },
                { status: "same", spans: [{ kind: "text", text: "空气凝滞" }] },
              ],
            }],
          }],
        }],
      }],
    } as unknown as ViewBlock;

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)}
          editable
          interactiveEditable={false}
          showPatches
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          reviewBlockPatches={[blockPatch("rain-rep", "replace", {
            anchorBlockId: "p-1",
            blocks: [afterBlock],
            replaceBeforeBlocks: [afterBlock],
            granular: true,
            beforePmNodes: [beforeNode as unknown as import("@qingagent/pm-schema").PmBlockNode],
          })]}
          reviewAppliedPatches={[appliedPatch("rain-rep", 10, "replace", "天色暗下来", "天色骤暗")]}
          patchMeta={new Map([["rain-rep", { before: "天色暗下来", after: "天色骤暗", kind: "replace", index: 10 }]])}
        />,
      );
    });
    await flush();

    const inserted = host.querySelector('[data-patch-id="rain-rep"].wf-blockmark.insert');
    expect(inserted?.querySelectorAll(".wf-list-row")).toHaveLength(4);
    expect(inserted?.querySelectorAll(".wf-list-row--changed")).toHaveLength(1);
    expect(inserted?.querySelectorAll(".wf-list-row--same")).toHaveLength(3);
    const changed = inserted?.querySelector(".wf-list-row--changed") as HTMLElement | null;
    // 正文字符级:保留"天色"+新增"骤暗",加粗 mark 拆到各 span 上仍保真(拼接=天色骤暗),公式保真
    expect(changed?.textContent).toContain("天色骤暗");
    expect(Array.from(changed?.querySelectorAll("strong") ?? []).map((s) => s.textContent).join("")).toBe("天色骤暗");
    expect(changed?.querySelector(".tiptap-mathematics-render")).not.toBeNull();

    act(() => {
      changed!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    await flush();

    const popup = host.querySelector(".patch-row-popup");
    // hover 只弹字符级改动片段(旧→新),不再弹整行原文:含被换掉的"暗下来"与新"骤暗",不含未改的"天色"/上层列表文本
    expect(popup?.textContent).toContain("暗下来");
    expect(popup?.textContent).toContain("骤暗");
    expect(popup?.querySelector(".patch-frag")).not.toBeNull();
    expect(popup?.textContent).not.toContain("雨的层次");
    expect(popup?.textContent).not.toContain("雨前：万物屏息");
    expect(popup?.textContent).not.toContain("空气凝滞");
  });

  it("granular 有序列表 changed 行 hover 原文不渲成圆点/错误序号——只渲内容(codex 回归)", async () => {
    const baselineDoc = paragraphDoc("正文");
    const beforeOl = {
      type: "orderedList",
      attrs: { blockId: "ol", start: 3 },
      content: [
        { type: "listItem", attrs: {}, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: "旧条目" }] }] },
      ],
    };
    const afterOlBlock = {
      kind: "list",
      blockId: "ol",
      ordered: true,
      start: 3,
      items: ["新条目"],
      node: {
        type: "orderedList",
        attrs: { blockId: "ol", start: 3 },
        content: [
          { type: "listItem", attrs: {}, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: "新条目" }] }] },
        ],
      },
      rowDiff: [
        { status: "changed", oldText: "旧条目", spans: [
          { kind: "patchDel", text: "旧条目", patchId: "ol-rep" },
          { kind: "patchIns", text: "新条目", patchId: "ol-rep" },
        ] },
      ],
    } as unknown as ViewBlock;

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)}
          editable
          interactiveEditable={false}
          showPatches
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          reviewBlockPatches={[blockPatch("ol-rep", "replace", {
            anchorBlockId: "p-1",
            blocks: [afterOlBlock],
            replaceBeforeBlocks: [afterOlBlock],
            granular: true,
            beforePmNodes: [beforeOl as unknown as import("@qingagent/pm-schema").PmBlockNode],
          })]}
          reviewAppliedPatches={[appliedPatch("ol-rep", 9, "replace", "旧条目", "新条目")]}
          patchMeta={new Map([["ol-rep", { before: "旧条目", after: "新条目", kind: "replace", index: 9 }]])}
        />,
      );
    });
    await flush();

    // 正文有序列表用 <ol>
    const inserted = host.querySelector('[data-patch-id="ol-rep"].wf-blockmark.insert') as HTMLElement | null;
    expect(inserted?.querySelector("ol")).not.toBeNull();

    const changed = host.querySelector(".wf-list-row--changed") as HTMLElement | null;
    act(() => {
      changed!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    await flush();

    const rowPopup = host.querySelector(".patch-row-popup");
    expect(rowPopup).not.toBeNull();
    // hover 弹字符级改动片段(旧→新):含旧"旧条目"与新"新条目",纯内容不渲成 <ul>/<ol>(避免圆点/错误序号)
    expect(rowPopup?.textContent).toContain("旧条目");
    expect(rowPopup?.textContent).toContain("新条目");
    expect(rowPopup?.querySelector(".patch-frag")).not.toBeNull();
    expect(rowPopup?.querySelector("ul")).toBeNull();
    expect(rowPopup?.querySelector("ol")).toBeNull();
  });

  it("table granularBlockHover 保留格级标注与旧背景，但 changed 格只弹一个整块原文卡", async () => {
    const baselineDoc = paragraphDoc("正文");
    const tableNode = (changedText: string, sameCellBackground: string) => ({
      type: "table",
      attrs: { blockId: "table-local" },
      content: [
        {
          type: "tableRow",
          content: [{
            type: "tableHeader",
            attrs: { colspan: 2, colwidth: [120, 180], backgroundColor: "#fff3a3" },
            content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: "合并表头" }] }],
          }],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              attrs: { colwidth: [120], backgroundColor: sameCellBackground },
              content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: "保留格", marks: [{ type: "bold" }] }] }],
            },
            {
              type: "tableCell",
              attrs: { colwidth: [180] },
              content: [
                { type: "paragraph", attrs: {}, content: [{ type: "text", text: changedText }] },
                { type: "paragraph", attrs: {}, content: [{ type: "text", text: "第二段" }] },
              ],
            },
          ],
        },
      ],
    });
    const beforeNode = tableNode("旧值", "#fff3a3");
    const afterNode = tableNode("新值", "#eef7e8");
    const tableBlock = {
      kind: "table",
      blockId: "table-local",
      head: ["合并表头"],
      rows: [["保留格", "新值\n第二段"]],
      node: afterNode,
      cellDiff: [
        { status: "same", cells: [{ status: "same", spans: [{ kind: "text", text: "合并表头" }] }] },
        {
          status: "changed",
          cells: [
            { status: "same", spans: [{ kind: "text", text: "保留格", marks: [{ type: "bold" }] }] },
            {
              status: "changed",
              oldText: "旧值\n第二段",
              spans: [
                { kind: "patchDel", text: "旧值", patchId: "table-local-rep" },
                { kind: "patchIns", text: "新值", patchId: "table-local-rep" },
                { kind: "text", text: "\n" },
                { kind: "text", text: "第二段" },
              ],
            },
          ],
        },
      ],
    } as unknown as ViewBlock;

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)}
          editable
          interactiveEditable={false}
          showPatches
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          reviewBlockPatches={[blockPatch("table-local-rep", "replace", {
            anchorBlockId: "p-1",
            blocks: [tableBlock],
            replaceBeforeBlocks: [tableBlock],
            granular: true,
            granularBlockHover: true,
            beforePmNodes: [beforeNode as unknown as import("@qingagent/pm-schema").PmBlockNode],
          })]}
          reviewAppliedPatches={[appliedPatch("table-local-rep", 11, "replace", "旧值", "新值")]}
          patchMeta={new Map([["table-local-rep", {
            before: "旧值", after: "新值", kind: "replace", index: 11,
            beforePmNodes: [beforeNode as unknown as import("@qingagent/pm-schema").PmBlockNode],
          }]])}
        />,
      );
    });
    await flush();

    const inserted = host.querySelector('[data-patch-id="table-local-rep"].wf-blockmark.insert');
    expect(inserted?.classList.contains("is-granular")).toBe(true);
    expect(inserted?.querySelectorAll(".wf-table-row--changed")).toHaveLength(1);
    expect(inserted?.querySelectorAll(".wf-table-row--same")).toHaveLength(1);
    expect(inserted?.querySelectorAll(".wf-table-cell--changed")).toHaveLength(1);
    expect(inserted?.querySelectorAll(".wf-table-row--changed .wf-table-cell:not(.wf-table-cell--changed)")).toHaveLength(1);
    const header = inserted?.querySelector("th") as HTMLTableCellElement | null;
    expect(header?.colSpan).toBe(2);
    expect(header?.style.width).toBe("300px");
    expect(header?.dataset.bgColor).toBe("#fff3a3");
    const sameCell = inserted?.querySelector('.wf-table-row--changed td:not(.wf-table-cell--changed)') as HTMLTableCellElement | null;
    expect(sameCell?.dataset.bgColor).toBe("#eef7e8");
    expect(sameCell?.querySelector("strong")?.textContent).toBe("保留格");
    const changedCell = inserted?.querySelector(".wf-table-cell--changed") as HTMLElement | null;
    expect(changedCell?.querySelectorAll("p")).toHaveLength(2);
    // 表格格子回退整块 after node 渲染(复杂例外):不出行内 diff,旧文进 hover
    expect(changedCell?.querySelector(".wf-row-del")).toBeNull();
    expect(changedCell?.querySelector(".wf-row-ins")).toBeNull();
    expect(changedCell?.textContent).toContain("新值");

    act(() => inserted!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null })));
    await flush();
    const blockPopup = host.querySelector(".patch-hover-popup:not(.patch-row-popup)");
    const oldSameCell = blockPopup?.querySelector("tbody tr:nth-child(2) td:first-child") as HTMLElement | null;
    expect(oldSameCell?.dataset.bgColor).toBe("#fff3a3");

    act(() => changedCell!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null })));
    await flush();
    const popups = host.querySelectorAll(".patch-hover-popup");
    expect(popups).toHaveLength(1);
    expect(host.querySelector(".patch-row-popup")).toBeNull();
    expect(popups[0]?.textContent).toContain("旧值");
    expect(popups[0]?.textContent).toContain("第二段");
    expect(popups[0]?.textContent).toContain("保留格");
    expect(popups[0]?.textContent).toContain("合并表头");
  });

  it("changed table cell 用 after PM node 渲染，段尾删除不丢审阅且 hardBreak/inlineMath/marks 不折叠", async () => {
    const baselineDoc = paragraphDoc("正文");
    const beforeNode = {
      type: "table", attrs: { blockId: "table-rich-cell" }, content: [{
        type: "tableRow", content: [{ type: "tableCell", attrs: {}, content: [
          { type: "paragraph", attrs: { blockId: "before-a" }, content: [{ type: "text", text: "abcX" }] },
          { type: "paragraph", attrs: { blockId: "before-b" }, content: [{ type: "text", text: "def" }] },
        ] }],
      }],
    };
    const afterNode = {
      type: "table", attrs: { blockId: "table-rich-cell" }, content: [{
        type: "tableRow", content: [{ type: "tableCell", attrs: {}, content: [
          { type: "paragraph", attrs: { blockId: "after-a" }, content: [
            { type: "text", text: "abc", marks: [{ type: "bold" }] },
            { type: "hardBreak" },
            { type: "inlineMath", attrs: { latex: "x^2" } },
            { type: "text", text: "尾", marks: [{ type: "italic" }] },
          ] },
          { type: "paragraph", attrs: { blockId: "after-b" }, content: [{ type: "text", text: "def" }] },
        ] }],
      }],
    };
    const block = {
      kind: "table", head: [], rows: [["abc\ndef"]], node: afterNode,
      cellDiff: [{ status: "changed", cells: [{
        status: "changed", oldText: "abcX\ndef", spans: [
          { kind: "text", text: "abc" },
          { kind: "patchDel", text: "X", patchId: "table-rich-rep" },
          { kind: "text", text: "\ndef" },
        ],
      }] }],
    } as unknown as ViewBlock;

    act(() => root.render(
      <DocumentSnapshotView
        doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)} editable interactiveEditable={false} showPatches
        acceptedPatches={new Set()} rejectedPatches={new Set()}
        reviewBlockPatches={[blockPatch("table-rich-rep", "replace", {
          blocks: [block], replaceBeforeBlocks: [block], granular: true,
          beforePmNodes: [beforeNode as unknown as import("@qingagent/pm-schema").PmBlockNode],
        })]}
        reviewAppliedPatches={[appliedPatch("table-rich-rep", 15, "replace", "abcX/def", "abc/def")]}
        patchMeta={new Map([["table-rich-rep", { before: "abcX/def", after: "abc/def", kind: "replace", index: 15 }]])}
      />,
    ));
    await flush();

    const changedCell = host.querySelector(".wf-table-cell--changed") as HTMLElement | null;
    expect(changedCell?.querySelectorAll("p")).toHaveLength(2);
    expect(changedCell?.querySelector("strong")?.textContent).toBe("abc");
    expect(changedCell?.querySelector("br")).not.toBeNull();
    expect(changedCell?.querySelector(".tiptap-mathematics-render")).not.toBeNull();
    expect(changedCell?.querySelector("em")?.textContent).toBe("尾");
    expect(changedCell?.querySelector(".wf-row-del")).toBeNull();
    act(() => changedCell!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null })));
    await flush();
    expect(host.querySelector(".patch-row-popup")?.textContent).toContain("abcX");
    expect(host.querySelector(".patch-row-popup")?.textContent).toContain("def");
  });

  it("table 加行时整表块级 replace：只显示新表、无格级/红删标记，hover 看旧表背景", async () => {
    const baselineDoc = paragraphDoc("正文");
    const tableNode = (rows: string[]) => ({
      type: "table",
      attrs: { blockId: "table-rows" },
      content: rows.map((text, index) => ({
        type: "tableRow",
        content: [{
          type: "tableCell",
          attrs: { backgroundColor: index === 0 ? "#fff3a3" : null },
          content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text }] }],
        }],
      })),
    });
    const beforeNode = tableNode(["旧值"]);
    const afterNode = tableNode(["新值", "新增行"]);
    const block = {
      kind: "table",
      head: [],
      rows: [["新值"], ["新增行"]],
      node: afterNode,
    } as unknown as ViewBlock;

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)} editable interactiveEditable={false} showPatches
          acceptedPatches={new Set()} rejectedPatches={new Set()}
          reviewBlockPatches={[blockPatch("table-rows-rep", "replace", {
            blocks: [block], replaceBeforeBlocks: [block],
            beforePmNodes: [beforeNode as unknown as import("@qingagent/pm-schema").PmBlockNode],
          })]}
          reviewAppliedPatches={[appliedPatch("table-rows-rep", 14, "replace", "旧值", "新值\n新增行")]}
          patchMeta={new Map([["table-rows-rep", {
            before: "旧值", after: "新值\n新增行", kind: "replace", index: 14,
            beforePmNodes: [beforeNode as unknown as import("@qingagent/pm-schema").PmBlockNode],
          }]])}
        />,
      );
    });
    await flush();

    const inserted = host.querySelector('[data-patch-id="table-rows-rep"].wf-blockmark.insert');
    expect(inserted?.classList.contains("is-granular")).toBe(false);
    expect(inserted?.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(inserted?.textContent).toContain("新值");
    expect(inserted?.textContent).toContain("新增行");
    expect(inserted?.textContent).not.toContain("旧值");
    expect(inserted?.querySelector(".wf-table-row, .wf-table-cell--changed, .wf-row-del")).toBeNull();
    expect(host.querySelector('[data-patch-id="table-rows-rep"].wf-blockmark-del')).toBeNull();

    act(() => inserted!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null })));
    await flush();
    const popup = host.querySelector(".patch-hover-popup:not(.patch-row-popup)");
    expect(host.querySelectorAll(".patch-hover-popup")).toHaveLength(1);
    expect(popup?.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(popup?.textContent).toContain("旧值");
    expect((popup?.querySelector("td") as HTMLElement | null)?.dataset.bgColor).toBe("#fff3a3");
  });

  it("callout 内嵌 table 加行递归降级：新表无格级标注，hover 该块只看旧表", async () => {
    const baselineDoc = paragraphDoc("正文");
    const tableNode = (rows: string[], backgroundColor: string | null) => ({
      type: "table",
      attrs: { blockId: "nested-table" },
      content: rows.map((text) => ({
        type: "tableRow",
        content: [{
          type: "tableCell",
          attrs: { backgroundColor },
          content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text }] }],
        }],
      })),
    });
    const beforeTable = tableNode(["旧格"], "#fff3a3");
    const afterTable = tableNode(["新格", "新增行"], "#eef7e8");
    const beforeNode = {
      type: "callout",
      attrs: { blockId: "nested-callout", emoji: "💡", tone: "info" },
      content: [beforeTable],
    };
    const afterNode = {
      type: "callout",
      attrs: { blockId: "nested-callout", emoji: "💡", tone: "info" },
      content: [afterTable],
    };
    const block = {
      kind: "callout",
      node: afterNode,
      text: "新格\n新增行",
      bodyDiff: [{ status: "changed", kind: "block", node: afterTable }],
    } as unknown as ViewBlock;

    act(() => root.render(
      <DocumentSnapshotView
        doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)} editable interactiveEditable={false} showPatches
        acceptedPatches={new Set()} rejectedPatches={new Set()}
        reviewBlockPatches={[blockPatch("nested-table-rep", "replace", {
          blocks: [block], replaceBeforeBlocks: [block], granular: true,
          beforePmNodes: [beforeNode as unknown as import("@qingagent/pm-schema").PmBlockNode],
        })]}
        reviewAppliedPatches={[appliedPatch("nested-table-rep", 15, "replace", "旧格", "新格\n新增行")]}
        patchMeta={new Map([["nested-table-rep", { before: "旧格", after: "新格\n新增行", kind: "replace", index: 15 }]])}
      />,
    ));
    await flush();

    const inserted = host.querySelector('[data-patch-id="nested-table-rep"].wf-blockmark.insert');
    const changed = inserted?.querySelector(".wf-container-block--changed") as HTMLElement | null;
    expect(inserted?.classList.contains("is-granular")).toBe(true);
    expect(changed?.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(changed?.textContent).toContain("新格");
    expect(changed?.textContent).toContain("新增行");
    expect(changed?.querySelector(".wf-table-row, .wf-table-cell--changed, .wf-row-del")).toBeNull();

    act(() => changed!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null })));
    await flush();
    const popup = host.querySelector(".patch-row-popup");
    expect(host.querySelector(".patch-hover-popup:not(.patch-row-popup)")).toBeNull();
    expect(popup?.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(popup?.textContent).toContain("旧格");
    expect(popup?.textContent).not.toContain("新增行");
    expect((popup?.querySelector("td") as HTMLElement | null)?.dataset.bgColor).toBe("#fff3a3");
  });

  it("callout tone 与 body 同改时保留局部标注，hover changed 块只弹整块旧 tone 卡", async () => {
    const baselineDoc = paragraphDoc("正文");
    const calloutNode = (changedText: string, tone: "warning" | "success") => ({
      type: "callout",
      attrs: { blockId: "callout-local", emoji: "⚠️", tone },
      content: [
        { type: "paragraph", attrs: { blockId: "callout-keep" }, content: [{ type: "text", text: "保留提示", marks: [{ type: "bold" }] }] },
        { type: "paragraph", attrs: { blockId: "callout-change" }, content: [{ type: "text", text: changedText }] },
      ],
    });
    const beforeNode = calloutNode("旧风险", "warning");
    const afterNode = calloutNode("新风险", "success");
    const block = {
      kind: "callout",
      node: afterNode,
      text: "保留提示\n新风险",
      bodyDiff: [
        { status: "same", block: afterNode.content[0] },
        {
          status: "changed",
          kind: "text",
          node: afterNode.content[1],
          oldText: "旧风险",
          spans: [
            { kind: "patchDel", text: "旧", patchId: "callout-local-rep" },
            { kind: "patchIns", text: "新", patchId: "callout-local-rep" },
            { kind: "text", text: "风险" },
          ],
        },
      ],
    } as unknown as ViewBlock;

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)} editable interactiveEditable={false} showPatches
          acceptedPatches={new Set()} rejectedPatches={new Set()}
          reviewBlockPatches={[blockPatch("callout-local-rep", "replace", {
            blocks: [block], replaceBeforeBlocks: [block], granular: true, granularBlockHover: true,
            beforePmNodes: [beforeNode as unknown as import("@qingagent/pm-schema").PmBlockNode],
          })]}
          reviewAppliedPatches={[appliedPatch("callout-local-rep", 12, "replace", "旧风险", "新风险")]}
          patchMeta={new Map([["callout-local-rep", {
            before: "旧风险", after: "新风险", kind: "replace", index: 12,
            beforePmNodes: [beforeNode as unknown as import("@qingagent/pm-schema").PmBlockNode],
          }]])}
        />,
      );
    });
    await flush();

    const inserted = host.querySelector('[data-patch-id="callout-local-rep"].wf-blockmark.insert');
    expect(inserted?.classList.contains("is-granular")).toBe(true);
    expect(inserted?.querySelector(".pm-callout--success")).not.toBeNull();
    expect(inserted?.querySelector(".pm-callout-body > p strong")?.textContent).toBe("保留提示");
    expect(inserted?.querySelectorAll(".wf-container-block--changed")).toHaveLength(1);
    const changed = inserted?.querySelector(".wf-container-block--changed") as HTMLElement | null;
    expect(changed?.querySelector(".wf-row-del")).toBeNull();
    expect(changed?.querySelector(".wf-row-ins")?.textContent).toBe("新");
    act(() => inserted!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null })));
    await flush();
    expect(host.querySelector(".patch-hover-popup:not(.patch-row-popup) .pm-callout--warning")).not.toBeNull();
    act(() => changed!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null })));
    await flush();
    expect(host.querySelectorAll(".patch-hover-popup")).toHaveLength(1);
    expect(host.querySelector(".patch-row-popup")).toBeNull();
    const popup = host.querySelector(".patch-hover-popup:not(.patch-row-popup)");
    expect(popup?.textContent).toContain("旧风险");
    expect(popup?.textContent).toContain("保留提示");
    expect(popup?.querySelector(".pm-callout--warning")).not.toBeNull();
  });

  it("columnList 栏宽与内容同改时保留局部标注，hover changed 块只弹整块旧栏宽卡", async () => {
    const baselineDoc = paragraphDoc("正文");
    const columnListNode = (changedText: string, ratios: [number, number]) => ({
      type: "columnList",
      attrs: { blockId: "columns-local" },
      content: [
        {
          type: "column",
          attrs: { blockId: "left", widthRatio: ratios[0] },
          content: [{ type: "paragraph", attrs: { blockId: "left-p" }, content: [{ type: "text", text: changedText }] }],
        },
        {
          type: "column",
          attrs: { blockId: "right", widthRatio: ratios[1] },
          content: [{ type: "paragraph", attrs: { blockId: "right-p" }, content: [{ type: "text", text: "右栏保留", marks: [{ type: "bold" }] }] }],
        },
      ],
    });
    const beforeNode = columnListNode("左栏旧文", [0.45, 0.55]);
    const afterNode = columnListNode("左栏新文", [0.35, 0.65]);
    const block = {
      kind: "columnList",
      node: afterNode,
      text: "左栏新文\n右栏保留",
      columnsDiff: [
        {
          status: "changed",
          beforeColumnIndex: 0,
          afterColumnIndex: 0,
          bodyDiff: [{
            status: "changed",
            kind: "text",
            node: afterNode.content[0]!.content[0],
            oldText: "左栏旧文",
            spans: [
              { kind: "text", text: "左栏" },
              { kind: "patchDel", text: "旧", patchId: "columns-local-rep" },
              { kind: "patchIns", text: "新", patchId: "columns-local-rep" },
              { kind: "text", text: "文" },
            ],
          }],
        },
        {
          status: "same",
          beforeColumnIndex: 1,
          afterColumnIndex: 1,
          bodyDiff: [{ status: "same", block: afterNode.content[1]!.content[0] }],
        },
      ],
    } as unknown as ViewBlock;

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)} editable interactiveEditable={false} showPatches
          acceptedPatches={new Set()} rejectedPatches={new Set()}
          reviewBlockPatches={[blockPatch("columns-local-rep", "replace", {
            blocks: [block], replaceBeforeBlocks: [block], granular: true, granularBlockHover: true,
            beforePmNodes: [beforeNode as unknown as import("@qingagent/pm-schema").PmBlockNode],
          })]}
          reviewAppliedPatches={[appliedPatch("columns-local-rep", 13, "replace", "左栏旧文", "左栏新文")]}
          patchMeta={new Map([["columns-local-rep", {
            before: "左栏旧文", after: "左栏新文", kind: "replace", index: 13,
            beforePmNodes: [beforeNode as unknown as import("@qingagent/pm-schema").PmBlockNode],
          }]])}
        />,
      );
    });
    await flush();

    const inserted = host.querySelector('[data-patch-id="columns-local-rep"].wf-blockmark.insert');
    expect(inserted?.classList.contains("is-granular")).toBe(true);
    const columns = inserted?.querySelectorAll(".pm-column");
    expect(columns).toHaveLength(2);
    expect((columns?.[0] as HTMLElement | undefined)?.style.flexBasis).toBe("35%");
    expect((columns?.[1] as HTMLElement | undefined)?.style.flexBasis).toBe("65%");
    expect(inserted?.querySelectorAll(".wf-container-block--changed")).toHaveLength(1);
    expect(columns?.[1]?.querySelector("strong")?.textContent).toBe("右栏保留");
    act(() => inserted!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null })));
    await flush();
    const oldColumns = host.querySelectorAll(".patch-hover-popup:not(.patch-row-popup) .pm-column");
    expect(Number.parseFloat((oldColumns[0] as HTMLElement | undefined)?.style.flexBasis ?? "")).toBeCloseTo(45);
    expect(Number.parseFloat((oldColumns[1] as HTMLElement | undefined)?.style.flexBasis ?? "")).toBeCloseTo(55);
    const changed = inserted?.querySelector(".wf-container-block--changed") as HTMLElement | null;
    act(() => changed!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null })));
    await flush();
    expect(host.querySelectorAll(".patch-hover-popup")).toHaveLength(1);
    expect(host.querySelector(".patch-row-popup")).toBeNull();
    const popup = host.querySelector(".patch-hover-popup:not(.patch-row-popup)");
    expect(popup?.textContent).toContain("左栏旧文");
    expect(popup?.textContent).toContain("右栏保留");
  });

  it("columnList 删除中栏按栏级 diff 渲成整栏 removed，后续栏不串位且保留旧栏宽", async () => {
    const baselineDoc = paragraphDoc("正文");
    const paragraph = (blockId: string, text: string) => ({
      type: "paragraph", attrs: { blockId }, content: [{ type: "text", text }],
    });
    const beforeNode = {
      type: "columnList", attrs: { blockId: "columns-delete" }, content: [
        { type: "column", attrs: { blockId: "delete-a", widthRatio: 0.25 }, content: [paragraph("delete-a-p", "甲栏")] },
        { type: "column", attrs: { blockId: "delete-b", widthRatio: 0.35 }, content: [paragraph("delete-b-p", "乙栏旧内容")] },
        { type: "column", attrs: { blockId: "delete-c", widthRatio: 0.4 }, content: [paragraph("delete-c-p", "丙栏")] },
      ],
    };
    const afterNode = {
      type: "columnList", attrs: { blockId: "columns-delete" }, content: [beforeNode.content[0], beforeNode.content[2]],
    };
    const block = {
      kind: "columnList", node: afterNode, text: "甲栏\n丙栏", columnsDiff: [
        { status: "same", beforeColumnIndex: 0, afterColumnIndex: 0, bodyDiff: [{ status: "same", block: beforeNode.content[0]!.content[0] }] },
        { status: "removed", beforeColumnIndex: 1, bodyDiff: [{ status: "removed", oldText: "乙栏旧内容" }] },
        { status: "same", beforeColumnIndex: 2, afterColumnIndex: 1, bodyDiff: [{ status: "same", block: beforeNode.content[2]!.content[0] }] },
      ],
    } as unknown as ViewBlock;

    act(() => root.render(
      <DocumentSnapshotView
        doc={pmDocToViewDocumentSnapshot(baselineDoc, 1)} editable interactiveEditable={false} showPatches
        acceptedPatches={new Set()} rejectedPatches={new Set()}
        reviewBlockPatches={[blockPatch("columns-delete-rep", "replace", {
          blocks: [block], replaceBeforeBlocks: [block], granular: true,
          beforePmNodes: [beforeNode as unknown as import("@qingagent/pm-schema").PmBlockNode],
        })]}
        reviewAppliedPatches={[appliedPatch("columns-delete-rep", 16, "replace", "甲乙丙", "甲丙")]}
        patchMeta={new Map([["columns-delete-rep", { before: "甲乙丙", after: "甲丙", kind: "replace", index: 16 }]])}
      />,
    ));
    await flush();

    const columns = host.querySelectorAll('[data-patch-id="columns-delete-rep"] .pm-column');
    expect(columns).toHaveLength(3);
    expect(Array.from(columns).map((column) => column.textContent)).toEqual(["甲栏", "", "丙栏"]);
    expect(columns[1]?.getAttribute("data-column-status")).toBe("removed");
    expect((columns[1] as HTMLElement | undefined)?.style.flexBasis).toBe("35%");
    const removed = columns[1]?.querySelector(".wf-container-block--removed") as HTMLElement | null;
    expect(removed).not.toBeNull();
    expect(removed?.querySelector(".wf-review-delete-marker")).not.toBeNull();
    act(() => removed!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null })));
    await flush();
    expect(host.querySelectorAll(".patch-hover-popup")).toHaveLength(1);
    expect(host.querySelector(".patch-row-popup")?.textContent).toContain("乙栏旧内容");
  });

  it("hover 卡片原文用原始 before PM node 渲真 <table>(合并单元格/富文本保真,非散排 markdown)", async () => {
    // hover 原文吃原始 before PM node(hunk.before),直接 PmBlockView 渲染,保全 colspan/marks。
    const beforeTableNode = {
      type: "table",
      attrs: { blockId: "tb" },
      content: [
        { type: "tableRow", content: [
          { type: "tableHeader", attrs: { colspan: 2 }, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: "合并表头" }] }] },
        ] },
        { type: "tableRow", content: [
          { type: "tableCell", attrs: {}, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: "甲", marks: [{ type: "bold" }] }] }] },
          { type: "tableCell", attrs: {}, content: [{ type: "paragraph", attrs: {}, content: [{ type: "text", text: "乙" }] }] },
        ] },
      ],
    } as unknown as import("@qingagent/pm-schema").PmBlockNode;

    const { ReviewBlocksStatic } = await import("../../components/doc/reviewBlockDiff");
    const popupHost = document.createElement("div");
    document.body.appendChild(popupHost);
    const popupRoot = createRoot(popupHost);
    act(() => {
      popupRoot.render(<ReviewBlocksStatic nodes={[beforeTableNode]} />);
    });
    await flush();

    const table = popupHost.querySelector("table");
    expect(table).not.toBeNull();
    // 合并单元格保真:表头 colspan=2
    expect((popupHost.querySelector("th") as HTMLTableCellElement | null)?.colSpan).toBe(2);
    // 单元格富文本保真:加粗 mark
    expect(popupHost.querySelector("td strong")?.textContent).toBe("甲");
    expect(popupHost.textContent).toContain("合并表头");
    // 不是散排的裸 markdown 竖线
    expect(popupHost.textContent ?? "").not.toContain("|");

    act(() => popupRoot.unmount());
    popupHost.remove();
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

const diagramBlock: ViewBlock = {
  kind: "diagram",
  blockId: "d-new",
  source: "flowchart TD\n  A[开始] --> B[结束]",
  lang: "mermaid",
  svg: null,
} as ViewBlock;

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

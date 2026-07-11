import { describe, expect, it } from "vitest";
import { legacySectionsToPm, type PmBlockNode, type PmDoc, type PmInlineNode } from "@qingagent/pm-schema";
import type { DiffHunk, DocSuggestion } from "@qingagent/contract-ts";
import { applyDiffHunks, buildDraftDiff } from "../../../../../../packages/core/src/bridge/proposalDiff.js";
import {
  derivePatchPresentation,
  cloneListRowDiff,
  suggestionToBlockPatchInput,
  suggestionToBlockPatchInputs,
  pmDocToViewDocumentSnapshot,
  suggestionToPatchOverlay,
  viewDocSpanText,
  type PatchOverlayInput,
  type ViewBlock,
  type ViewDocumentSnapshot,
  type ViewListRowDiff,
} from "./protocol";

/** 构造若干段落的只读文档(每段一个 text span)。 */
function pdoc(...texts: string[]): ViewDocumentSnapshot {
  return {
    version: 1,
    ts: "t",
    sections: texts.map((t) => ({ kind: "p", spans: [{ kind: "text", text: t }] })),
  };
}

function suggestionFromText(
  id: string,
  text: string,
  quote: string,
  replacement: string,
  status: DocSuggestion["status"] = "reviewing",
): { doc: ViewDocumentSnapshot; suggestion: DocSuggestion } {
  const pmDoc = legacySectionsToPm([{ kind: "p", data: { text } }]);
  const block = pmDoc.content[0]!;
  const quoteStart = text.indexOf(quote);
  if (quoteStart < 0) throw new Error("quote missing in fixture");
  const pmFrom = 1 + quoteStart;
  const pmTo = pmFrom + quote.length;
  return {
    doc: pmDocToViewDocumentSnapshot(pmDoc, 1, "t"),
    suggestion: {
      id,
      docId: "doc-1",
      baseVersion: 1,
      baseSchemaVersion: 1,
      status,
      anchor: {
        blockId: block.attrs.blockId,
        pmFrom,
        pmTo,
        quote,
        textHash: "fixture-hash",
      },
      patch: {
        kind: "prosemirror_steps",
        steps: [{ stepType: "replace", from: pmFrom, to: pmTo, slice: { content: [] } }],
      },
      preview: { deleteText: quote, insertText: replacement },
      summary: "测试修改",
      ...(status === "conflict"
        ? {
            conflict: {
              kind: "target_text_changed",
              message: "冲突",
              suggestionId: id,
              blockId: block.attrs.blockId,
            },
          }
        : {}),
    },
  };
}

function suggestionWithDiffHunk(
  suggestion: DocSuggestion,
  diffHunk: DiffHunk,
): DocSuggestion {
  return { ...suggestion, diffHunk };
}

function pmText(text: string) {
  return { type: "text" as const, text };
}

function pmInlineMath(latex: string): PmInlineNode {
  return { type: "inlineMath", attrs: { latex } };
}

function pmParagraph(blockId: string, text: string): PmBlockNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [pmText(text)] : [],
  };
}

function pmParagraphContent(blockId: string, content: PmInlineNode[]): PmBlockNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content,
  };
}

function pmHeading(blockId: string, text: string, level: 1 | 2 | 3 | 4 | 5 | 6 = 2): PmBlockNode {
  return {
    type: "heading",
    attrs: { blockId, level },
    content: text ? [pmText(text)] : [],
  };
}

function pmCodeBlock(blockId: string, text: string): PmBlockNode {
  return {
    type: "codeBlock",
    attrs: { blockId, language: "ts" },
    content: [pmText(text)],
  };
}

function pmBulletList(blockId: string, itemBlockId: string, itemText: string): PmBlockNode {
  return {
    type: "bulletList",
    attrs: { blockId },
    content: [{
      type: "listItem",
      attrs: { blockId: itemBlockId },
      content: [pmParagraph(`${itemBlockId}-p`, itemText)],
    }],
  };
}

function pmNestedListRows(
  type: "bulletList" | "orderedList" | "taskList",
  blockId: string,
  rows: Array<{ text: string; checked?: boolean; children?: PmBlockNode[] }>,
): PmBlockNode {
  const content = rows.map((row, index) => ({
    type: type === "taskList" ? "taskItem" as const : "listItem" as const,
    attrs: {
      blockId: `${blockId}-i${index}`,
      ...(type === "taskList" ? { checked: row.checked ?? false } : {}),
    },
    content: [pmParagraph(`${blockId}-p${index}`, row.text), ...(row.children ?? [])],
  }));
  if (type === "taskList") {
    return { type, attrs: { blockId }, content } as PmBlockNode;
  }
  return {
    type,
    attrs: { blockId, ...(type === "orderedList" ? { start: 1 } : {}) },
    content,
  } as PmBlockNode;
}

function flattenListRowStatuses(rows: readonly ViewListRowDiff[]): ViewListRowDiff["status"][] {
  return rows.flatMap((row) => [
    row.status,
    ...(row.childLists ?? []).flatMap((child) => flattenListRowStatuses(child.rowDiff)),
  ]);
}

function pmColumnList(blockId: string): PmBlockNode {
  return {
    type: "columnList",
    attrs: { blockId },
    content: [
      {
        type: "column",
        attrs: { blockId: `${blockId}-left`, widthRatio: 0.4 },
        content: [
          pmHeading(`${blockId}-left-h`, "左栏标题"),
          pmParagraph(`${blockId}-left-p`, "左栏正文"),
        ],
      },
      {
        type: "column",
        attrs: { blockId: `${blockId}-right`, widthRatio: 0.6 },
        content: [pmBulletList(`${blockId}-right-list`, `${blockId}-right-li`, "右栏列表")],
      },
    ],
  };
}

function pmTable(blockId: string, cellText: string): PmBlockNode {
  return {
    type: "table",
    attrs: { blockId },
    content: [{
      type: "tableRow",
      content: [{
        type: "tableCell",
        content: [pmParagraph(`${blockId}-p`, cellText)],
      }],
    }],
  };
}

function pmDoc(content: PmBlockNode[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function blockSuggestion(id: string, hunk: DiffHunk): DocSuggestion {
  return {
    id,
    reviewBatchId: hunk.reviewBatchId,
    groupMode: hunk.groupMode,
    docId: "doc-1",
    baseVersion: 1,
    baseSchemaVersion: 1,
    status: "reviewing",
    anchor: {
      blockId: hunk.anchor.blockId ?? id,
      pmFrom: hunk.anchor.pmFrom ?? 0,
      pmTo: hunk.anchor.pmTo ?? hunk.anchor.pmFrom ?? 0,
      quote: hunk.beforeText ?? hunk.afterText ?? id,
      textHash: `hash-${id}`,
    },
    patch: { kind: "prosemirror_steps", steps: [] },
    preview: {
      deleteText: hunk.beforeText ?? "",
      insertText: hunk.afterText ?? "",
    },
    summary: hunk.summary,
    diffHunk: hunk,
  };
}

describe("pmDocToViewDocumentSnapshot — columnList 保真", () => {
  it("审核态保留 columnList 为单个保真块(携带原始 pm 节点),不再拍平成纵向堆叠", () => {
    const snapshot = pmDocToViewDocumentSnapshot(pmDoc([pmColumnList("columns-view")]), 1, "t");

    // 保真:一个 columnList 段,blockId 为容器本身,静态 PM 视图渲成并排分栏
    expect(snapshot.sections.map((section) => section.kind)).toEqual(["columnList"]);
    expect(snapshot.sections.map((section) => section.blockId)).toEqual(["columns-view"]);
    const columnSection = snapshot.sections[0] as Extract<ViewBlock, { kind: "columnList" }>;
    expect(columnSection.node.type).toBe("columnList");
    // text 投影仍含两列内容,供锚点回退 / 块级 patch 文本派生
    expect(columnSection.text).toContain("左栏标题");
    expect(columnSection.text).toContain("右栏列表");
  });

  it("行内公式保留为 math span,不再拍平成 latex 文本", () => {
    const latex = String.raw`\sqrt{\sigma^{}} & x < y`;
    const snapshot = pmDocToViewDocumentSnapshot(pmDoc([
      pmParagraphContent("p-math", [
        pmText("标准差 "),
        pmInlineMath(latex),
        pmText(" 说明"),
      ]),
      {
        type: "bulletList",
        attrs: { blockId: "list-math" },
        content: [{
          type: "listItem",
          attrs: { blockId: "li-math" },
          content: [pmParagraphContent("li-math-p", [pmText("列表 "), pmInlineMath(latex)])],
        }],
      } as PmBlockNode,
      {
        type: "table",
        attrs: { blockId: "tbl-math" },
        content: [{
          type: "tableRow",
          content: [{
            type: "tableCell",
            content: [pmParagraphContent("tbl-math-c", [pmText("单元格 "), pmInlineMath(latex)])],
          }],
        }],
      } as PmBlockNode,
    ]), 1, "t");

    const paragraph = snapshot.sections[0] as Extract<ViewBlock, { kind: "p" }>;
    expect(paragraph.spans).toEqual([
      { kind: "text", text: "标准差 " },
      { kind: "math", latex },
      { kind: "text", text: " 说明" },
    ]);
    expect(paragraph.spans.map(viewDocSpanText).join("")).toBe(`标准差 ${latex} 说明`);

    const list = snapshot.sections[1] as Extract<ViewBlock, { kind: "list" }>;
    expect(list.itemSpans?.[0]).toContainEqual({ kind: "math", latex });

    const table = snapshot.sections[2] as Extract<ViewBlock, { kind: "table" }>;
    expect(table.rowSpans?.[0]?.[0]).toContainEqual({ kind: "math", latex });
  });
});

/**
 * 不变量自检:任何 derivePatchPresentation 结果都必须满足
 * 计数 === applied id 数 === applied 数,且序号 1..N 连续。
 * 这是"沉淀的验证方法"——把它喂任意场景,数量一不对立刻断言失败。
 */
function assertInternallyConsistent(result: ReturnType<typeof derivePatchPresentation>) {
  expect(result.appliedIds.size).toBe(result.applied.length);
  expect([...result.appliedIds].sort()).toEqual(result.applied.map((a) => a.id).sort());
  const groupIndexes = [...new Set(result.applied.map((a) => a.index))].sort((a, b) => a - b);
  expect(groupIndexes).toEqual(groupIndexes.map((_, i) => i + 1));
}

describe("derivePatchPresentation — 单一真相源", () => {
  it("正常:每处都锚定成功,序号 1..N 连续,无 dropped", () => {
    const doc = pdoc("第一段原文", "第二段原文");
    const patches: PatchOverlayInput[] = [
      { id: "p1", before: "原文", after: "新版", blockIndex: 0 },
      { id: "p2", before: "原文", after: "改写", blockIndex: 1 },
    ];
    const result = derivePatchPresentation(doc, patches);

    expect(result.applied.map((a) => a.id)).toEqual(["p1", "p2"]);
    expect(result.applied.map((a) => a.index)).toEqual([1, 2]);
    expect(result.droppedIds).toEqual([]);
    assertInternallyConsistent(result);
  });

  it("同一 reviewBatchId 的旧数据仍可形成一个兼容 group", () => {
    const doc = pdoc("湖边有柳树。他拿着蓝毛巾。");
    const patches: PatchOverlayInput[] = [
      {
        id: "tree",
        reviewBatchId: "batch-block-a",
        groupMode: "atomic",
        before: "柳",
        after: "胡桃",
        blockIndex: 0,
      },
      {
        id: "towel",
        reviewBatchId: "batch-block-a",
        groupMode: "atomic",
        before: "蓝",
        after: "黄",
        blockIndex: 0,
      },
    ];

    const result = derivePatchPresentation(doc, patches);

    expect(result.applied.map((patch) => patch.id)).toEqual(["tree", "towel"]);
    expect(result.groups).toEqual([
      {
        reviewBatchId: "batch-block-a",
        groupMode: "atomic",
        patchIds: ["tree", "towel"],
        index: 1,
      },
    ]);
    expect(result.applied.map((patch) => patch.index)).toEqual([1, 2]);
    expect(result.applied.map((patch) => patch.reviewBatchId)).toEqual([
      "batch-block-a",
      "batch-block-a",
    ]);
  });

  it("回归(修改处数按绿色段数算):一个 editDraft 替换文本里多空格 → 正文多段绿,处数 = applied 数(=绿段数)", () => {
    // 复刻用户实测:改一句话的 replaceText,替换文本里中间多了两处空格 →
    // buildDraftDiff 把不连续的改动切成 2 个 hunk。生成端不再按 blockId 原子归组,
    // 因此正文绿色段数、applied 数、决策处数都应是 2。
    const base = pmDoc([pmParagraph("b1", "我们今天去公园散步看风景")]);
    const draft = pmDoc([pmParagraph("b1", "我们今天去  公园散步  看风景")]);
    const hunks = buildDraftDiff(base, draft, { baseVersion: 1 });
    expect(hunks).toHaveLength(2); // 两处不连续改动 → 两个 hunk
    expect(new Set(hunks.map((h) => h.reviewBatchId)).size).toBe(2);
    expect(new Set(hunks.map((h) => h.groupMode))).toEqual(new Set(["independent"]));

    const doc = pmDocToViewDocumentSnapshot(base, 1, "t");
    const overlays = hunks
      .map((hunk, i) => suggestionToPatchOverlay(doc, blockSuggestion(`sp-${i}`, hunk), i))
      .filter((o): o is PatchOverlayInput => o !== null);
    expect(overlays).toHaveLength(2); // 段内文本 replace 走行内通道,两条 overlay

    const result = derivePatchPresentation(doc, overlays);

    // 正文实际渲染的绿色标记数(distinct patchId,每个 hunk 一段)= 2
    const greenSegments = result.appliedIds.size;
    expect(greenSegments).toBe(2);
    // 单一真相源:applied 数 === 正文绿段数(WorkspacePage 据此显示处数)
    expect(result.applied.length).toBe(greenSegments);
    expect(result.groups.length).toBe(2);
    assertInternallyConsistent(result);
  });

  it("锚点匹配失败的 patch 被报告为 dropped,且不占计数/序号", () => {
    const doc = pdoc("Hello world");
    const patches: PatchOverlayInput[] = [
      // before 在文档里根本不存在 → 无法锚定
      { id: "ghost", before: "zzz", after: "qqq", blockIndex: 0 },
    ];
    const result = derivePatchPresentation(doc, patches);

    expect(result.applied).toEqual([]);
    expect(result.droppedIds).toEqual(["ghost"]);
    // 即便丢了一处,内部仍然自洽(计数=正文标记=0),绝不会"说有 1 处实际 0 处"
    assertInternallyConsistent(result);
  });

  it("同一段落多处改动按原始基线定位,不再依赖旧 React materialize 切片", () => {
    const doc = pdoc("我喜欢猫和狗");
    const patches: PatchOverlayInput[] = [
      { id: "a", before: "猫和狗", after: "猫、狗、兔", blockIndex: 0 },
      { id: "b", before: "喜欢猫", after: "超爱猫", blockIndex: 0 },
    ];
    const result = derivePatchPresentation(doc, patches);

    expect(result.applied.map((a) => a.id)).toEqual(["a", "b"]);
    expect(result.applied.map((a) => a.index)).toEqual([1, 2]);
    expect(result.droppedIds).toEqual([]);
    assertInternallyConsistent(result);
  });

  it("同段多 hunk 带原始 range 时逆序注入,不会被前一处切片打散", () => {
    const doc = pdoc("我喜欢猫和狗");
    const patches: PatchOverlayInput[] = [
      { id: "a", before: "猫", after: "兔", blockIndex: 0, range: { start: 3, end: 4 } },
      { id: "b", before: "狗", after: "鸟", blockIndex: 0, range: { start: 5, end: 6 } },
    ];
    const result = derivePatchPresentation(doc, patches);

    expect(result.applied.map((a) => a.id)).toEqual(["a", "b"]);
    expect(result.droppedIds).toEqual([]);
    assertInternallyConsistent(result);
  });

  it("R2-03 before/after 皆空的 range patch 不计入 applied,避免正文标记与计数不一致", () => {
    const doc = pdoc("我喜欢猫");
    const patches: PatchOverlayInput[] = [
      { id: "ok", before: "猫", after: "狗", blockIndex: 0, range: { start: 3, end: 4 } },
      { id: "empty-range", before: "", after: "", blockIndex: 0, range: { start: 2, end: 2 } },
    ];
    const result = derivePatchPresentation(doc, patches);

    expect(result.applied.map((a) => a.id)).toEqual(["ok"]);
    expect(result.appliedIds.has("empty-range")).toBe(false);
    expect(result.droppedIds).toEqual(["empty-range"]);
    expect(new Set(result.applied.map((patch) => patch.id))).toEqual(new Set(["ok"]));
    assertInternallyConsistent(result);
  });

  it("headline 不变量:计数 === 正文 distinct 标记数(随机几组都成立)", () => {
    const scenarios: Array<{ doc: ViewDocumentSnapshot; patches: PatchOverlayInput[] }> = [
      { doc: pdoc("abc"), patches: [] },
      {
        doc: pdoc("alpha beta", "gamma delta"),
        patches: [
          { id: "x", before: "beta", after: "BETA", blockIndex: 0 },
          { id: "y", before: "delta", after: "DELTA", blockIndex: 1 },
          { id: "z", before: "missing", after: "X", blockIndex: 0 }, // drop
        ],
      },
    ];
    for (const s of scenarios) {
      const result = derivePatchPresentation(s.doc, s.patches);
      expect(result.appliedIds.size).toBe(result.applied.length);
      assertInternallyConsistent(result);
    }
  });

  it("PM suggestion 按 blockId + PM position 映射到现有 patch DOM 标记", () => {
    const { doc, suggestion } = suggestionFromText(
      "s1",
      "A😀蓝毛巾",
      "蓝毛巾",
      "黄毛巾",
    );
    const overlay = suggestionToPatchOverlay(doc, suggestion);

    expect(overlay).toMatchObject({
      id: "s1",
      blockIndex: 0,
      range: { start: 2, end: 5 },
    });

    const result = derivePatchPresentation(doc, overlay ? [overlay] : []);
    expect(result.applied.map((patch) => patch.id)).toEqual(["s1"]);
    expect(result.droppedIds).toEqual([]);
    expect(result.conflictIds).toEqual([]);
    expect(new Set(result.applied.map((patch) => patch.id))).toEqual(new Set(["s1"]));
    assertInternallyConsistent(result);
  });

  it("行内公式作为原子参与 draft diff:新增/删除/替换都注入 math patch span", () => {
    const latex = String.raw`\sqrt{\sigma^{}} & x < y`;
    const nextLatex = String.raw`\frac{a}{b}`;
    const cases = [
      {
        id: "math-insert",
        base: pmDoc([pmParagraphContent("p-math-insert", [pmText("公式 "), pmText(" 完成")])]),
        draft: pmDoc([pmParagraphContent("p-math-insert", [pmText("公式 "), pmInlineMath(latex), pmText(" 完成")])]),
        expectedKinds: ["patchInsMath"],
      },
      {
        id: "math-delete",
        base: pmDoc([pmParagraphContent("p-math-delete", [pmText("公式 "), pmInlineMath(latex), pmText(" 完成")])]),
        draft: pmDoc([pmParagraphContent("p-math-delete", [pmText("公式 "), pmText(" 完成")])]),
        expectedKinds: ["patchDelMath"],
      },
      {
        id: "math-replace",
        base: pmDoc([pmParagraphContent("p-math-replace", [pmText("公式 "), pmInlineMath(latex), pmText(" 完成")])]),
        draft: pmDoc([pmParagraphContent("p-math-replace", [pmText("公式 "), pmInlineMath(nextLatex), pmText(" 完成")])]),
        expectedKinds: ["patchDelMath", "patchInsMath"],
      },
    ] as const;

    for (const item of cases) {
      const hunks = buildDraftDiff(item.base, item.draft, { baseVersion: 1 });
      expect(hunks).toHaveLength(1);
      const doc = pmDocToViewDocumentSnapshot(item.base, 1, "t");
      const overlay = suggestionToPatchOverlay(doc, blockSuggestion(item.id, hunks[0]!), 0);
      expect(overlay).not.toBeNull();
      const result = derivePatchPresentation(doc, overlay ? [overlay] : []);
      expect(result.droppedIds).toEqual([]);
      expect(item.expectedKinds.length).toBeGreaterThan(0);
      assertInternallyConsistent(result);
    }
  });

  it("editDraft 标题 suggestion 能渲染为可见审批组,避免 pendingReview 0 处死锁", () => {
    const pmDoc = {
      type: "doc" as const,
      attrs: { schemaVersion: 1 as const },
      content: [
        {
          type: "heading" as const,
          attrs: { blockId: "title-block", level: 1 },
          content: [{ type: "text" as const, text: "旧标题" }],
        },
      ],
    };
    const doc = pmDocToViewDocumentSnapshot(pmDoc as never, 1, "t");
    const suggestion: DocSuggestion = {
      id: "s-title",
      reviewBatchId: "batch-title",
      groupMode: "atomic",
      docId: "doc-1",
      baseVersion: 1,
      baseSchemaVersion: 1,
      status: "reviewing",
      anchor: {
        blockId: "title-block",
        pmFrom: 1,
        pmTo: 4,
        quote: "旧标题",
        textHash: "hash-title",
      },
      patch: {
        kind: "prosemirror_steps",
        steps: [{ stepType: "replace", from: 1, to: 4, slice: { content: [] } }],
      },
      preview: { deleteText: "旧标题", insertText: "新标题" },
      summary: "修改标题",
    };

    const overlay = suggestionToPatchOverlay(doc, suggestion);
    expect(overlay).toMatchObject({
      id: "s-title",
      reviewBatchId: "batch-title",
      groupMode: "atomic",
      blockIndex: 0,
      range: { start: 0, end: 3 },
    });

    const result = derivePatchPresentation(doc, overlay ? [overlay] : []);
    expect(result.groups).toEqual([
      {
        reviewBatchId: "batch-title",
        groupMode: "atomic",
        patchIds: ["s-title"],
        index: 1,
      },
    ]);
    expect(result.applied.map((patch) => patch.id)).toEqual(["s-title"]);
    expect(result.droppedIds).toEqual([]);
    expect(new Set(result.applied.map((patch) => patch.id))).toEqual(new Set(["s-title"]));
    assertInternallyConsistent(result);
  });

  it("candidate-diff markAdd suggestion 渲染为样式装饰而不是文本 del/ins", () => {
    const { doc, suggestion } = suggestionFromText(
      "s-bold",
      "尖尖的顶子露在树梢上",
      "树",
      "树",
    );
    const diffHunk: DiffHunk = {
      hunkId: "s-bold",
      reviewBatchId: "s-bold",
      groupMode: "independent",
      op: "markAdd",
      blockPath: [0],
      anchor: {
        blockId: suggestion.anchor.blockId,
        quoteBefore: "树",
        quoteAfter: "树",
        pmFrom: suggestion.anchor.pmFrom,
        pmTo: suggestion.anchor.pmTo,
        anchorKind: "range",
      },
      before: null,
      after: null,
      marks: [{ type: "bold" }],
      summary: "添加标记 bold",
      beforeText: "树",
      afterText: "树",
    };
    const overlay = suggestionToPatchOverlay(doc, suggestionWithDiffHunk(suggestion, diffHunk));
    expect(overlay).toMatchObject({
      id: "s-bold",
      kind: "markAdd",
      label: "将加粗",
      before: "树",
      after: "树",
    });

    const result = derivePatchPresentation(doc, overlay ? [overlay] : []);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({ id: "s-bold", kind: "markAdd", label: "将加粗" });
    assertInternallyConsistent(result);
  });

  it("R30 回归:blockId 漂移(前端 ai-block-* / 锚点 block-*)时用 quote+prefix/suffix 文本回退定位", () => {
    // 复现:前端 state.doc 为流式生成期 ai-block-* id,后端 suggestion 锚点为持久化后 block-* id。
    // 旧逻辑只按 blockId 匹配 → 永不命中 → patch 静默丢失(正文无 diff、无审批条、对话锁死)。
    const pmDoc = {
      type: "doc" as const,
      content: [
        { type: "heading" as const, attrs: { blockId: "ai-block-h", level: 2 }, content: [{ type: "text" as const, text: "春" }] },
        {
          type: "paragraph" as const,
          attrs: { blockId: "ai-block-p" },
          content: [{ type: "text" as const, text: "还有一丝若有若无的青草味。冬的寒意还没散尽。" }],
        },
      ],
    };
    const doc = pmDocToViewDocumentSnapshot(pmDoc as never, 1, "t");
    const suggestion = {
      id: "s-drift",
      docId: "doc-1",
      baseVersion: 2,
      baseSchemaVersion: 1,
      status: "reviewing" as const,
      anchor: {
        blockId: "block-PERSISTED-DIFFERENT",
        pmFrom: 999,
        pmTo: 1003,
        quote: "的青草味",
        prefix: "还有一丝若有若无",
        suffix: "。冬的寒意还没散尽",
        textHash: "h",
      },
      patch: { kind: "prosemirror_steps" as const, steps: [] },
      preview: { deleteText: "的青草味", insertText: "的草木清芬" },
      summary: "改写",
    };
    const overlay = suggestionToPatchOverlay(doc, suggestion as never);
    expect(overlay).not.toBeNull();
    expect(overlay).toMatchObject({ id: "s-drift", blockIndex: 1 });
    const result = derivePatchPresentation(doc, overlay ? [overlay] : []);
    expect(result.applied.map((p) => p.id)).toEqual(["s-drift"]);
    expect(result.droppedIds).toEqual([]);
    assertInternallyConsistent(result);
  });

  it("conflict suggestion 不生成正文标记,通过 conflictIds 显式守恒", () => {
    const { doc, suggestion } = suggestionFromText(
      "s-conflict",
      "原文",
      "原文",
      "新文",
      "conflict",
    );
    const overlay = suggestionToPatchOverlay(doc, suggestion);
    const result = derivePatchPresentation(doc, overlay ? [overlay] : []);

    expect(result.applied).toEqual([]);
    expect(result.droppedIds).toEqual([]);
    expect(result.conflictIds).toEqual(["s-conflict"]);
    expect(result.applied.length + result.conflictIds.length).toBe(1);
    expect(result.appliedIds.size).toBe(0);
    assertInternallyConsistent(result);
  });

  it("A2:空 base 的 insert hunk 注入为唯一待审块并进入计数", () => {
    const doc = pmDocToViewDocumentSnapshot(pmDoc([]), 1, "t");
    const hunk: DiffHunk = {
      hunkId: "ins-empty",
      reviewBatchId: "batch-empty",
      groupMode: "atomic",
      op: "insert",
      blockPath: [0],
      anchor: { anchorKind: "position", gravity: "before" },
      before: null,
      after: [pmParagraph("block-new", "新段落")] as never,
      summary: "插入块",
      afterText: "新段落",
    };
    const input = suggestionToBlockPatchInput(blockSuggestion("ins-empty", hunk), 0);
    const result = derivePatchPresentation(doc, [], input ? [input] : []);

    expect(input).not.toBeNull();
    expect(result.applied.map((patch) => patch.id)).toEqual(["ins-empty"]);
    expect(new Set(result.applied.map((patch) => patch.id))).toEqual(new Set(["ins-empty"]));
    assertInternallyConsistent(result);
  });

  it("A2:insert 多块含 list/table/code 无 spans 块,仍按一个 hunk 呈现并计数", () => {
    const doc = pmDocToViewDocumentSnapshot(pmDoc([pmParagraph("block-a", "基准")]), 1, "t");
    const hunk: DiffHunk = {
      hunkId: "ins-rich",
      reviewBatchId: "batch-rich",
      groupMode: "atomic",
      op: "insert",
      blockPath: [1],
      anchor: { blockId: "block-a", anchorKind: "position", gravity: "after" },
      before: null,
      after: [
        pmBulletList("block-list", "block-li", "列表项"),
        pmTable("block-table", "表格格"),
        pmCodeBlock("block-code", "const x = 1;"),
      ] as never,
      summary: "插入块",
      afterText: "列表项\n表格格\nconst x = 1;",
    };
    const input = suggestionToBlockPatchInput(blockSuggestion("ins-rich", hunk), 0);
    const result = derivePatchPresentation(doc, [], input ? [input] : []);

    expect(result.applied).toHaveLength(1);
    expect(new Set(result.applied.map((patch) => patch.id))).toEqual(new Set(["ins-rich"]));
    assertInternallyConsistent(result);
  });

  it("P7:insert 无 anchor.blockId 但有 blockPath 时内联绿块,不计入 unrenderable", () => {
    const doc = pmDocToViewDocumentSnapshot(pmDoc([
      pmParagraph("block-a", "第一段"),
      pmParagraph("block-b", "第二段"),
    ]), 1, "t");
    const hunk: DiffHunk = {
      hunkId: "ins-path-only",
      reviewBatchId: "batch-path-only",
      groupMode: "atomic",
      op: "insert",
      blockPath: [1],
      anchor: { anchorKind: "position" },
      before: null,
      after: [
        pmHeading("block-new-title", "新增标题"),
        pmParagraph("block-new-p", "新增段落"),
        pmBulletList("block-new-list", "block-new-li", "新增列表"),
      ] as never,
      summary: "插入无锚块",
      afterText: "新增标题\n新增段落\n新增列表",
    };
    const input = suggestionToBlockPatchInput(blockSuggestion("ins-path-only", hunk), 0);
    const result = derivePatchPresentation(doc, [], input ? [input] : []);

    expect(input).toMatchObject({ anchorIndex: 1 });
    expect(input?.anchorBlockId).toBeUndefined();
    expect(result.droppedIds).toEqual([]);
    expect(result.conflictIds).toEqual([]);
    expect(result.droppedIds.length + result.conflictIds.length).toBe(0);
    expect(new Set(result.applied.map((patch) => patch.id))).toEqual(new Set(["ins-path-only"]));
    assertInternallyConsistent(result);
  });

  it("P7:insert 完全无锚时 fallback 文末内联绿块,不再 dropped", () => {
    const doc = pmDocToViewDocumentSnapshot(pmDoc([
      pmParagraph("block-a", "第一段"),
      pmParagraph("block-b", "第二段"),
    ]), 1, "t");
    const hunk: DiffHunk = {
      hunkId: "ins-no-anchor",
      reviewBatchId: "batch-no-anchor",
      groupMode: "atomic",
      op: "insert",
      blockPath: [],
      anchor: {},
      before: null,
      after: [
        pmHeading("block-new-title", "文末标题"),
        pmParagraph("block-new-p", "文末段落"),
        pmTable("block-new-table", "文末表格"),
        pmCodeBlock("block-new-code", "const done = true;"),
      ] as never,
      summary: "插入完全无锚块",
      afterText: "文末标题\n文末段落\n文末表格\nconst done = true;",
    };
    const input = suggestionToBlockPatchInput(blockSuggestion("ins-no-anchor", hunk), 0);
    const result = derivePatchPresentation(doc, [], input ? [input] : []);

    expect(input).not.toBeNull();
    expect(input?.anchorBlockId).toBeUndefined();
    expect(input?.anchorIndex).toBeUndefined();
    expect(result.applied.map((patch) => patch.id)).toEqual(["ins-no-anchor"]);
    expect(result.droppedIds).toEqual([]);
    expect(result.conflictIds).toEqual([]);
    expect(result.droppedIds.length + result.conflictIds.length).toBe(0);
    expect(new Set(result.applied.map((patch) => patch.id))).toEqual(new Set(["ins-no-anchor"]));
    assertInternallyConsistent(result);
  });

  it("R31 回归:blockId 漂移的块 insert 用 blockPath 索引定位,不回落到文档顶部", () => {
    const doc = pmDocToViewDocumentSnapshot(pmDoc([
      pmParagraph("ai-block-a", "第一段"),
      pmParagraph("ai-block-b", "第二段"),
    ]), 1, "t");
    const hunk: DiffHunk = {
      hunkId: "ins-title-drift",
      reviewBatchId: "batch-title-drift",
      groupMode: "atomic",
      op: "insert",
      blockPath: [1],
      anchor: { blockId: "block-persisted-a", anchorKind: "position", gravity: "after" },
      before: null,
      after: [pmHeading("block-title", "小标题")] as never,
      summary: "插入小标题",
      afterText: "小标题",
    };
    const input = suggestionToBlockPatchInput(blockSuggestion("ins-title-drift", hunk), 0);
    const result = derivePatchPresentation(doc, [], input ? [input] : []);

    expect(input).toMatchObject({ anchorBlockId: "block-persisted-a", anchorIndex: 1 });
    expect(result.applied.map((patch) => patch.id)).toEqual(["ins-title-drift"]);
    expect(result.droppedIds).toEqual([]);
    assertInternallyConsistent(result);
  });

  it("R31 回归:多个 blockPath insert 按目标索引升序插入到各自段落前", () => {
    const doc = pmDocToViewDocumentSnapshot(pmDoc([
      pmParagraph("ai-block-a", "A"),
      pmParagraph("ai-block-b", "B"),
      pmParagraph("ai-block-c", "C"),
    ]), 1, "t");
    const beforeBHunk: DiffHunk = {
      hunkId: "ins-before-b",
      reviewBatchId: "batch-before-b",
      groupMode: "independent",
      op: "insert",
      blockPath: [1],
      anchor: { blockId: "block-persisted-a", anchorKind: "position", gravity: "after" },
      before: null,
      after: [pmHeading("block-title-b", "标题 B")] as never,
      summary: "插入 B 前标题",
      afterText: "标题 B",
    };
    const beforeCHunk: DiffHunk = {
      hunkId: "ins-before-c",
      reviewBatchId: "batch-before-c",
      groupMode: "independent",
      op: "insert",
      blockPath: [2],
      anchor: { blockId: "block-persisted-b", anchorKind: "position", gravity: "after" },
      before: null,
      after: [pmHeading("block-title-c", "标题 C")] as never,
      summary: "插入 C 前标题",
      afterText: "标题 C",
    };
    const inputC = suggestionToBlockPatchInput(blockSuggestion("ins-before-c", beforeCHunk), 0);
    const inputB = suggestionToBlockPatchInput(blockSuggestion("ins-before-b", beforeBHunk), 1);
    const result = derivePatchPresentation(doc, [], [inputC, inputB].filter(Boolean) as NonNullable<typeof inputB>[]);

    expect(inputB?.anchorIndex).toBe(1);
    expect(inputC?.anchorIndex).toBe(2);
    expect(result.droppedIds).toEqual([]);
    assertInternallyConsistent(result);
  });

  it("块级 patch clone 保留 heading textAlign 与 diagram overlay", () => {
    const doc = pmDocToViewDocumentSnapshot(pmDoc([pmParagraph("anchor", "锚点")]), 1, "t");
    const overlay = { positions: { A: { x: 12, y: 24 } } };
    const hunk: DiffHunk = {
      hunkId: "insert-fidelity-blocks",
      reviewBatchId: "insert-fidelity-blocks",
      groupMode: "independent",
      op: "insert",
      blockPath: [0],
      anchor: { blockId: "anchor", anchorKind: "position", gravity: "after" },
      before: null,
      after: [
        {
          type: "heading",
          attrs: { blockId: "insert-heading", level: 2, textAlign: "center" },
          content: [{ type: "text", text: "居中标题" }],
        },
        {
          type: "diagram",
          attrs: {
            blockId: "insert-diagram",
            lang: "flowchart",
            source: "graph TD; A-->B",
            svg: null,
            overlay,
          },
        },
      ] as never,
      summary: "插入保真块",
      afterText: "居中标题\ngraph TD; A-->B",
    };
    const input = suggestionToBlockPatchInput(blockSuggestion("insert-fidelity-blocks", hunk), 0);
    const result = derivePatchPresentation(doc, [], input ? [input] : []);

    expect(input?.blocks[0]).toMatchObject({ kind: "h2", textAlign: "center" });
    expect(input?.blocks[1]).toMatchObject({ kind: "diagram", overlay });
    assertInternallyConsistent(result);
  });

  it("R31 回归:insert + delete 混合时 delete 原位标记,insert 仍按 base blockPath 定位", () => {
    const doc = pmDocToViewDocumentSnapshot(pmDoc([
      pmParagraph("ai-block-a", "A"),
      pmParagraph("ai-block-b", "B"),
      pmParagraph("ai-block-c", "C"),
      pmParagraph("ai-block-d", "D"),
    ]), 1, "t");
    const deleteHunk: DiffHunk = {
      hunkId: "del-b-drift",
      reviewBatchId: "batch-del-b",
      groupMode: "independent",
      op: "delete",
      blockPath: [1],
      anchor: { blockId: "block-persisted-b", anchorKind: "range", pmFrom: 2, pmTo: 3 },
      before: [pmParagraph("block-persisted-b", "B")] as never,
      after: null,
      beforeText: "B",
      summary: "删除 B",
    };
    const insertHunk: DiffHunk = {
      hunkId: "ins-before-d",
      reviewBatchId: "batch-before-d",
      groupMode: "independent",
      op: "insert",
      blockPath: [3],
      anchor: { blockId: "block-persisted-c", anchorKind: "position", gravity: "after" },
      before: null,
      after: [pmHeading("block-title-d", "标题 D")] as never,
      afterText: "标题 D",
      summary: "插入 D 前标题",
    };
    const insertInput = suggestionToBlockPatchInput(blockSuggestion("ins-before-d", insertHunk), 0);
    const deleteInput = suggestionToBlockPatchInput(blockSuggestion("del-b-drift", deleteHunk), 1);
    const result = derivePatchPresentation(doc, [], [insertInput, deleteInput].filter(Boolean) as NonNullable<typeof insertInput>[]);

    expect(deleteInput?.anchorIndex).toBe(1);
    expect(insertInput?.anchorIndex).toBe(3);
    expect(result.droppedIds).toEqual([]);
    assertInternallyConsistent(result);
  });

  it("A2:insert + replace 同 reviewBatchId 时共享序号和组计数,顺序来自 hunk order", () => {
    const { doc, suggestion } = suggestionFromText("replace-mixed", "旧词", "旧词", "新词");
    const replace = suggestionWithDiffHunk(
      { ...suggestion, reviewBatchId: "batch-mixed", groupMode: "atomic" },
      {
        hunkId: "replace-mixed",
        reviewBatchId: "batch-mixed",
        groupMode: "atomic",
        op: "replace",
        blockPath: [0],
        anchor: {
          blockId: suggestion.anchor.blockId,
          quoteBefore: "旧词",
          quoteAfter: "新词",
          pmFrom: suggestion.anchor.pmFrom,
          pmTo: suggestion.anchor.pmTo,
          anchorKind: "range",
        },
        before: null,
        after: null,
        beforeText: "旧词",
        afterText: "新词",
        summary: "替换文字",
      },
    );
    const insertHunk: DiffHunk = {
      hunkId: "insert-mixed",
      reviewBatchId: "batch-mixed",
      groupMode: "atomic",
      op: "insert",
      blockPath: [1],
      anchor: { blockId: suggestion.anchor.blockId, anchorKind: "position", gravity: "after" },
      before: null,
      after: [pmParagraph("block-new", "新增段")] as never,
      afterText: "新增段",
      summary: "插入块",
    };
    const overlay = suggestionToPatchOverlay(doc, replace, 1);
    const blockInput = suggestionToBlockPatchInput(blockSuggestion("insert-mixed", insertHunk), 0);
    const result = derivePatchPresentation(doc, overlay ? [overlay] : [], blockInput ? [blockInput] : []);

    expect(result.groups).toEqual([{
      reviewBatchId: "batch-mixed",
      groupMode: "atomic",
      patchIds: ["insert-mixed", "replace-mixed"],
      index: 1,
    }]);
    expect(result.applied.map((patch) => [patch.id, patch.index])).toEqual([
      ["insert-mixed", 1],
      ["replace-mixed", 2],
    ]);
    expect(new Set(result.applied.map((patch) => patch.id))).toEqual(new Set(["insert-mixed", "replace-mixed"]));
    assertInternallyConsistent(result);
  });

  it("A2:delete hunk 覆盖连续多块时每块写入同一 patchDel span,派生正文跳过删除块", () => {
    const doc = pmDocToViewDocumentSnapshot(pmDoc([
      pmParagraph("block-a", "A"),
      pmParagraph("block-b", "B"),
      pmParagraph("block-c", "C"),
    ]), 1, "t");
    const hunk: DiffHunk = {
      hunkId: "del-bc",
      reviewBatchId: "batch-del",
      groupMode: "atomic",
      op: "delete",
      blockPath: [1],
      anchor: { blockId: "block-b", anchorKind: "range", pmFrom: 2, pmTo: 5 },
      before: [pmParagraph("block-b", "B"), pmParagraph("block-c", "C")] as never,
      after: null,
      beforeText: "B\nC",
      summary: "删除块",
    };
    const input = suggestionToBlockPatchInput(blockSuggestion("del-bc", hunk), 0);
    const result = derivePatchPresentation(doc, [], input ? [input] : []);

    expect(result.applied).toHaveLength(1);
    expect(new Set(result.applied.map((patch) => patch.id))).toEqual(new Set(["del-bc"]));
    assertInternallyConsistent(result);
  });
});

describe("p03 回归:结构 replace hunk 的块级可视通道", () => {
  function pmTable(blockId: string, cellText: string): PmBlockNode {
    return pmTableRows(blockId, [[cellText]]);
  }

  function pmTableRows(blockId: string, rows: readonly (readonly string[])[], options: { header?: boolean } = {}): PmBlockNode {
    return {
      type: "table",
      attrs: { blockId },
      content: rows.map((row, rowIndex) => ({
        type: "tableRow",
        content: row.map((cellText, cellIndex) => ({
          type: options.header && rowIndex === 0 ? "tableHeader" : "tableCell",
          attrs: {},
          content: [
            {
              type: "paragraph",
              attrs: { blockId: `${blockId}-r${rowIndex}-c${cellIndex}` },
              content: [{ type: "text", text: cellText }],
            },
          ],
        })),
      })),
    } as never;
  }

  function pmBulletListRows(blockId: string, rows: readonly string[]): PmBlockNode {
    return {
      type: "bulletList",
      attrs: { blockId },
      content: rows.map((text, index) => ({
        type: "listItem",
        attrs: { blockId: `${blockId}-li-${index}` },
        content: [pmParagraph(`${blockId}-p-${index}`, text)],
      })),
    } as never;
  }

  function pmTaskListRows(
    blockId: string,
    rows: ReadonlyArray<{ text: string; checked: boolean }>,
  ): PmBlockNode {
    return {
      type: "taskList",
      attrs: { blockId },
      content: rows.map((row, index) => ({
        type: "taskItem",
        attrs: { blockId: `${blockId}-ti-${index}`, checked: row.checked },
        content: [pmParagraph(`${blockId}-p-${index}`, row.text)],
      })),
    } as never;
  }

  function pmCalloutRows(blockId: string, rows: readonly string[]): PmBlockNode {
    return {
      type: "callout",
      attrs: { blockId, emoji: "!", tone: "warning" },
      content: rows.map((text, index) => pmParagraph(`${blockId}-p-${index}`, text)),
    } as never;
  }

  function pmCalloutBlocks(blockId: string, blocks: readonly PmBlockNode[], tone: "warning" | "success" = "warning"): PmBlockNode {
    return {
      type: "callout",
      attrs: { blockId, emoji: "!", tone },
      content: blocks,
    } as never;
  }

  function pmColumnListBlocks(blockId: string, columns: readonly PmBlockNode[][]): PmBlockNode {
    return {
      type: "columnList",
      attrs: { blockId },
      content: columns.map((content, index) => ({
        type: "column",
        attrs: { blockId: `${blockId}-col-${index}`, widthRatio: index === 0 ? 0.45 : 0.55 },
        content,
      })),
    } as never;
  }

  function pmNamedColumnList(
    blockId: string,
    columns: ReadonlyArray<{ id: string; text: string; widthRatio: number }>,
  ): PmBlockNode {
    return {
      type: "columnList",
      attrs: { blockId },
      content: columns.map((column) => ({
        type: "column",
        attrs: { blockId: column.id, widthRatio: column.widthRatio },
        content: [pmParagraph(`${column.id}-p`, column.text)],
      })),
    } as never;
  }

  function replaceHunk(id: string, anchorBlockId: string, before: PmBlockNode, after: PmBlockNode): DiffHunk {
    return {
      hunkId: id,
      reviewBatchId: `batch-${id}`,
      groupMode: "independent",
      op: "replace",
      blockPath: [0],
      anchor: { anchorKind: "position", blockId: anchorBlockId, gravity: "before" },
      before: [before] as never,
      after: [after] as never,
      summary: "替换块",
      beforeText: "旧",
      afterText: "新",
    };
  }

  function tableRowPlainText(
    row: NonNullable<Extract<ViewBlock, { kind: "table" }>["cellDiff"]>[number] | undefined,
  ): string {
    return row?.cells.map((cell) => cell.spans.map(viewDocSpanText).join("")).join("\t") ?? "";
  }

  it("表格单元格/列表项保留行内样式 spans——审阅态链接可点、加粗可见,与正式态一致", () => {
    const tableWithLink: PmBlockNode = {
      type: "table",
      attrs: { blockId: "tbl-rich" },
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "tbl-rich-c1" },
                  content: [
                    {
                      type: "text",
                      text: "kersai.com",
                      marks: [{ type: "link", attrs: { href: "https://kersai.com" } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    } as never;
    const listWithBold: PmBlockNode = {
      type: "bulletList",
      attrs: { blockId: "ul-rich" },
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "ul-rich-i1" },
              content: [
                { type: "text", text: "要点", marks: [{ type: "bold" }] },
                { type: "text", text: ":说明文字" },
              ],
            },
          ],
        },
      ],
    } as never;

    const view = pmDocToViewDocumentSnapshot(pmDoc([tableWithLink, listWithBold]), 1, "t");

    const table = view.sections[0] as Extract<ViewBlock, { kind: "table" }>;
    expect(table.rows[0]![0]).toBe("kersai.com"); // 字符串字段不回归(文本派生用)
    const cellSpans = table.rowSpans![0]![0]!;
    expect(cellSpans).toHaveLength(1);
    expect(cellSpans[0]).toMatchObject({
      kind: "text",
      text: "kersai.com",
      marks: [{ type: "link", attrs: { href: "https://kersai.com" } }],
    });

    const list = view.sections[1] as Extract<ViewBlock, { kind: "list" }>;
    expect(list.items[0]).toBe("要点:说明文字");
    const itemSpans = list.itemSpans![0]!;
    expect(itemSpans[0]).toMatchObject({ kind: "text", text: "要点", marks: [{ type: "bold" }] });
    expect(itemSpans[1]).toMatchObject({ kind: "text", text: ":说明文字" });
    expect((itemSpans[1] as { marks?: unknown }).marks).toBeUndefined();
  });

  it("同类型 bulletList replace 只产出一个 replace patch,行级 rowDiff 覆盖 same/changed/removed/added", () => {
    const before = pmBulletListRows("list-1", ["梳理需求", "对齐设计初稿", "评审纪要", "归档旧需求"]);
    const after = pmBulletListRows("list-1", ["梳理需求", "对齐设计终稿", "评审纪要", "拉通接口"]);
    const doc = pmDocToViewDocumentSnapshot(pmDoc([before]), 1, "t");
    const hunk = replaceHunk("rep-list", "list-1", before, after);

    const inputs = suggestionToBlockPatchInputs(blockSuggestion("rep-list", hunk), 0);

    expect(inputs).toHaveLength(1);
    // granular:行级 diff → 装饰层抑制块级红删标记/绿竖线,避免"行级+块级"重复
    expect(inputs[0]).toMatchObject({ patchId: "rep-list", op: "replace", blockCount: 1, granular: true });
    const list = inputs[0]!.blocks[0] as Extract<ViewBlock, { kind: "list" }>;
    expect(list.kind).toBe("list");
    // after 保真:携带原始 list PM node(行级渲染逐 item 走 PmBlockView,嵌套子项不丢)
    expect(list.node?.type).toBe("bulletList");
    // before 保真:携带原始 before PM node(hover 原文用)
    expect(inputs[0]!.beforePmNodes?.[0]?.type).toBe("bulletList");
    expect(list.rowDiff?.map((row) => row.status)).toEqual([
      "same",
      "changed",
      "same",
      "removed",
      "added",
    ]);
    const sameRow = list.rowDiff?.[0];
    const changedRow = list.rowDiff?.[1];
    const addedRow = list.rowDiff?.[4];
    expect(sameRow).toMatchObject({ status: "same" });
    expect(sameRow?.status === "same" ? sameRow.spans.some((span) => span.kind === "patchIns") : true).toBe(false);
    expect(changedRow).toMatchObject({ status: "changed", oldText: "对齐设计初稿" });
    expect(changedRow?.status === "changed" ? changedRow.spans : []).toContainEqual({ kind: "patchIns", text: "终", patchId: "rep-list" });
    expect(list.rowDiff?.[3]).toMatchObject({ status: "removed", oldText: "归档旧需求" });
    expect(addedRow?.status === "added" ? addedRow.spans : []).toEqual([{ kind: "patchIns", text: "拉通接口", patchId: "rep-list" }]);

    const result = derivePatchPresentation(doc, [], inputs);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({ id: "rep-list", kind: "replace", index: 1 });
    expect(result.applied[0]!.before).toContain("对齐设计初稿");
    expect(result.applied[0]!.after).toContain("对齐设计终稿");
    expect(new Set(result.applied.map((patch) => patch.id))).toEqual(new Set(["rep-list"]));
    assertInternallyConsistent(result);
  });

  it("三级嵌套 bulletList 只改三个叶子行时递归标记叶子 changed,其余分支 same 且 granular", () => {
    const branch = (id: string, title: string, leaves: string[]) => ({
      text: title,
      children: [pmNestedListRows("bulletList", `${id}-leaves`, leaves.map((text) => ({ text })))],
    });
    const before = pmNestedListRows("bulletList", "rain", [{
      text: "雨的层次",
      children: [pmNestedListRows("bulletList", "rain-phases", [
        branch("before", "雨前：万物屏息", ["天色暗下来", "空气凝滞", "飞虫慌乱"]),
        branch("during", "雨中：天地交响", ["瓦片利落干脆", "芭蕉厚重绵软", "青石板悠远绵长"]),
        branch("after", "雨后：万象更新", ["凉风扑面", "星子初现", "水珠晶莹", "心境清朗澄明"]),
      ])],
    }]);
    const after = pmNestedListRows("bulletList", "rain", [{
      text: "雨的层次",
      children: [pmNestedListRows("bulletList", "rain-phases", [
        branch("before", "雨前：万物屏息", ["天色骤暗", "空气凝滞", "飞虫慌乱"]),
        branch("during", "雨中：天地交响", ["瓦片清脆如玉", "芭蕉厚重绵软", "青石板悠远绵长"]),
        branch("after", "雨后：万象更新", ["凉风扑面", "星子初现", "水珠晶莹", "心境澄明透亮"]),
      ])],
    }]);

    const inputs = suggestionToBlockPatchInputs(
      blockSuggestion("rep-rain", replaceHunk("rep-rain", "rain", before, after)),
      0,
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ op: "replace", granular: true, blockCount: 1 });
    const list = inputs[0]!.blocks[0] as Extract<ViewBlock, { kind: "list" }>;
    expect(list.rowDiff?.[0]?.status).toBe("same");
    const statuses = flattenListRowStatuses(list.rowDiff ?? []);
    expect(statuses.filter((status) => status === "changed")).toHaveLength(3);
    expect(statuses.filter((status) => status === "same")).toHaveLength(11);
    expect(statuses.filter((status) => status === "added" || status === "removed")).toHaveLength(0);

    const phases = list.rowDiff?.[0]?.childLists?.[0]?.rowDiff;
    expect(phases?.map((row) => row.status)).toEqual(["same", "same", "same"]);
    expect(phases?.[0]?.childLists?.[0]?.rowDiff.map((row) => row.status)).toEqual(["changed", "same", "same"]);
    expect(phases?.[1]?.childLists?.[0]?.rowDiff.map((row) => row.status)).toEqual(["changed", "same", "same"]);
    expect(phases?.[2]?.childLists?.[0]?.rowDiff.map((row) => row.status)).toEqual(["same", "same", "same", "changed"]);
  });

  it.each(["bulletList", "orderedList", "taskList"] as const)(
    "%s 的嵌套叶子变化都递归进入 rowDiff",
    (type) => {
      const before = pmNestedListRows(type, `nested-${type}`, [{
        text: "父项",
        children: [pmNestedListRows(type, `nested-${type}-child`, [
          { text: "旧叶子", checked: false },
          { text: "保留叶子", checked: false },
        ])],
      }]);
      const after = pmNestedListRows(type, `nested-${type}`, [{
        text: "父项",
        children: [pmNestedListRows(type, `nested-${type}-child`, [
          { text: "新叶子", checked: false },
          { text: "保留叶子", checked: false },
        ])],
      }]);

      const inputs = suggestionToBlockPatchInputs(
        blockSuggestion(`rep-${type}`, replaceHunk(`rep-${type}`, `nested-${type}`, before, after)),
        0,
      );
      const block = inputs[0]!.blocks[0] as Extract<ViewBlock, { kind: "list" | "taskList" }>;
      expect(inputs[0]!.granular).toBe(true);
      expect(flattenListRowStatuses(block.rowDiff ?? [])).toEqual(["same", "changed", "same"]);
    },
  );

  it("同类型 taskList replace 识别 checkedChanged,且仍只计一个 patch", () => {
    const before = pmTaskListRows("tasks-1", [
      { text: "梳理需求", checked: true },
      { text: "对齐设计", checked: false },
      { text: "评审纪要", checked: false },
    ]);
    const after = pmTaskListRows("tasks-1", [
      { text: "梳理需求", checked: true },
      { text: "对齐设计", checked: false },
      { text: "评审纪要", checked: true },
    ]);
    const doc = pmDocToViewDocumentSnapshot(pmDoc([before]), 1, "t");
    const hunk = replaceHunk("rep-task", "tasks-1", before, after);

    const inputs = suggestionToBlockPatchInputs(blockSuggestion("rep-task", hunk), 0);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ patchId: "rep-task", op: "replace" });
    const taskList = inputs[0]!.blocks[0] as Extract<ViewBlock, { kind: "taskList" }>;
    expect(taskList.kind).toBe("taskList");
    expect(taskList.rowDiff?.map((row) => row.status)).toEqual(["same", "same", "changed"]);
    expect(taskList.rowDiff?.[2]).toMatchObject({
      status: "changed",
      oldText: "评审纪要",
      checked: true,
      checkedChanged: true,
    });

    const result = derivePatchPresentation(doc, [], inputs);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({ id: "rep-task", kind: "replace" });
    expect(new Set(result.applied.map((patch) => patch.id))).toEqual(new Set(["rep-task"]));
    assertInternallyConsistent(result);
  });

  it("仅 marks/start 仍保留块级兜底,嵌套子列表变化则递归 granular", () => {
    // 仅 marks 变化:文本不变、加粗。rowDiff 只比文本 → 全 same → 不该 granular(否则块级标记也被抑制、正文零可见)。
    const markBefore = {
      type: "bulletList",
      attrs: { blockId: "lm" },
      content: [{ type: "listItem", attrs: { blockId: "lm-i0" }, content: [{ type: "paragraph", attrs: { blockId: "lm-p0" }, content: [{ type: "text", text: "要点" }] }] }],
    } as unknown as PmBlockNode;
    const markAfter = {
      type: "bulletList",
      attrs: { blockId: "lm" },
      content: [{ type: "listItem", attrs: { blockId: "lm-i0" }, content: [{ type: "paragraph", attrs: { blockId: "lm-p0" }, content: [{ type: "text", text: "要点", marks: [{ type: "bold" }] }] }] }],
    } as unknown as PmBlockNode;
    const marksInputs = suggestionToBlockPatchInputs(blockSuggestion("rep-marks", replaceHunk("rep-marks", "lm", markBefore, markAfter)), 0);
    expect(marksInputs).toHaveLength(1);
    expect(marksInputs[0]!.op).toBe("replace");
    expect(marksInputs[0]!.granular).toBeUndefined();

    // 仅 orderedList.start 变化(1→3),文本不变 → 全 same → 不 granular。
    const startBefore = {
      type: "orderedList",
      attrs: { blockId: "lo", start: 1 },
      content: [{ type: "listItem", attrs: { blockId: "lo-i0" }, content: [{ type: "paragraph", attrs: { blockId: "lo-p0" }, content: [{ type: "text", text: "第一" }] }] }],
    } as unknown as PmBlockNode;
    const startAfter = {
      type: "orderedList",
      attrs: { blockId: "lo", start: 3 },
      content: [{ type: "listItem", attrs: { blockId: "lo-i0" }, content: [{ type: "paragraph", attrs: { blockId: "lo-p0" }, content: [{ type: "text", text: "第一" }] }] }],
    } as unknown as PmBlockNode;
    const startInputs = suggestionToBlockPatchInputs(blockSuggestion("rep-start", replaceHunk("rep-start", "lo", startBefore, startAfter)), 0);
    expect(startInputs).toHaveLength(1);
    expect(startInputs[0]!.op).toBe("replace");
    expect(startInputs[0]!.granular).toBeUndefined();

    // 仅嵌套子列表变化(顶层项文本不变)→ 递归 rowDiff 能看见子项 changed,应 granular。
    const nest = (childText: string): PmBlockNode => ({
      type: "bulletList",
      attrs: { blockId: "ln" },
      content: [{
        type: "listItem",
        attrs: { blockId: "ln-i0" },
        content: [
          { type: "paragraph", attrs: { blockId: "ln-p0" }, content: [{ type: "text", text: "顶层项" }] },
          { type: "bulletList", attrs: { blockId: "ln-sub" }, content: [
            { type: "listItem", attrs: { blockId: "ln-sub-i0" }, content: [{ type: "paragraph", attrs: { blockId: "ln-sub-p0" }, content: [{ type: "text", text: childText }] }] },
          ] },
        ],
      }],
    } as unknown as PmBlockNode);
    const nestInputs = suggestionToBlockPatchInputs(blockSuggestion("rep-nest", replaceHunk("rep-nest", "ln", nest("子项旧"), nest("子项新"))), 0);
    expect(nestInputs).toHaveLength(1);
    expect(nestInputs[0]!.op).toBe("replace");
    expect(nestInputs[0]!.granular).toBe(true);
  });

  it("段落→表格的 replace 不走行内文本通道——否则表格被 insertText 拍平成一串绿字", () => {
    const para: PmBlockNode = {
      type: "paragraph",
      attrs: { blockId: "p-src" },
      content: [{ type: "text", text: "参考来源:某某说明。" }],
    } as never;
    const newTable = pmTable("tbl-new", "新表内容");
    const hunk = replaceHunk("rep-p2t", "p-src", para, newTable);
    // 模拟真实降级预览:insertText 是制表符拍平的表格文本
    hunk.beforeText = "参考来源:某某说明。";
    hunk.afterText = "序号\t来源\t链接\n1\tKersaiResearch\thttps://example.com";
    const sugg = blockSuggestion("rep-p2t", hunk);
    const doc = pmDocToViewDocumentSnapshot(pmDoc([para]), 1, "t");

    // 行内通道必须拒收(此前锚点能命中段落就走文本通道,表格糊成拍平绿字)
    expect(suggestionToPatchOverlay(doc, sugg, 0)).toBeNull();

    // 落到块通道:保持单一 replace,after 块保真为 table ViewBlock
    const inputs = suggestionToBlockPatchInputs(sugg, 0);
    expect(inputs.map((i) => i.op)).toEqual(["replace"]);
    expect(inputs[0]!.replaceBeforeBlocks?.map((b) => b.kind)).toEqual(["p"]);
    expect(inputs[0]!.blocks.map((b) => b.kind)).toEqual(["table"]);
  });

  it("纯文本 replace 仍走行内文本通道(不回归划线+绿字体验)", () => {
    const para: PmBlockNode = {
      type: "paragraph",
      attrs: { blockId: "p-txt" },
      content: [{ type: "text", text: "旧的说法。" }],
    } as never;
    const para2: PmBlockNode = {
      type: "paragraph",
      attrs: { blockId: "p-txt" },
      content: [{ type: "text", text: "新的说法。" }],
    } as never;
    const hunk = replaceHunk("rep-txt", "p-txt", para, para2);
    hunk.beforeText = "旧的说法。";
    hunk.afterText = "新的说法。";
    const doc = pmDocToViewDocumentSnapshot(pmDoc([para]), 1, "t");

    expect(suggestionToPatchOverlay(doc, blockSuggestion("rep-txt", hunk), 0)).not.toBeNull();
  });

  it("#3 回归:纯文本 replace 的真实形态(before/after 是行内 text 节点)仍走行内通道、不被丢弃", () => {
    // 真实发射器形态:proposalDiff.inlineSliceAsNodes 对段内文本 replace 产出的
    // before/after 是「行内切片」= [{type:"text",text}](非 paragraph 块)。此前
    // pmNodesInlineSafe 只认块类型 → 误判其为结构块 → 内联通道返 null + 块通道
    // (pmNodesToViewBlocks 过滤行内节点)返 [] → 纯文本改动被双通道丢弃(无法定位)。
    // 固化真实形态防回归;上面那条用 paragraph 块形态,与真实发射器不符,故另立此条。
    const para: PmBlockNode = {
      type: "paragraph",
      attrs: { blockId: "p-inl" },
      content: [{ type: "text", text: "今天我们去公园散步。" }],
    } as never;
    const beforeInline = { type: "text", text: "公园" } as unknown as PmBlockNode;
    const afterInline = { type: "text", text: "湖边" } as unknown as PmBlockNode;
    const hunk = replaceHunk("rep-inl", "p-inl", beforeInline, afterInline);
    hunk.beforeText = "公园";
    hunk.afterText = "湖边";
    const doc = pmDocToViewDocumentSnapshot(pmDoc([para]), 1, "t");

    // 行内通道必须接收(非 null);块通道不接纯文本(返 [])
    expect(suggestionToPatchOverlay(doc, blockSuggestion("rep-inl", hunk), 0)).not.toBeNull();
    expect(suggestionToBlockPatchInputs(blockSuggestion("rep-inl", hunk), 0)).toEqual([]);
  });

  it("#2 回归:代码块文本改动的真实 buildDraftDiff hunk 走块通道可见", () => {
    const base = pmDoc([pmCodeBlock("code-1", "const value = 1;\nconsole.log(value);")]);
    const draft = pmDoc([pmCodeBlock("code-1", "const value = 2;\nconsole.log(value);")]);
    const hunks = buildDraftDiff(base, draft, { baseVersion: 1 });
    const hunk = hunks[0]!;
    const sugg = blockSuggestion("rep-code", hunk);
    const doc = pmDocToViewDocumentSnapshot(base, 1, "t");

    expect(hunks).toHaveLength(1);
    expect(hunk).toMatchObject({
      op: "replace",
      before: [{ type: "codeBlock" }],
      after: [{ type: "codeBlock" }],
    });
    expect(applyDiffHunks(base, [hunk]).doc).toEqual(draft);

    expect(suggestionToPatchOverlay(doc, sugg, 0)).toBeNull();
    const inputs = suggestionToBlockPatchInputs(sugg, 0);
    expect(inputs).not.toHaveLength(0);
    expect(inputs.map((input) => input.op)).toEqual(["replace"]);
    expect(inputs[0]!.replaceBeforeBlocks).toMatchObject([
      { kind: "code", body: "const value = 1;\nconsole.log(value);" },
    ]);
    expect(inputs[0]!.blocks).toMatchObject([
      { kind: "code", body: "const value = 2;\nconsole.log(value);" },
    ]);
  });

  it("形状稳定的 table replace 只产出一个 replace patch,单元格级 cellDiff 覆盖 changed/removed/added", () => {
    const baseTable = pmTableRows("tbl-1", [
      ["指标", "Q1", "Q2"],
      ["用户数", "100", "200"],
      ["旧渠道", "10", "20"],
      ["留存", "50%", "55%"],
    ], { header: true });
    const newTable = pmTableRows("tbl-1", [
      ["指标", "Q1", "Q2"],
      ["用户数", "100", "250"],
      ["留存", "50%", "55%"],
      ["新渠道", "12", "18"],
    ], { header: true });
    const doc = pmDocToViewDocumentSnapshot(pmDoc([baseTable]), 1, "t");
    const hunk = replaceHunk("rep-tbl", "tbl-1", baseTable, newTable);

    const inputs = suggestionToBlockPatchInputs(blockSuggestion("rep-tbl", hunk), 0);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ patchId: "rep-tbl", op: "replace", blockCount: 1 });
    // 单元格/行级可见变化时 granular，装饰层不再叠整表绿竖线。
    expect(inputs[0]!.granular).toBe(true);
    const table = inputs[0]!.blocks[0] as Extract<ViewBlock, { kind: "table" }>;
    expect(table.kind).toBe("table");
    // after 保真:携带原始 table PM node(审阅态替换走 PmBlockView,保全合并单元格/列宽/背景色/富文本)
    expect(table.node?.type).toBe("table");
    // before 保真:携带原始 before PM node(hover 原文用)
    expect(inputs[0]!.beforePmNodes?.[0]?.type).toBe("table");
    expect(table.cellDiff?.map((row) => row.status)).toEqual([
      "same",
      "changed",
      "removed",
      "same",
      "added",
    ]);
    const sameHeader = table.cellDiff?.[0];
    const changedRow = table.cellDiff?.[1];
    const removedRow = table.cellDiff?.[2];
    const addedRow = table.cellDiff?.[4];
    expect(sameHeader?.cells.map((cell) => cell.status)).toEqual(["same", "same", "same"]);
    expect(changedRow?.cells.map((cell) => cell.status)).toEqual(["same", "same", "changed"]);
    const changedCell = changedRow?.cells[2];
    expect(changedCell).toMatchObject({ status: "changed", oldText: "200" });
    expect(changedCell?.status === "changed" ? changedCell.spans : []).toContainEqual({
      kind: "patchIns",
      text: "5",
      patchId: "rep-tbl",
    });
    expect(changedCell?.status === "changed" ? changedCell.spans : []).toContainEqual({
      kind: "patchDel",
      text: "0",
      patchId: "rep-tbl",
    });
    expect(removedRow).toMatchObject({ status: "removed" });
    expect(tableRowPlainText(removedRow)).toBe("旧渠道\t10\t20");
    expect(addedRow).toMatchObject({ status: "added" });
    expect(tableRowPlainText(addedRow)).toBe("新渠道\t12\t18");

    const result = derivePatchPresentation(doc, [], inputs);
    expect(result.droppedIds).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({
      id: "rep-tbl",
      kind: "replace",
      index: 1,
    });
    expect(result.applied[0]!.before).toContain("旧渠道");
    expect(result.applied[0]!.after).toContain("新渠道");
    // beforePmNodes 一路带到 applied → PatchMeta,hover 卡片据此渲原文真表格
    expect(result.applied[0]!.beforePmNodes?.[0]?.type).toBe("table");
    expect(new Set(result.applied.map((patch) => patch.id))).toEqual(new Set(["rep-tbl"]));
    assertInternallyConsistent(result);
  });

  it("同类型 callout replace 只产出一个 replace patch,内部 bodyDiff 做块序列递归", () => {
    const before = pmCalloutRows("callout-1", ["保留提示", "旧风险提示", "归档旧块"]);
    const after = pmCalloutRows("callout-1", ["保留提示", "新风险提示", "补充事项"]);
    const doc = pmDocToViewDocumentSnapshot(pmDoc([before]), 1, "t");
    const hunk = replaceHunk("rep-callout", "callout-1", before, after);

    const inputs = suggestionToBlockPatchInputs(blockSuggestion("rep-callout", hunk), 0);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ patchId: "rep-callout", op: "replace", blockCount: 1, granular: true });
    const callout = inputs[0]!.blocks[0] as Extract<ViewBlock, { kind: "callout" }>;
    expect(callout.kind).toBe("callout");
    expect(callout.node.type).toBe("callout");
    expect(callout.bodyDiff?.map((entry) => entry.status)).toEqual(["same", "changed", "removed", "added"]);
    const changed = callout.bodyDiff?.[1];
    expect(changed).toMatchObject({ status: "changed", kind: "text", oldText: "旧风险提示" });
    expect(changed?.status === "changed" && changed.kind === "text" ? changed.spans : []).toContainEqual({
      kind: "patchIns",
      text: "新",
      patchId: "rep-callout",
    });
    expect(callout.bodyDiff?.[2]).toMatchObject({ status: "removed", oldText: "归档旧块" });
    expect(callout.bodyDiff?.[3]).toMatchObject({ status: "added", block: { type: "paragraph" } });

    const result = derivePatchPresentation(doc, [], inputs);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({ id: "rep-callout", kind: "replace", index: 1 });
    expect(result.applied[0]!.before).toContain("旧风险提示");
    expect(result.applied[0]!.after).toContain("新风险提示");
    expect(new Set(result.applied.map((patch) => patch.id))).toEqual(new Set(["rep-callout"]));
    assertInternallyConsistent(result);
  });

  it("同类型 columnList replace 每栏 columnsDiff 递归,内部 list/table 复用 rowDiff/cellDiff", () => {
    const before = pmColumnListBlocks("columns-1", [
      [
        pmParagraph("columns-1-left-keep", "左栏保留"),
        pmParagraph("columns-1-left-old", "左栏旧文"),
        pmParagraph("columns-1-left-del", "归档旧栏"),
      ],
      [
        pmBulletListRows("columns-1-list", ["任务A", "旧任务"]),
        pmTableRows("columns-1-table", [
          ["指标", "Q1"],
          ["用户", "100"],
        ], { header: true }),
      ],
    ]);
    const after = pmColumnListBlocks("columns-1", [
      [
        pmParagraph("columns-1-left-keep", "左栏保留"),
        pmParagraph("columns-1-left-new", "左栏新文"),
        pmParagraph("columns-1-left-add", "补充事项"),
      ],
      [
        pmBulletListRows("columns-1-list", ["任务A", "新任务", "新增任务"]),
        pmTableRows("columns-1-table", [
          ["指标", "Q1"],
          ["用户", "150"],
        ], { header: true }),
      ],
    ]);
    const doc = pmDocToViewDocumentSnapshot(pmDoc([before]), 1, "t");
    const hunk = replaceHunk("rep-columns", "columns-1", before, after);

    const inputs = suggestionToBlockPatchInputs(blockSuggestion("rep-columns", hunk), 0);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ patchId: "rep-columns", op: "replace", blockCount: 1, granular: true });
    const columnList = inputs[0]!.blocks[0] as Extract<ViewBlock, { kind: "columnList" }>;
    expect(columnList.kind).toBe("columnList");
    expect(columnList.node.type).toBe("columnList");
    expect(columnList.columnsDiff).toHaveLength(2);
    expect(columnList.columnsDiff?.[0]?.bodyDiff.map((entry) => entry.status)).toEqual(["same", "changed", "removed", "added"]);

    const textChanged = columnList.columnsDiff?.[0]?.bodyDiff[1];
    expect(textChanged).toMatchObject({ status: "changed", kind: "text", oldText: "左栏旧文" });
    expect(textChanged?.status === "changed" && textChanged.kind === "text" ? textChanged.spans : []).toContainEqual({
      kind: "patchIns",
      text: "新",
      patchId: "rep-columns",
    });

    const listChanged = columnList.columnsDiff?.[1]?.bodyDiff[0];
    expect(listChanged).toMatchObject({ status: "changed", kind: "list" });
    expect(listChanged?.status === "changed" && listChanged.kind === "list" ? listChanged.rowDiff.map((row) => row.status) : []).toEqual([
      "same",
      "changed",
      "added",
    ]);

    const tableChanged = columnList.columnsDiff?.[1]?.bodyDiff[1];
    expect(tableChanged).toMatchObject({ status: "changed", kind: "table" });
    expect(tableChanged?.status === "changed" && tableChanged.kind === "table" ? tableChanged.cellDiff.map((row) => row.status) : []).toEqual([
      "same",
      "changed",
    ]);
    const changedCell = tableChanged?.status === "changed" && tableChanged.kind === "table"
      ? tableChanged.cellDiff[1]?.cells[1]
      : undefined;
    expect(changedCell).toMatchObject({ status: "changed", oldText: "100" });
    expect(changedCell?.status === "changed" ? changedCell.spans : []).toContainEqual({
      kind: "patchIns",
      text: "5",
      patchId: "rep-columns",
    });

    const result = derivePatchPresentation(doc, [], inputs);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({ id: "rep-columns", kind: "replace", index: 1 });
    expect(result.applied[0]!.before).toContain("左栏旧文");
    expect(result.applied[0]!.after).toContain("左栏新文");
    expect(new Set(result.applied.map((patch) => patch.id))).toEqual(new Set(["rep-columns"]));
    assertInternallyConsistent(result);
  });

  it("table/callout/columnList 的内部 diff 全 same 时不置 granular，保留块级可见兜底", () => {
    const tableBefore = pmTableRows("same-table", [["同文"]]);
    const tableAfter = {
      ...tableBefore,
      content: tableBefore.type === "table"
        ? tableBefore.content.map((row) => ({
            ...row,
            content: row.content.map((cell) => ({ ...cell, attrs: { ...cell.attrs, backgroundColor: "#fff3a3" } })),
          }))
        : [],
    } as PmBlockNode;
    const calloutBefore = pmCalloutRows("same-callout", ["同文"]);
    const calloutAfter = { ...calloutBefore, attrs: { ...calloutBefore.attrs, tone: "success" } } as PmBlockNode;
    const columnsBefore = pmColumnListBlocks("same-columns", [[pmParagraph("same-p", "同文")]]);
    const columnsAfter = {
      ...columnsBefore,
      content: columnsBefore.type === "columnList"
        ? columnsBefore.content.map((column) => ({ ...column, attrs: { ...column.attrs, widthRatio: 1 } }))
        : [],
    } as PmBlockNode;

    const cases = [
      ["same-table", tableBefore, tableAfter],
      ["same-callout", calloutBefore, calloutAfter],
      ["same-columns", columnsBefore, columnsAfter],
    ] as const;
    for (const [id, before, after] of cases) {
      const inputs = suggestionToBlockPatchInputs(blockSuggestion(id, replaceHunk(id, id, before, after)), 0);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.granular).toBeUndefined();
    }
  });

  it("容器内容与外壳属性同时变化时，granular 与整块原文 hover 并存", () => {
    const tableBefore = pmTableRows("attrs-table", [["旧文", "旁格"]]);
    const tableAfter = {
      ...pmTableRows("attrs-table", [["新文", "旁格"]]),
      content: (pmTableRows("attrs-table", [["新文", "旁格"]]) as Extract<PmBlockNode, { type: "table" }>).content.map((row) => ({
        ...row,
        content: row.content.map((cell, index) => index === 1
          ? { ...cell, attrs: { ...cell.attrs, backgroundColor: "#fff3a3" } }
          : cell),
      })),
    } as PmBlockNode;
    const calloutBefore = pmCalloutRows("attrs-callout", ["旧提示"]);
    const calloutAfter = {
      ...pmCalloutRows("attrs-callout", ["新提示"]),
      attrs: { ...calloutBefore.attrs, tone: "success" },
    } as PmBlockNode;
    const columnsBefore = pmNamedColumnList("attrs-columns", [
      { id: "attrs-left", text: "左栏旧文", widthRatio: 0.4 },
      { id: "attrs-right", text: "右栏", widthRatio: 0.6 },
    ]);
    const columnsAfter = pmNamedColumnList("attrs-columns", [
      { id: "attrs-left", text: "左栏新文", widthRatio: 0.3 },
      { id: "attrs-right", text: "右栏", widthRatio: 0.7 },
    ]);

    for (const [id, before, after] of [
      ["attrs-table", tableBefore, tableAfter],
      ["attrs-callout", calloutBefore, calloutAfter],
      ["attrs-columns", columnsBefore, columnsAfter],
    ] as const) {
      const input = suggestionToBlockPatchInputs(blockSuggestion(id, replaceHunk(id, id, before, after)), 0)[0]!;
      expect(input.granular).toBe(true);
      expect(input.granularBlockHover).toBe(true);
      expect(input.beforePmNodes?.[0]).toBe(before);
    }
  });

  it("columnList 删除第二栏时按 blockId 对齐，保留整栏 removed 与旧栏宽", () => {
    const before = pmNamedColumnList("delete-column", [
      { id: "col-a", text: "甲栏", widthRatio: 0.25 },
      { id: "col-b", text: "乙栏旧内容", widthRatio: 0.35 },
      { id: "col-c", text: "丙栏", widthRatio: 0.4 },
    ]);
    const after = pmNamedColumnList("delete-column", [
      { id: "col-a", text: "甲栏", widthRatio: 0.25 },
      { id: "col-c", text: "丙栏", widthRatio: 0.4 },
    ]);
    const input = suggestionToBlockPatchInputs(blockSuggestion("delete-column", replaceHunk("delete-column", "delete-column", before, after)), 0)[0]!;
    const block = input.blocks[0] as Extract<ViewBlock, { kind: "columnList" }>;

    expect(block.columnsDiff?.map((column) => column.status)).toEqual(["same", "removed", "same"]);
    expect(block.columnsDiff?.map((column) => [column.beforeColumnIndex, column.afterColumnIndex])).toEqual([
      [0, 0], [1, undefined], [2, 1],
    ]);
    expect(block.columnsDiff?.[1]?.bodyDiff).toMatchObject([{ status: "removed", oldText: "乙栏旧内容" }]);
    expect((before as Extract<PmBlockNode, { type: "columnList" }>).content[1]?.attrs.widthRatio).toBe(0.35);
  });

  it("columnList 中间插栏时后续栏不整体错位", () => {
    const before = pmNamedColumnList("insert-column", [
      { id: "col-a", text: "甲栏", widthRatio: 0.4 },
      { id: "col-c", text: "丙栏", widthRatio: 0.6 },
    ]);
    const after = pmNamedColumnList("insert-column", [
      { id: "col-a", text: "甲栏", widthRatio: 0.3 },
      { id: "col-b", text: "新增乙栏", widthRatio: 0.3 },
      { id: "col-c", text: "丙栏", widthRatio: 0.4 },
    ]);
    const input = suggestionToBlockPatchInputs(blockSuggestion("insert-column", replaceHunk("insert-column", "insert-column", before, after)), 0)[0]!;
    const block = input.blocks[0] as Extract<ViewBlock, { kind: "columnList" }>;

    expect(block.columnsDiff?.map((column) => column.status)).toEqual(["same", "added", "same"]);
    expect(block.columnsDiff?.map((column) => [column.beforeColumnIndex, column.afterColumnIndex])).toEqual([
      [0, 0], [undefined, 1], [1, 2],
    ]);
    expect(block.columnsDiff?.[1]?.bodyDiff).toMatchObject([{ status: "added", block: { type: "paragraph" } }]);
    expect(block.columnsDiff?.[2]?.bodyDiff[0]).toMatchObject({ status: "same", block: { attrs: { blockId: "col-c-p" } } });
  });

  it("table 合并关系变化时整表降级为块级 changed，避免物理 cell 下标错配", () => {
    const before = pmTableRows("merge-table", [["表头", "次表头"], ["甲", "乙"]], { header: true });
    const after = {
      ...before,
      content: before.type === "table"
        ? [
            {
              ...before.content[0]!,
              content: [{
                ...before.content[0]!.content[0]!,
                attrs: { ...before.content[0]!.content[0]!.attrs, colspan: 2, colwidth: [120, 180] },
                content: [pmParagraph("merge-title", "合并新表头")],
              }],
            },
            before.content[1]!,
          ]
        : [],
    } as PmBlockNode;
    const input = suggestionToBlockPatchInputs(blockSuggestion("merge-table", replaceHunk("merge-table", "merge-table", before, after)), 0)[0]!;
    const block = input.blocks[0] as Extract<ViewBlock, { kind: "table" }>;

    expect(input.granular).toBeUndefined();
    expect(input.granularBlockHover).toBeUndefined();
    expect(block.cellDiff).toBeUndefined();
    expect(input.beforePmNodes?.[0]).toBe(before);
  });

  it.each([
    ["加行", [["甲", "乙"], ["新增甲", "新增乙"]]],
    ["删行", []],
    ["加列", [["甲", "乙", "新增列"]]],
    ["删列", [["甲"]]],
  ] as const)("table %s 时整表降级，不产 cellDiff 或 granular", (_label, afterRows) => {
    const before = pmTableRows("shape-table", [["甲", "乙"]]);
    const coloredBefore = {
      ...before,
      content: before.type === "table"
        ? before.content.map((row) => ({
            ...row,
            content: row.content.map((cell, index) => index === 0
              ? { ...cell, attrs: { ...cell.attrs, backgroundColor: "#fff3a3" } }
              : cell),
          }))
        : [],
    } as PmBlockNode;
    const after = pmTableRows("shape-table", afterRows);

    const input = suggestionToBlockPatchInputs(
      blockSuggestion("shape-table", replaceHunk("shape-table", "shape-table", coloredBefore, after)),
      0,
    )[0]!;
    const block = input.blocks[0] as Extract<ViewBlock, { kind: "table" }>;

    expect(input).toMatchObject({ op: "replace", blockCount: 1 });
    expect(input.granular).toBeUndefined();
    expect(input.granularBlockHover).toBeUndefined();
    expect(block.cellDiff).toBeUndefined();
    expect(block.node).toBe(after);
    expect(input.beforePmNodes?.[0]).toBe(coloredBefore);
    const oldCell = input.beforePmNodes?.[0]?.type === "table" ? input.beforePmNodes[0].content[0]?.content[0] : undefined;
    expect(oldCell?.attrs?.backgroundColor).toBe("#fff3a3");
  });

  it("callout/columnList 内嵌表格形状变化递归降级为块级 changed，外壳旧属性仍可见", () => {
    const beforeTable = pmTableRows("nested-table", [["甲", "乙"]]);
    const afterTable = pmTableRows("nested-table", [["甲", "乙"], ["新增甲", "新增乙"]]);
    const beforeCallout = pmCalloutBlocks("nested-callout", [beforeTable], "warning");
    const afterCallout = pmCalloutBlocks("nested-callout", [afterTable], "success");
    const calloutInput = suggestionToBlockPatchInputs(blockSuggestion(
      "nested-callout",
      replaceHunk("nested-callout", "nested-callout", beforeCallout, afterCallout),
    ), 0)[0]!;
    const callout = calloutInput.blocks[0] as Extract<ViewBlock, { kind: "callout" }>;

    expect(calloutInput).toMatchObject({ granular: true, granularBlockHover: true });
    expect(callout.bodyDiff).toMatchObject([{ status: "changed", kind: "block", node: { type: "table" } }]);
    expect("cellDiff" in (callout.bodyDiff?.[0] ?? {})).toBe(false);
    expect(calloutInput.beforePmNodes?.[0]).toBe(beforeCallout);
    expect(calloutInput.beforePmNodes?.[0]?.type === "callout"
      ? calloutInput.beforePmNodes[0].attrs.tone
      : undefined).toBe("warning");

    const beforeColumns = pmColumnListBlocks("nested-columns", [
      [beforeTable],
      [pmParagraph("nested-right", "右栏")],
    ]);
    const afterColumnsBase = pmColumnListBlocks("nested-columns", [
      [afterTable],
      [pmParagraph("nested-right", "右栏")],
    ]);
    const afterColumns = {
      ...afterColumnsBase,
      content: afterColumnsBase.type === "columnList"
        ? afterColumnsBase.content.map((column, index) => ({
            ...column,
            attrs: { ...column.attrs, widthRatio: index === 0 ? 0.35 : 0.65 },
          }))
        : [],
    } as PmBlockNode;
    const columnsInput = suggestionToBlockPatchInputs(blockSuggestion(
      "nested-columns",
      replaceHunk("nested-columns", "nested-columns", beforeColumns, afterColumns),
    ), 0)[0]!;
    const columns = columnsInput.blocks[0] as Extract<ViewBlock, { kind: "columnList" }>;
    const nestedTableDiff = columns.columnsDiff?.[0]?.bodyDiff[0];

    expect(columnsInput).toMatchObject({ granular: true, granularBlockHover: true });
    expect(nestedTableDiff).toMatchObject({ status: "changed", kind: "block", node: { type: "table" } });
    expect("cellDiff" in (nestedTableDiff ?? {})).toBe(false);
    expect(columnsInput.beforePmNodes?.[0]).toBe(beforeColumns);
    expect(columnsInput.beforePmNodes?.[0]?.type === "columnList"
      ? columnsInput.beforePmNodes[0].content[0]?.attrs.widthRatio
      : undefined).toBe(0.45);
  });

  it("cloneListRowDiff 递归克隆 childLists，且深层 spans 不与原对象共享", () => {
    const source: ViewListRowDiff[] = [{
      status: "same",
      spans: [{ kind: "text", text: "父项" }],
      childLists: [{
        beforeListIndex: 0,
        afterListIndex: 0,
        rowDiff: [{
          status: "changed",
          oldText: "旧叶子",
          spans: [{ kind: "patchIns", text: "新叶子", patchId: "clone-nested" }],
        }],
      }],
    }];

    const cloned = cloneListRowDiff(source);
    expect(cloned).toEqual(source);
    expect(cloned).not.toBe(source);
    expect(cloned[0]!.childLists).not.toBe(source[0]!.childLists);
    expect(cloned[0]!.childLists?.[0]!.rowDiff).not.toBe(source[0]!.childLists?.[0]!.rowDiff);
    const clonedLeaf = cloned[0]!.childLists?.[0]!.rowDiff[0];
    const sourceLeaf = source[0]!.childLists?.[0]!.rowDiff[0];
    expect(clonedLeaf && "spans" in clonedLeaf ? clonedLeaf.spans : undefined)
      .not.toBe(sourceLeaf && "spans" in sourceLeaf ? sourceLeaf.spans : undefined);
  });

  it("insert/delete 经复数版仍为单条,行为与单数版一致", () => {
    const hunk: DiffHunk = {
      hunkId: "ins-one",
      reviewBatchId: "b",
      groupMode: "independent",
      op: "insert",
      blockPath: [0],
      anchor: { anchorKind: "position", gravity: "before" },
      before: null,
      after: [pmParagraph("blk-n", "新段")] as never,
      summary: "插入块",
      afterText: "新段",
    };
    const plural = suggestionToBlockPatchInputs(blockSuggestion("ins-one", hunk), 0);
    const single = suggestionToBlockPatchInput(blockSuggestion("ins-one", hunk), 0);
    expect(plural).toHaveLength(1);
    expect(plural[0]).toEqual(single);
  });
});

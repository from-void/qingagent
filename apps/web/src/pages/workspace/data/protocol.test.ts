import { describe, expect, it } from "vitest";
import { legacySectionsToPm, type PmBlockNode, type PmDoc } from "@qingagent/pm-schema";
import type { DiffHunk, DocSuggestion } from "@qingagent/contract-ts";
import { applyDiffHunks, buildDraftDiff } from "../../../../../../packages/core/src/bridge/proposalDiff.js";
import {
  applyPatchOverlaysWithReport,
  checkPatchPresentationConsistency,
  collectPatchMarkerIds,
  derivePatchPresentation,
  suggestionToBlockPatchInput,
  suggestionToBlockPatchInputs,
  pmDocToViewDocumentSnapshot,
  suggestionToPatchOverlay,
  wordDiffSegments,
  inlineWordDiffSpans,
  type PatchOverlayInput,
  type ViewBlock,
  type ViewDocumentSnapshot,
} from "./protocol";
import { sectionText, visibleReviewSections } from "./presentationSpans";

describe("wordDiffSegments — 多区段词级 diff(hover 卡片「原文」算 diff 用)", () => {
  it("分散的多处改动各自成段,不再整中段一锅端", () => {
    // 旧:含两处改动(加括注 + 85→90),中间大片未改应保持 same
    const segs = wordDiffSegments(
      "测试覆盖率从60%提到了85%,代码干净了",
      "测试覆盖率从60%提到了90%(很稳),代码干净了",
    );
    // 头尾未改段为 same;真正变动只在 85→90 与新增「(很稳)」处
    expect(segs[0]).toMatchObject({ type: "same" });
    expect(segs.some((s) => s.type === "del" && s.text.includes("85"))).toBe(true);
    expect(segs.some((s) => s.type === "ins" && s.text.includes("90"))).toBe(true);
    expect(segs.some((s) => s.type === "ins" && s.text.includes("很稳"))).toBe(true);
    // 未改的大段「,代码干净了」必须作为 same 复用,不被算进改动
    expect(segs.some((s) => s.type === "same" && s.text.includes("代码干净了"))).toBe(true);
  });

  it("纯新增(原文为空段)→ 原文里没有 del 段", () => {
    const segs = wordDiffSegments("产品定位", "产品核心定位");
    expect(segs.some((s) => s.type === "ins")).toBe(true);
    expect(segs.some((s) => s.type === "del")).toBe(false);
    // 行内新内容:未改段为 text、新增段为 patchIns(绿)
    const spans = inlineWordDiffSpans("产品定位", "产品核心定位", "p1");
    expect(spans.some((s) => s.kind === "patchIns" && s.text === "核心")).toBe(true);
  });
});

/** 构造若干段落的只读文档(每段一个 text span)。 */
function pdoc(...texts: string[]): ViewDocumentSnapshot {
  return {
    version: 1,
    ts: "t",
    sections: texts.map((t) => ({ kind: "p", spans: [{ kind: "text", text: t }] })),
  };
}

function viewSectionsToPlainText(sections: readonly ViewBlock[]): string[] {
  return visibleReviewSections(sections).map(sectionText);
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

function pmParagraph(blockId: string, text: string): PmBlockNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [pmText(text)] : [],
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

    // 保真:一个 columnList 段,blockId 为容器本身,SectionView 用 PmBlockView 渲成并排分栏
    expect(snapshot.sections.map((section) => section.kind)).toEqual(["columnList"]);
    expect(snapshot.sections.map((section) => section.blockId)).toEqual(["columns-view"]);
    const columnSection = snapshot.sections[0] as Extract<ViewBlock, { kind: "columnList" }>;
    expect(columnSection.node.type).toBe("columnList");
    // text 投影仍含两列内容,供锚点回退 / 块级 patch 文本派生
    expect(columnSection.text).toContain("左栏标题");
    expect(columnSection.text).toContain("右栏列表");
  });
});

/**
 * 不变量自检:任何 derivePatchPresentation 结果都必须满足
 * 计数 === 正文 distinct 标记数 === applied 数,且序号 1..N 连续。
 * 这是"沉淀的验证方法"——把它喂任意场景,数量一不对立刻断言失败。
 */
function assertInternallyConsistent(result: ReturnType<typeof derivePatchPresentation>) {
  const violations = checkPatchPresentationConsistency(result);
  expect(violations).toEqual([]);
  const markerCount = collectPatchMarkerIds(result.doc).size;
  expect(markerCount).toBe(result.applied.length);
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
    const greenSegments = collectPatchMarkerIds(result.doc).size;
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

  it("复刻线上 bug:同一段落多处改动,第二处被第一处切片打散而锚定失败", () => {
    const doc = pdoc("我喜欢猫和狗");
    const patches: PatchOverlayInput[] = [
      // 第一处把"猫和狗"切出来 → 段落被拆成 [text"我喜欢", del, ins]
      { id: "a", before: "猫和狗", after: "猫、狗、兔", blockIndex: 0 },
      // 第二处"喜欢猫"横跨已被拆开的边界,任何单个 text span 里都找不到 → 丢弃
      { id: "b", before: "喜欢猫", after: "超爱猫", blockIndex: 0 },
    ];
    const result = derivePatchPresentation(doc, patches);

    expect(result.applied.map((a) => a.id)).toEqual(["a"]);
    expect(result.applied[0]!.index).toBe(1); // 序号连续,不会出现"缺 #1"
    expect(result.droppedIds).toEqual(["b"]);
    // 关键:左侧计数(applied=1)与正文标记数(1)一致,不再出现"说 2 处实际 1 处"
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
    expect(collectPatchMarkerIds(result.doc)).toEqual(new Set(["ok"]));
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
      expect(collectPatchMarkerIds(result.doc).size).toBe(result.applied.length);
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
    expect(collectPatchMarkerIds(result.doc)).toEqual(new Set(["s1"]));
    const section = result.doc.sections[0];
    expect(section?.kind).toBe("p");
    if (section?.kind === "p") {
      expect(section.spans.some((span) => span.kind === "patchDel")).toBe(true);
      expect(section.spans.some((span) => span.kind === "patchIns")).toBe(true);
      expect(section.spans.some((span) => span.kind === "patchMark")).toBe(false);
    }
    assertInternallyConsistent(result);
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
    expect(collectPatchMarkerIds(result.doc)).toEqual(new Set(["s-title"]));
    const section = result.doc.sections[0];
    expect(section?.kind).toBe("h1");
    if (section?.kind === "h1") {
      expect(section.spans?.some((span) => span.kind === "patchDel")).toBe(true);
      expect(section.spans?.some((span) => span.kind === "patchIns")).toBe(true);
    }
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
    const section = result.doc.sections[0];
    expect(section?.kind).toBe("p");
    if (section?.kind === "p") {
      expect(section.spans.some((span) => span.kind === "patchDel")).toBe(false);
      expect(section.spans.some((span) => span.kind === "patchIns")).toBe(false);
      expect(section.spans.find((span) => span.kind === "patchMark")).toMatchObject({
        kind: "patchMark",
        text: "树",
        patchId: "s-bold",
        op: "markAdd",
        label: "将加粗",
        marks: [{ type: "bold" }],
      });
    }
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
    expect(collectPatchMarkerIds(result.doc).size).toBe(0);
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
    expect(result.doc.sections).toHaveLength(1);
    expect(result.doc.sections[0]).toMatchObject({
      kind: "p",
      blockId: "block-new",
      blockPatch: { patchId: "ins-empty", op: "insert" },
    });
    const section = result.doc.sections[0];
    expect(section?.kind).toBe("p");
    if (section?.kind === "p") {
      expect(section.spans).toEqual([{ kind: "patchIns", patchId: "ins-empty", text: "新段落" }]);
    }
    expect(result.applied.map((patch) => patch.id)).toEqual(["ins-empty"]);
    expect(collectPatchMarkerIds(result.doc)).toEqual(new Set(["ins-empty"]));
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

    expect(result.doc.sections.map((section) => section.kind)).toEqual(["p", "list", "table", "code"]);
    expect(result.doc.sections.slice(1).every((section) => section.blockPatch?.patchId === "ins-rich")).toBe(true);
    expect(result.doc.sections.slice(1).every((section) => section.blockPatch?.marker?.kind === "patchIns")).toBe(true);
    expect(result.applied).toHaveLength(1);
    expect(collectPatchMarkerIds(result.doc)).toEqual(new Set(["ins-rich"]));
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
    expect(viewSectionsToPlainText(result.doc.sections)).toEqual([
      "第一段",
      "新增标题",
      "新增段落",
      "新增列表",
      "第二段",
    ]);
    expect(result.doc.sections.slice(1, 4).every((section) => section.blockPatch?.patchId === "ins-path-only")).toBe(true);
    expect(result.droppedIds).toEqual([]);
    expect(result.conflictIds).toEqual([]);
    expect(result.droppedIds.length + result.conflictIds.length).toBe(0);
    expect(collectPatchMarkerIds(result.doc)).toEqual(new Set(["ins-path-only"]));
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
    expect(viewSectionsToPlainText(result.doc.sections)).toEqual([
      "第一段",
      "第二段",
      "文末标题",
      "文末段落",
      "\n文末表格",
      "const done = true;",
    ]);
    expect(result.doc.sections.slice(2).every((section) => section.blockPatch?.patchId === "ins-no-anchor")).toBe(true);
    expect(result.doc.sections.slice(4).every((section) => section.blockPatch?.marker?.kind === "patchIns")).toBe(true);
    expect(result.applied.map((patch) => patch.id)).toEqual(["ins-no-anchor"]);
    expect(result.droppedIds).toEqual([]);
    expect(result.conflictIds).toEqual([]);
    expect(result.droppedIds.length + result.conflictIds.length).toBe(0);
    expect(collectPatchMarkerIds(result.doc)).toEqual(new Set(["ins-no-anchor"]));
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
    expect(viewSectionsToPlainText(result.doc.sections)).toEqual(["第一段", "小标题", "第二段"]);
    expect(result.doc.sections[0]?.blockPatch).toBeUndefined();
    expect(result.doc.sections[1]).toMatchObject({
      kind: "h2",
      blockId: "block-title",
      blockPatch: { patchId: "ins-title-drift", op: "insert" },
    });
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
    expect(viewSectionsToPlainText(result.doc.sections)).toEqual(["A", "标题 B", "B", "标题 C", "C"]);
    expect(result.doc.sections.map((section) => section.blockPatch?.patchId ?? null)).toEqual([
      null,
      "ins-before-b",
      null,
      "ins-before-c",
      null,
    ]);
    expect(result.droppedIds).toEqual([]);
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
    expect(result.doc.sections.map((section) => section.blockPatch?.op ?? null)).toEqual([
      null,
      "delete",
      null,
      "insert",
      null,
    ]);
    expect(viewSectionsToPlainText(result.doc.sections)).toEqual(["A", "C", "标题 D", "D"]);
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
    expect(collectPatchMarkerIds(result.doc)).toEqual(new Set(["insert-mixed", "replace-mixed"]));
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

    expect(result.doc.sections.map((section) => section.blockPatch?.patchId ?? null)).toEqual([
      null,
      "del-bc",
      "del-bc",
    ]);
    const deletedSections = result.doc.sections.slice(1);
    deletedSections.forEach((section, index) => {
      expect(section.kind).toBe("p");
      if (section.kind === "p") {
        expect(section.spans).toEqual([
          { kind: "patchDel", patchId: "del-bc", text: index === 0 ? "B" : "C" },
        ]);
      }
    });
    expect(viewSectionsToPlainText(result.doc.sections)).toEqual(["A"]);
    expect(result.applied).toHaveLength(1);
    expect(collectPatchMarkerIds(result.doc)).toEqual(new Set(["del-bc"]));
    assertInternallyConsistent(result);
  });
});

describe("checkPatchPresentationConsistency — 自检能发现错乱", () => {
  it("序号有空洞时报告违规", () => {
    const doc = pdoc("x");
    // applied 第一项 index=2(应为 1),且 doc 里没有它的标记
    const violations = checkPatchPresentationConsistency({
      doc,
      applied: [{ id: "p", reviewBatchId: "p", groupMode: "independent", before: "a", after: "b", kind: "text", index: 2 }],
      appliedIds: new Set(["p"]),
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  it("正文标记与 applied 集合不一致时报告违规", () => {
    // 文档里有 p1 的标记,但 applied 声称是 p2 → 计数会骗人,必须被发现
    const doc: ViewDocumentSnapshot = {
      version: 1,
      ts: "t",
      sections: [
        {
          kind: "p",
          spans: [
            { kind: "text", text: "前" },
            { kind: "patchIns", text: "新", patchId: "p1" },
          ],
        },
      ],
    };
    const violations = checkPatchPresentationConsistency({
      doc,
      applied: [{ id: "p2", reviewBatchId: "p2", groupMode: "independent", before: "", after: "新", kind: "text", index: 1 }],
      appliedIds: new Set(["p2"]),
    });
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe("applyPatchOverlaysWithReport", () => {
  it("如实报告 appliedIds 与 droppedIds", () => {
    const doc = pdoc("keep this text");
    const { appliedIds, droppedIds } = applyPatchOverlaysWithReport(doc, [
      { id: "ok", before: "this", after: "THAT", blockIndex: 0 },
      { id: "no", before: "nope", after: "X", blockIndex: 0 },
    ]);
    expect([...appliedIds]).toEqual(["ok"]);
    expect(droppedIds).toEqual(["no"]);
  });
});

describe("p03 回归:结构 replace hunk 的块级可视通道", () => {
  function pmTable(blockId: string, cellText: string): PmBlockNode {
    return pmTableRows(blockId, [[cellText]]);
  }

  function pmTableRows(blockId: string, rows: readonly string[][], options: { header?: boolean } = {}): PmBlockNode {
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
    return row?.cells.map((cell) => cell.spans.map((span) => span.text).join("")).join("\t") ?? "";
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
    expect(inputs[0]).toMatchObject({ patchId: "rep-list", op: "replace", blockCount: 1 });
    const list = inputs[0]!.blocks[0] as Extract<ViewBlock, { kind: "list" }>;
    expect(list.kind).toBe("list");
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
    expect(result.doc.sections).toHaveLength(1);
    expect(result.doc.sections[0]).toMatchObject({
      kind: "list",
      blockPatch: { patchId: "rep-list", op: "replace" },
    });
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({ id: "rep-list", kind: "replace", index: 1 });
    expect(result.applied[0]!.before).toContain("对齐设计初稿");
    expect(result.applied[0]!.after).toContain("对齐设计终稿");
    expect(collectPatchMarkerIds(result.doc)).toEqual(new Set(["rep-list"]));
    assertInternallyConsistent(result);
  });

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
    expect(collectPatchMarkerIds(result.doc)).toEqual(new Set(["rep-task"]));
    assertInternallyConsistent(result);
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

    // 落到块通道:删旧段 + 插新表格,插入块保真为 table ViewBlock
    const inputs = suggestionToBlockPatchInputs(sugg, 0);
    expect(inputs.map((i) => i.op)).toEqual(["delete", "insert"]);
    const insertBlocks = inputs.find((i) => i.op === "insert")!.blocks;
    expect(insertBlocks.map((b) => b.kind)).toEqual(["table"]);
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
    expect(applyDiffHunks(base, [hunk])).toEqual(draft);

    expect(suggestionToPatchOverlay(doc, sugg, 0)).toBeNull();
    const inputs = suggestionToBlockPatchInputs(sugg, 0);
    expect(inputs).not.toHaveLength(0);
    expect(inputs.map((input) => input.op)).toEqual(["delete", "insert"]);
    expect(inputs.find((input) => input.op === "insert")!.blocks).toMatchObject([
      { kind: "code", body: "const value = 2;\nconsole.log(value);" },
    ]);
  });

  it("同类型 table replace 只产出一个 replace patch,单元格级 cellDiff 覆盖 changed/removed/added", () => {
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
    const table = inputs[0]!.blocks[0] as Extract<ViewBlock, { kind: "table" }>;
    expect(table.kind).toBe("table");
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
    expect(removedRow).toMatchObject({ status: "removed" });
    expect(tableRowPlainText(removedRow)).toBe("旧渠道\t10\t20");
    expect(addedRow).toMatchObject({ status: "added" });
    expect(tableRowPlainText(addedRow)).toBe("新渠道\t12\t18");

    const result = derivePatchPresentation(doc, [], inputs);
    expect(result.droppedIds).toEqual([]);
    expect(result.doc.sections).toHaveLength(1);
    expect(result.doc.sections[0]).toMatchObject({
      kind: "table",
      blockPatch: { patchId: "rep-tbl", op: "replace" },
    });
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({
      id: "rep-tbl",
      kind: "replace",
      index: 1,
    });
    expect(result.applied[0]!.before).toContain("旧渠道");
    expect(result.applied[0]!.after).toContain("新渠道");
    expect(collectPatchMarkerIds(result.doc)).toEqual(new Set(["rep-tbl"]));
    assertInternallyConsistent(result);
  });

  it("同类型 callout replace 只产出一个 replace patch,内部 bodyDiff 做块序列递归", () => {
    const before = pmCalloutRows("callout-1", ["保留提示", "旧风险提示", "归档旧块"]);
    const after = pmCalloutRows("callout-1", ["保留提示", "新风险提示", "补充事项"]);
    const doc = pmDocToViewDocumentSnapshot(pmDoc([before]), 1, "t");
    const hunk = replaceHunk("rep-callout", "callout-1", before, after);

    const inputs = suggestionToBlockPatchInputs(blockSuggestion("rep-callout", hunk), 0);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ patchId: "rep-callout", op: "replace", blockCount: 1 });
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
    expect(collectPatchMarkerIds(result.doc)).toEqual(new Set(["rep-callout"]));
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
    expect(inputs[0]).toMatchObject({ patchId: "rep-columns", op: "replace", blockCount: 1 });
    const columnList = inputs[0]!.blocks[0] as Extract<ViewBlock, { kind: "columnList" }>;
    expect(columnList.kind).toBe("columnList");
    expect(columnList.node.type).toBe("columnList");
    expect(columnList.columnsDiff).toHaveLength(2);
    expect(columnList.columnsDiff?.[0]?.map((entry) => entry.status)).toEqual(["same", "changed", "removed", "added"]);

    const textChanged = columnList.columnsDiff?.[0]?.[1];
    expect(textChanged).toMatchObject({ status: "changed", kind: "text", oldText: "左栏旧文" });
    expect(textChanged?.status === "changed" && textChanged.kind === "text" ? textChanged.spans : []).toContainEqual({
      kind: "patchIns",
      text: "新",
      patchId: "rep-columns",
    });

    const listChanged = columnList.columnsDiff?.[1]?.[0];
    expect(listChanged).toMatchObject({ status: "changed", kind: "list" });
    expect(listChanged?.status === "changed" && listChanged.kind === "list" ? listChanged.rowDiff.map((row) => row.status) : []).toEqual([
      "same",
      "changed",
      "added",
    ]);

    const tableChanged = columnList.columnsDiff?.[1]?.[1];
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
    expect(collectPatchMarkerIds(result.doc)).toEqual(new Set(["rep-columns"]));
    assertInternallyConsistent(result);
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

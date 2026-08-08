import { describe, expect, it } from "vitest";
import {
  applyBlockEdits,
  type PmBlockNode,
  type PmDiagramNode,
  type PmDoc,
  type PmInlineNode,
  type PmMark,
} from "@qingagent/pm-schema";
import { applyDiffHunkToDoc, applyDiffHunks, buildDraftDiff } from "../proposalDiff.js";

function text(textValue: string, marks?: PmMark[]): PmInlineNode {
  return marks && marks.length > 0
    ? { type: "text", text: textValue, marks }
    : { type: "text", text: textValue };
}

function paragraph(blockId: string, content: string | PmInlineNode[]): PmBlockNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: typeof content === "string" ? [text(content)] : content,
  };
}

function taskList(blockId: string, items: Array<{ checked: boolean; text: string }>): PmBlockNode {
  return {
    type: "taskList",
    attrs: { blockId },
    content: items.map((item, index) => ({
      type: "taskItem",
      attrs: { blockId: `${blockId}-item-${index}`, checked: item.checked },
      content: [paragraph(`${blockId}-item-${index}-p`, item.text) as Extract<PmBlockNode, { type: "paragraph" }>],
    })),
  };
}

function callout(blockId: string, value: string): PmBlockNode {
  return {
    type: "callout",
    attrs: { blockId, emoji: "!", tone: "warning" },
    content: [paragraph(`${blockId}-p`, value) as Extract<PmBlockNode, { type: "paragraph" }>],
  };
}

function blockMath(blockId: string, latex: string): PmBlockNode {
  return { type: "blockMath", attrs: { blockId, latex } };
}

function codeBlock(blockId: string, language: string, value: string): PmBlockNode {
  return {
    type: "codeBlock",
    attrs: { blockId, language },
    content: [text(value)],
  } as PmBlockNode;
}

function columnList(blockId: string, leftText: string, rightText: string): PmBlockNode {
  return {
    type: "columnList",
    attrs: { blockId },
    content: [
      {
        type: "column",
        attrs: { blockId: `${blockId}-left`, widthRatio: 0.4 },
        content: [paragraph(`${blockId}-left-p`, leftText) as Extract<PmBlockNode, { type: "paragraph" }>],
      },
      {
        type: "column",
        attrs: { blockId: `${blockId}-right`, widthRatio: 0.6 },
        content: [paragraph(`${blockId}-right-p`, rightText) as Extract<PmBlockNode, { type: "paragraph" }>],
      },
    ],
  };
}

function diagram(blockId: string, overlay?: Record<string, unknown>): PmBlockNode {
  return {
    type: "diagram",
    attrs: {
      blockId,
      lang: "mermaid",
      source: "flowchart TD\n  A[开始] --> B[结束]\n",
      svg: null,
      ...(overlay ? { overlay } : {}),
    },
  } as PmBlockNode;
}

function doc(content: PmBlockNode[]): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content,
  };
}

function texts(nodes: readonly { type: string; text?: string }[] | null): string {
  return (nodes ?? []).map((node) => node.text ?? "\n").join("");
}

function firstBlockText(pmDoc: PmDoc): string {
  const block = pmDoc.content[0];
  return block && "content" in block && Array.isArray(block.content)
    ? texts(block.content)
    : "";
}

describe("proposalDiff shadow engine", () => {
  it("diagram overlay-only 变化不进入 proposalDiff", () => {
    const base = doc([diagram("diagram-1")]);
    const draft = doc([diagram("diagram-1", { positions: { A: { x: 10, y: 20 } } })]);
    expect(buildDraftDiff(base, draft)).toHaveLength(0);
  });

  it("审阅提交模型 replaceBlock 时保留 init 图的用户布局", () => {
    const source = [
      "%%{init: {'theme':'base'}}%%",
      "flowchart LR",
      "  A[入口] --> B[处理]",
      "  B --> C[校验]",
      "  C --> D[出口]",
      "",
    ].join("\n");
    const base = doc([{
      type: "diagram",
      attrs: {
        blockId: "diagram-init-review",
        lang: "mermaid",
        source,
        svg: null,
        overlay: {
          positions: {
            A: { x: 40, y: 60 },
            B: { x: 260, y: 60 },
            C: { x: 480, y: 60 },
            D: { x: 700, y: 60 },
          },
        },
      },
    }]);
    // 模型候选只含 AI-IR 可见域；真实链路的审阅提交必须从 canonical 回灌用户视觉域。
    const aiVisibleBase = doc([{
      type: "diagram",
      attrs: {
        blockId: "diagram-init-review",
        lang: "mermaid",
        source,
        svg: null,
      },
    }]);
    const edited = applyBlockEdits(aiVisibleBase, [{
      action: "replaceBlock",
      ref: "diagram-init-review",
      block: {
        type: "diagram",
        lang: "mermaid",
        source: source.replace("B[处理]", "B[分析处理]"),
      },
    }]);
    expect(edited.ok).toBe(true);
    const hunks = buildDraftDiff(base, edited.doc!);
    expect(hunks).toHaveLength(1);

    const committed = applyDiffHunks(base, hunks).doc;
    const diagramBlock = committed.content[0] as PmDiagramNode;
    expect(diagramBlock.attrs.overlay?.positions).toEqual({
      A: { x: 40, y: 60 },
      B: { x: 260, y: 60 },
      C: { x: 480, y: 60 },
      D: { x: 700, y: 60 },
    });
  });

  it("把行内文本 diff 最小化到真正变化片段", () => {
    const base = doc([
      paragraph("ai-block-base-min", "映在半边湖里。柳树、桃树、亭台楼阁都静静地立着。"),
    ]);
    const draft = doc([
      paragraph("ai-block-draft-min", "映在半边湖里。胡桃树、桃树、亭台楼阁都静静地立着。"),
    ]);

    const hunks = buildDraftDiff(base, draft);

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      op: "replace",
      blockPath: [0],
      beforeText: "柳",
      afterText: "胡桃",
      anchor: {
        quoteBefore: "柳",
        quoteAfter: "胡桃",
      },
    });
    expect(texts(hunks[0]!.before)).toBe("柳");
    expect(texts(hunks[0]!.after)).toBe("胡桃");
    expect(hunks[0]!.beforeText).not.toContain("映在半边湖里。");
    expect(applyDiffHunks(base, hunks).doc).toEqual(draft);
  });

  it("文本不变时把纯 mark 变化产成 markAdd, 不产文本 replace 或空 hunk", () => {
    const bold: PmMark = { type: "bold" };
    const base = doc([
      paragraph("ai-block-base-mark", [text("尖尖的顶子露在"), text("树"), text("梢上")]),
    ]);
    const draft = doc([
      paragraph("ai-block-draft-mark", [text("尖尖的顶子露在"), text("树", [bold]), text("梢上")]),
    ]);

    const hunks = buildDraftDiff(base, draft);

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      op: "markAdd",
      beforeText: "树",
      afterText: "树",
      marks: [bold],
    });
    expect(hunks[0]!.op).not.toBe("replace");
    expect(hunks[0]!.before).not.toEqual(hunks[0]!.after);
    expect(applyDiffHunks(base, hunks).doc).toEqual(draft);
  });

  it("同类型 mark 属性变化合并为单个原子替换, 不允许只采纳新增属性", () => {
    const oldLink: PmMark = { type: "link", attrs: { href: "https://old.example" } };
    const newLink: PmMark = { type: "link", attrs: { href: "https://new.example" } };
    const base = doc([
      paragraph("ai-block-base-link", [text("访问官网", [oldLink])]),
    ]);
    const draft = doc([
      paragraph("ai-block-draft-link", [text("访问官网", [newLink])]),
    ]);

    const hunks = buildDraftDiff(base, draft);

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      op: "replace",
      beforeText: "访问官网",
      afterText: "访问官网",
      before: [{ type: "text", text: "访问官网", marks: [oldLink] }],
      after: [{ type: "text", text: "访问官网", marks: [newLink] }],
    });
    expect(hunks.some((hunk) => hunk.op === "markAdd" || hunk.op === "markRemove")).toBe(false);
    expect(applyDiffHunks(base, hunks).doc).toEqual(draft);
  });

  it("前方文本长度变化后 mark hunk 的 after 侧使用 draft 坐标", () => {
    const bold: PmMark = { type: "bold" };
    const base = doc([
      paragraph("ai-block-base-shifted-mark", [text("旧"), text("目标")]),
    ]);
    const draft = doc([
      paragraph("ai-block-draft-shifted-mark", [text("新增长"), text("目标", [bold])]),
    ]);

    const hunks = buildDraftDiff(base, draft);
    const markHunk = hunks.find((hunk) => hunk.op === "markAdd");

    expect(markHunk).toMatchObject({
      beforeText: "目标",
      afterText: "目标",
      anchor: {
        quoteBefore: "目标",
        quoteAfter: "目标",
      },
      before: [{ type: "text", text: "目标" }],
      after: [{ type: "text", text: "目标", marks: [bold] }],
    });
    expect(applyDiffHunks(base, hunks).doc).toEqual(draft);
  });

  it("支持块级插入、删除和整段替换", () => {
    const insertBase = doc([
      paragraph("ai-block-a", "第一段"),
      paragraph("ai-block-c", "第三段"),
    ]);
    const insertDraft = doc([
      paragraph("ai-block-a", "第一段"),
      paragraph("ai-block-b", "第二段"),
      paragraph("ai-block-c", "第三段"),
    ]);
    const insertHunks = buildDraftDiff(insertBase, insertDraft);
    expect(insertHunks).toHaveLength(1);
    expect(insertHunks[0]).toMatchObject({ op: "insert", blockPath: [1], afterText: "第二段" });
    expect(applyDiffHunks(insertBase, insertHunks).doc).toEqual(insertDraft);

    const deleteBase = doc([
      paragraph("ai-block-a", "第一段"),
      paragraph("ai-block-b", "第二段"),
      paragraph("ai-block-c", "第三段"),
    ]);
    const deleteDraft = doc([
      paragraph("ai-block-a", "第一段"),
      paragraph("ai-block-c", "第三段"),
    ]);
    const deleteHunks = buildDraftDiff(deleteBase, deleteDraft);
    expect(deleteHunks).toHaveLength(1);
    expect(deleteHunks[0]).toMatchObject({ op: "delete", blockPath: [1], beforeText: "第二段" });
    expect(applyDiffHunks(deleteBase, deleteHunks).doc).toEqual(deleteDraft);

    const replaceBase = doc([
      paragraph("ai-block-a", "第一段"),
      paragraph("ai-block-old", "旧段落"),
    ]);
    const replaceDraft = doc([
      paragraph("ai-block-a", "第一段"),
      paragraph("ai-block-new", "新段落"),
    ]);
    const replaceHunks = buildDraftDiff(replaceBase, replaceDraft);
    expect(replaceHunks).toHaveLength(1);
    expect(replaceHunks[0]).toMatchObject({ op: "replace", blockPath: [1], beforeText: "旧", afterText: "新" });
    expect(applyDiffHunks(replaceBase, replaceHunks).doc).toEqual(replaceDraft);
  });

  it("块插入效果已存在时重放保持幂等, 不重复插入整块", () => {
    const base = doc([
      paragraph("ai-block-a", "第一段"),
      paragraph("ai-block-c", "第三段"),
    ]);
    const draft = doc([
      paragraph("ai-block-a", "第一段"),
      paragraph("ai-block-b", "第二段"),
      paragraph("ai-block-c", "第三段"),
    ]);
    const [insertHunk] = buildDraftDiff(base, draft);
    if (!insertHunk) throw new Error("fixture missing block insert hunk");

    const replayed = applyDiffHunkToDoc(draft, insertHunk, {
      oldBaseDoc: base,
    });

    expect(replayed).toEqual({ ok: true, doc: draft });
  });

  it("纯行内插入效果已存在时重放保持幂等, 不重复插入文本", () => {
    const base = doc([
      paragraph("ai-block-inline-insert", "甲乙"),
    ]);
    const draft = doc([
      paragraph("ai-block-inline-insert", "甲新增乙"),
    ]);
    const insertHunk = buildDraftDiff(base, draft).find((hunk) =>
      hunk.beforeText === "" && hunk.afterText === "新增"
    );
    if (!insertHunk) throw new Error("fixture missing inline insert hunk");

    const replayed = applyDiffHunkToDoc(draft, insertHunk, {
      oldBaseDoc: base,
    });

    expect(replayed).toEqual({ ok: true, doc: draft });
  });

  it("columnList 参与块级 diff,并用拍平文本生成摘要与回放内容", () => {
    const base = doc([paragraph("ai-block-a", "前文")]);
    const draft = doc([
      paragraph("ai-block-a", "前文"),
      columnList("ai-block-columns", "左栏内容", "右栏内容"),
    ]);

    const hunks = buildDraftDiff(base, draft);

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      op: "insert",
      afterText: "左栏内容\n右栏内容",
    });
    expect(hunks[0]?.after?.[0]?.type).toBe("columnList");
    expect(applyDiffHunks(base, hunks).doc).toEqual(draft);
  });

  it("多处修改会产多个独立最小 hunk", () => {
    const base = doc([
      paragraph("ai-block-a", "湖边有柳树。"),
      paragraph("ai-block-b", "他拿着蓝毛巾。"),
      paragraph("ai-block-c", "亭子没有变化。"),
    ]);
    const draft = doc([
      paragraph("ai-block-a2", "湖边有胡桃树。"),
      paragraph("ai-block-b2", "他拿着黄毛巾。"),
      paragraph("ai-block-c", "亭子没有变化。"),
    ]);

    const hunks = buildDraftDiff(base, draft);

    expect(hunks).toHaveLength(2);
    expect(hunks.map((hunk) => [hunk.op, hunk.beforeText, hunk.afterText])).toEqual([
      ["replace", "柳", "胡桃"],
      ["replace", "蓝", "黄"],
    ]);
    expect(hunks.every((hunk) => !hunk.beforeText?.includes("湖边有") && !hunk.beforeText?.includes("他拿着"))).toBe(true);
    expect(applyDiffHunks(base, hunks).doc).toEqual(draft);
  });

  it("重复段落按出现序号对齐，部分采纳不会插入幻影重复块", () => {
    const base = doc([
      paragraph("ai-block-a-1", "重复段"),
      paragraph("ai-block-a-2", "重复段"),
      paragraph("ai-block-b-1", "变化段"),
    ]);
    const draft = doc([
      paragraph("ai-block-b-0", "变化段"),
      paragraph("ai-block-a-3", "重复段"),
      paragraph("ai-block-b-2", "变化段"),
      paragraph("ai-block-a-4", "重复段"),
    ]);

    const hunks = buildDraftDiff(base, draft);
    expect(hunks.some((hunk) => hunk.op === "insert" && hunk.afterText === "重复段")).toBe(false);
    const accepted = hunks.find((hunk) => hunk.op === "insert" && hunk.afterText === "变化段");
    if (!accepted) throw new Error("fixture missing inserted changed block");

    const partiallyCommitted = applyDiffHunks(base, [accepted]).doc;
    const duplicateCount = partiallyCommitted.content.filter((block) =>
      "content" in block && Array.isArray(block.content) && texts(block.content) === "重复段"
    ).length;
    expect(duplicateCount).toBe(2);
    expect(applyDiffHunks(base, hunks).doc.content.map((block) =>
      "content" in block && Array.isArray(block.content) ? texts(block.content) : ""
    )).toEqual(["变化段", "重复段", "变化段", "重复段"]);
  });

  it("同块多 hunk 也保持逐 hunk independent review batch", () => {
    const base = doc([paragraph("block-a", "湖边有柳树。他拿着蓝毛巾。")]);
    const draft = doc([paragraph("block-a", "湖边有胡桃树。他拿着黄毛巾。")]);

    const hunks = buildDraftDiff(base, draft, { baseVersion: 7 });

    expect(hunks).toHaveLength(2);
    expect(new Set(hunks.map((hunk) => hunk.reviewBatchId)).size).toBe(2);
    expect(hunks.every((hunk) => hunk.reviewBatchId === hunk.hunkId)).toBe(true);
    expect(hunks.every((hunk) => hunk.groupMode === "independent")).toBe(true);
  });

  it("不同块多 hunk 保持 independent 且 reviewBatchId 等于 hunkId", () => {
    const base = doc([
      paragraph("block-a", "湖边有柳树。"),
      paragraph("block-b", "他拿着蓝毛巾。"),
    ]);
    const draft = doc([
      paragraph("block-a", "湖边有胡桃树。"),
      paragraph("block-b", "他拿着黄毛巾。"),
    ]);

    const hunks = buildDraftDiff(base, draft, { baseVersion: 7 });

    expect(hunks).toHaveLength(2);
    expect(hunks.every((hunk) => hunk.groupMode === "independent")).toBe(true);
    expect(hunks.every((hunk) => hunk.reviewBatchId === hunk.hunkId)).toBe(true);
  });

  it("同一 baseVersion 和 diff 重算出的 reviewBatchId 稳定", () => {
    const base = doc([paragraph("block-a", "湖边有柳树。他拿着蓝毛巾。")]);
    const draft = doc([paragraph("block-a", "湖边有胡桃树。他拿着黄毛巾。")]);

    const first = buildDraftDiff(base, draft, { baseVersion: 7 });
    const second = buildDraftDiff(base, draft, { baseVersion: 7 });

    expect(first.map((hunk) => hunk.reviewBatchId)).toEqual(
      second.map((hunk) => hunk.reviewBatchId),
    );
  });

  it("直接对同块 hunk 子集调用 applyDiffHunks 只应用该处", () => {
    const base = doc([paragraph("block-a", "湖边有柳树。他拿着蓝毛巾。")]);
    const draft = doc([paragraph("block-a", "湖边有胡桃树。他拿着黄毛巾。")]);
    const hunks = buildDraftDiff(base, draft, { baseVersion: 7 });
    const onlyTree = hunks.find((hunk) => hunk.afterText === "胡桃");
    if (!onlyTree) throw new Error("fixture missing tree hunk");

    expect(applyDiffHunks(base, [onlyTree]).doc).toEqual(
      doc([paragraph("block-a", "湖边有胡桃树。他拿着蓝毛巾。")]),
    );
  });

  it("同段部分采纳后 rebase 空插入 hunk 时按完整目标块避开重复文本误定位", () => {
    const base = doc([paragraph("block-a", "df eeffba  efdefe b ")]);
    const draft = doc([paragraph("block-a-draft", "df eeffbbac ed befee ebff ")]);
    const hunks = buildDraftDiff(base, draft, { baseVersion: 7 });
    // 锚点清理后:2 字公共段("ef")保留成拆点,原"a  efd→bac ed b"拆成两处覆盖。
    expect(hunks.map((hunk) => [hunk.beforeText, hunk.afterText])).toEqual([
      ["a ", "bac"],
      ["fd", "d b"],
      ["", "e"],
      ["b", "ebff"],
    ]);

    // 按内容取纯插入 hunk(不再靠固定下标),先提交其余处再 rebase 落这一处。
    const insert = hunks.find((hunk) => hunk.beforeText === "" && hunk.afterText === "e");
    if (!insert) throw new Error("fixture missing pure insert hunk");
    const committed = applyDiffHunks(base, hunks.filter((hunk) => hunk !== insert)).doc;
    const applied = applyDiffHunkToDoc(committed, insert, {
      oldBaseDoc: base,
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(firstBlockText(applied.doc)).toBe("df eeffbbac ed befee ebff ");
  });

  it("长段落纯插入 rebase 只用有界候选也能避开重复文本误定位", () => {
    const prefix = "前".repeat(1200);
    const suffix = "后".repeat(1200);
    const baseText = `${prefix}df eeffba  efdefe b ${suffix}`;
    const draftText = `${prefix}df eeffbbac ed befee ebff ${suffix}`;
    const base = doc([paragraph("block-a", baseText)]);
    const draft = doc([paragraph("block-a-draft", draftText)]);
    const hunks = buildDraftDiff(base, draft, { baseVersion: 7 });
    const insert = hunks.find((hunk) => hunk.beforeText === "" && hunk.afterText === "e");
    if (!insert) throw new Error("fixture missing pure insert hunk");

    const committed = applyDiffHunks(base, hunks.filter((hunk) => hunk !== insert)).doc;
    const applied = applyDiffHunkToDoc(committed, insert, {
      oldBaseDoc: base,
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(firstBlockText(applied.doc)).toBe(draftText);
  });

  it("同段部分采纳后 rebase 非空 hunk 时按完整目标块避开重复 beforeText 误删", () => {
    const base = doc([paragraph("block-a", "e ccebec eadcfafaace")]);
    const draft = doc([paragraph("block-a-draft", "e cce dcdbf feadcfbb cecffaec dce")]);
    const hunks = buildDraftDiff(base, draft, { baseVersion: 7 });
    expect(hunks.map((hunk) => [hunk.beforeText, hunk.afterText])).toEqual([
      ["bec ead", " dcdbf feadcfbb ce"],
      ["a", ""],
      ["a", "ec d"],
    ]);

    const committed = applyDiffHunks(base, [hunks[0]!, hunks[2]!]).doc;
    const applied = applyDiffHunkToDoc(committed, hunks[1]!, {
      oldBaseDoc: base,
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(firstBlockText(applied.doc)).toBe("e cce dcdbf feadcfbb cecffaec dce");
  });

  it("B3:审核提交按 blockId 锚定——目标块被并发移动后仍改到正确块", () => {
    const btext = (b: PmBlockNode | undefined): string =>
      b && "content" in b && Array.isArray(b.content) ? texts(b.content) : "";
    const base = doc([paragraph("blk-a", "alpha 原文"), paragraph("blk-b", "beta 原文")]);
    const draft = doc([paragraph("blk-a", "alpha 原文"), paragraph("blk-b", "beta 改后")]);
    const hunks = buildDraftDiff(base, draft, { baseVersion: 1 });

    // 并发编辑把两块顺序调换(blockId 不变):blk-b 现在在 index 0,旧位置锚定会打到 blk-a。
    const reordered = doc([paragraph("blk-b", "beta 原文"), paragraph("blk-a", "alpha 原文")]);
    const committed = applyDiffHunks(reordered, hunks).doc;
    const byId = (id: string) => committed.content.find((b) => b.attrs.blockId === id);

    expect(btext(byId("blk-b"))).toBe("beta 改后");
    expect(btext(byId("blk-a"))).toBe("alpha 原文");
  });

  it("B3:目标块被并发删除时该 hunk 标失效跳过,绝不错位应用到其他块", () => {
    const btext = (b: PmBlockNode): string =>
      "content" in b && Array.isArray(b.content) ? texts(b.content) : "";
    const base = doc([paragraph("blk-a", "alpha"), paragraph("blk-b", "beta"), paragraph("blk-c", "gamma")]);
    const draft = doc([paragraph("blk-a", "alpha"), paragraph("blk-b", "beta 改后"), paragraph("blk-c", "gamma")]);
    const hunks = buildDraftDiff(base, draft, { baseVersion: 1 });

    // 并发删除 blk-b → 剩 [blk-a, blk-c];blk-b 的 hunk 应失效跳过,不错位改到 blk-a/blk-c。
    const removed = doc([paragraph("blk-a", "alpha"), paragraph("blk-c", "gamma")]);
    const committed = applyDiffHunks(removed, hunks).doc;
    expect(committed.content.map(btext)).toEqual(["alpha", "gamma"]);
  });

  it("单①:applyDiffHunks 回吐 applied/skipped——失效 hunk 计入 skipped,doc 只落存活块", () => {
    const btext = (b: PmBlockNode): string =>
      "content" in b && Array.isArray(b.content) ? texts(b.content) : "";
    const base = doc([paragraph("blk-a", "alpha"), paragraph("blk-b", "beta")]);
    const draft = doc([paragraph("blk-a", "alpha 改后"), paragraph("blk-b", "beta 改后")]);
    const hunks = buildDraftDiff(base, draft, { baseVersion: 1 });
    expect(hunks.length).toBe(2);

    // 并发删除 blk-b:该 hunk 进 skipped,blk-a 的 hunk 照常应用。
    const removed = doc([paragraph("blk-a", "alpha")]);
    const result = applyDiffHunks(removed, hunks);
    expect(result.applied.length).toBe(1);
    expect(result.skipped.length).toBe(1);
    expect(result.applied[0]!.anchor.blockId).toBe("blk-a");
    expect(result.skipped[0]!.anchor.blockId).toBe("blk-b");
    expect(result.doc.content.map(btext)).toEqual(["alpha 改后"]);
  });

  it("对多组 base/draft 满足 round-trip", () => {
    const bold: PmMark = { type: "bold" };
    const italic: PmMark = { type: "italic" };
    const cases: Array<[PmDoc, PmDoc]> = [
      [
        doc([paragraph("ai-block-a", "甲柳树乙")]),
        doc([paragraph("ai-block-a2", "甲胡桃树乙")]),
      ],
      [
        doc([paragraph("ai-block-a", [text("树", [bold])])]),
        doc([paragraph("ai-block-a2", [text("树")])]),
      ],
      [
        doc([paragraph("ai-block-a", "第一段"), paragraph("ai-block-b", "第三段")]),
        doc([paragraph("ai-block-a", "第一段"), paragraph("ai-block-x", "第二段"), paragraph("ai-block-b", "第三段")]),
      ],
      [
        doc([paragraph("ai-block-c", "第三段")]),
        doc([paragraph("ai-block-a", "第一段"), paragraph("ai-block-b", "第二段"), paragraph("ai-block-c", "第三段")]),
      ],
      [
        doc([paragraph("ai-block-a", "第一段"), paragraph("ai-block-x", "第二段"), paragraph("ai-block-b", "第三段")]),
        doc([paragraph("ai-block-a", "第一段"), paragraph("ai-block-b", "第三段")]),
      ],
      [
        doc([paragraph("ai-block-a", "第一段"), paragraph("ai-block-b", "第二段"), paragraph("ai-block-c", "第三段")]),
        doc([paragraph("ai-block-c", "第三段")]),
      ],
      [
        doc([paragraph("ai-block-a", [text("左"), text("树"), text("右", [italic])])]),
        doc([paragraph("ai-block-a2", [text("左"), text("树", [bold]), text("右")])]),
      ],
    ];

    for (const [base, draft] of cases) {
      expect(applyDiffHunks(base, buildDraftDiff(base, draft)).doc).toEqual(draft);
    }
  });

  it("taskList/callout/blockMath/codeBlock 块级 replace 提交 round-trip 不丢块", () => {
    const cases: Array<[PmDoc, PmDoc, string]> = [
      [
        doc([
          taskList("tasks", [
            { checked: false, text: "写摘要" },
            { checked: true, text: "审校" },
          ]),
        ]),
        doc([
          taskList("tasks", [
            { checked: true, text: "写摘要" },
            { checked: true, text: "审校" },
          ]),
        ]),
        "taskList",
      ],
      [
        doc([callout("risk-callout", "旧风险提示")]),
        doc([callout("risk-callout", "新风险提示")]),
        "callout",
      ],
      [
        doc([blockMath("math-block", String.raw`E = mc^2`)]),
        doc([blockMath("math-block", String.raw`E = mc^2 + \epsilon`)]),
        "blockMath",
      ],
      [
        doc([codeBlock("code-block", "ts", "const value = 1;")]),
        doc([codeBlock("code-block", "ts", "const value = 2;")]),
        "codeBlock",
      ],
    ];

    for (const [base, draft, type] of cases) {
      const hunks = buildDraftDiff(base, draft);
      expect(hunks).toHaveLength(1);
      expect(hunks[0]).toMatchObject({
        op: "replace",
        before: [{ type }],
        after: [{ type }],
        afterBlock: { type },
      });
      expect(applyDiffHunks(base, [hunks[0]!]).doc).toEqual(draft);
    }
  });

  it("内容指纹 LCS 能在 ai-block id 改变时对齐未动段, 不退化成全删全增", () => {
    const base = doc([
      paragraph("ai-block-a", "开头段"),
      paragraph("ai-block-b", "这一段会被大幅修改，原文保留很少。"),
      paragraph("ai-block-c", "后续段一"),
      paragraph("ai-block-d", "后续段二"),
    ]);
    const draft = doc([
      paragraph("ai-block-a", "开头段"),
      paragraph("ai-block-b-draft", "完全不同的新内容，用来模拟模型把中间段大改。"),
      paragraph("ai-block-c", "后续段一"),
      paragraph("ai-block-d", "后续段二"),
    ]);

    const hunks = buildDraftDiff(base, draft);
    const overlapRatio = (hunks as typeof hunks & { overlapRatio: number }).overlapRatio;

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      op: "replace",
      blockPath: [1],
    });
    expect(hunks[0]!.beforeText).not.toBe("开头段");
    expect(hunks[0]!.afterText).not.toBe("后续段一");
    expect(overlapRatio).toBeGreaterThan(0);
    expect(overlapRatio).toBeLessThan(1);
    expect(applyDiffHunks(base, hunks).doc).toEqual(draft);
  });
});
describe("p06/p09 回归:同型同文块的属性差异必须产出 hunk", () => {
  function heading(blockId: string, level: number, textValue: string): PmBlockNode {
    return {
      type: "heading",
      attrs: { blockId, level },
      content: [text(textValue)],
    } as PmBlockNode;
  }

  it("heading level 2→3(文本不变)产出 replace hunk 且 round-trip 成立", () => {
    const base = doc([heading("h1", 2, "第一章"), heading("h2", 2, "第二章"), paragraph("p1", "正文")]);
    const draft = doc([heading("h1", 3, "第一章"), heading("h2", 3, "第二章"), paragraph("p1", "正文")]);

    const hunks = buildDraftDiff(base, draft, { baseVersion: 1 });

    // 诊断 p06 的最小复现:此前这里是 0 个 hunk,level 变更全部蒸发。
    expect(hunks.filter((h) => h.op === "replace")).toHaveLength(2);
    expect(applyDiffHunks(base, hunks).doc).toEqual(draft);
  });

  it("codeBlock 仅改 language 产出 hunk,不再被当 noop(p09 死锁解除)", () => {
    const base = doc([codeBlock("c1", "typescript", "const a = 1;")]);
    const draft = doc([codeBlock("c1", "javascript", "const a = 1;")]);

    const hunks = buildDraftDiff(base, draft, { baseVersion: 1 });

    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.op).toBe("replace");
    expect(applyDiffHunks(base, hunks).doc).toEqual(draft);
  });

  it("attrs 完全相同(仅键序不同)不产生虚假 hunk", () => {
    const a = doc([{ type: "heading", attrs: { blockId: "h", level: 2 }, content: [text("题")] } as PmBlockNode]);
    const b = doc([{ type: "heading", attrs: { level: 2, blockId: "h" }, content: [text("题")] } as PmBlockNode]);

    expect(buildDraftDiff(a, b, { baseVersion: 1 })).toHaveLength(0);
  });
});

describe("拆干净:锚点清理(★裁决 260710)", () => {
  const graphemeCount = (s: string): number => Array.from(s).length;
  const nonTrivialCount = (s: string): number =>
    Array.from(s).filter((c) => !/[\p{P}\s]/u.test(c)).length;
  // 假新增 = replace 的 ins 是 del 的子串重现,且 ins 本身是≥2 字的真锚点(晚风案 [del AXB][ins X])。
  const isFakeInsert = (before: string, after: string): boolean =>
    after !== "" && before !== "" && before.includes(after) &&
    graphemeCount(after) >= 2 && nonTrivialCount(after) >= 1;

  it("晚风案(hunk#1):公共'晚风'保留成锚点,产两笔纯删除、零 insert", () => {
    const base = doc([paragraph("block-521244", "蝉声渐渐稀落,最后只剩下零星的几声,像是告别。晚风终于")]);
    const draft = doc([paragraph("block-521244", "晚风")]);
    const hunks = buildDraftDiff(base, draft);

    // 全是纯删除:任何 hunk 的 afterText 都为空 —— 零 insert
    expect(hunks.every((hunk) => (hunk.afterText ?? "") === "")).toBe(true);
    // "晚风"是真锚点:既不被删、也不被假新增(不出现在任何 hunk 的增删文本里)
    expect(
      hunks.every((hunk) => !(hunk.beforeText ?? "").includes("晚风") && !(hunk.afterText ?? "").includes("晚风")),
    ).toBe(true);
    // 两笔删除恰好覆盖锚点前后两段
    expect(hunks.map((hunk) => hunk.beforeText).sort()).toEqual(
      ["终于", "蝉声渐渐稀落,最后只剩下零星的几声,像是告别。"].sort(),
    );
    expect(applyDiffHunks(base, hunks).doc).toEqual(draft);
  });

  it("苹果玩具例:'我爱吃苹果→苹果很好吃' = 删'我爱吃' + 增'很好吃','苹果'存活", () => {
    const base = doc([paragraph("blk-apple", "我爱吃苹果")]);
    const draft = doc([paragraph("blk-apple", "苹果很好吃")]);
    const hunks = buildDraftDiff(base, draft);

    expect(hunks.map((hunk) => [hunk.beforeText, hunk.afterText])).toEqual([
      ["我爱吃", ""],
      ["", "很好吃"],
    ]);
    expect(
      hunks.every((hunk) => !(hunk.beforeText ?? "").includes("苹果") && !(hunk.afterText ?? "").includes("苹果")),
    ).toBe(true);
    expect(applyDiffHunks(base, hunks).doc).toEqual(draft);
  });

  it("长段重写(晚风案同型):锚点天边/绚烂/晚风存活,处数收敛,无碎渣无假新增", () => {
    const base = doc([
      paragraph(
        "blk-dusk",
        "傍晚,蝉声渐渐稀落,最后只剩下零星的几声,像是告别。晚风终于带来一丝凉意,我站起身的走到窗前。远处的天边,晚霞正烧得绚烂。这一天的蝉声,就这样结束了。",
      ),
    ]);
    const draft = doc([
      paragraph(
        "blk-dusk",
        "傍晚,晚风带来凉意,我走到窗前。天边烧起绚烂的晚霞。我静静看天色一点点暗下去。",
      ),
    ]);
    const hunks = buildDraftDiff(base, draft);

    // 处数如实变多但收敛(★裁决:约 7~8 处),不再是字符级碎渣满地
    expect(hunks.length).toBeLessThanOrEqual(8);
    // 真锚点全部存活:既不被删、也不被假新增
    for (const anchor of ["天边", "绚烂", "晚风"]) {
      expect(
        hunks.every((hunk) => !(hunk.beforeText ?? "").includes(anchor) && !(hunk.afterText ?? "").includes(anchor)),
      ).toBe(true);
    }
    // 无假新增:没有 [del AXB][ins X] 结构
    expect(hunks.some((hunk) => isFakeInsert(hunk.beforeText ?? "", hunk.afterText ?? ""))).toBe(false);
    // 无纯标点/空白的孤立删除碎渣(表 §1 #3/#6"删,"那种无意义碎片)。
    // 注:锚点包夹的短实词删除(删"一丝"/"终于")是★裁决认可的可独立采纳编辑,不算碎渣。
    expect(
      hunks.some((hunk) => (hunk.afterText ?? "") === "" && (hunk.beforeText ?? "") !== "" && nonTrivialCount(hunk.beforeText ?? "") === 0),
    ).toBe(false);
    // 严格三态:每处非纯增即纯删即覆盖(inline 文本 hunk 的 op 归一为 replace)
    expect(applyDiffHunks(base, hunks).doc).toEqual(draft);
  });

  it("单字公共段'很'被吞进覆盖:不在其两侧切出增删交错(1 处覆盖,非 2 处)", () => {
    const base = doc([paragraph("blk-1", "天很蓝")]);
    const draft = doc([paragraph("blk-1", "地很绿")]);
    const hunks = buildDraftDiff(base, draft);

    // "很"<2 字非锚点 → 并入两侧,天/蓝与地/绿合成一处覆盖,而非绕开"很"切成两处
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ op: "replace", beforeText: "天很蓝", afterText: "地很绿" });
    expect(applyDiffHunks(base, hunks).doc).toEqual(draft);
  });
});

describe("脚注行内原子 diff", () => {
  it("note 或 id 改动生成原子 replace，应用后完整保留 attrs", () => {
    const base = doc([paragraph("p", [
      text("正文"),
      { type: "footnoteReference", attrs: { id: "source_a", note: "旧来源" } },
      text("继续"),
    ])]);
    const draft = doc([paragraph("p", [
      text("正文"),
      { type: "footnoteReference", attrs: { id: "source_b", note: "新来源" } },
      text("继续"),
    ])]);

    const hunks = buildDraftDiff(base, draft);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      op: "replace",
      before: [{
        type: "footnoteReference",
        attrs: { id: "source_a", note: "旧来源" },
      }],
      after: [{
        type: "footnoteReference",
        attrs: { id: "source_b", note: "新来源" },
      }],
    });
    expect(applyDiffHunks(base, hunks).doc).toEqual(draft);
  });

  it("同 id 同 note 不产生虚假 hunk", () => {
    const base = doc([paragraph("p", [
      text("正文"),
      { type: "footnoteReference", attrs: { id: "source_a", note: "来源" } },
    ])]);
    expect(buildDraftDiff(base, structuredClone(base))).toEqual([]);
  });
});

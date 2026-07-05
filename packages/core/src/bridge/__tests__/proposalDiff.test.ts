import { describe, expect, it } from "vitest";
import type { PmBlockNode, PmDoc, PmInlineNode, PmMark } from "@qingagent/pm-schema";
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
    expect(applyDiffHunks(base, hunks)).toEqual(draft);
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
    expect(applyDiffHunks(base, hunks)).toEqual(draft);
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
    expect(applyDiffHunks(insertBase, insertHunks)).toEqual(insertDraft);

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
    expect(applyDiffHunks(deleteBase, deleteHunks)).toEqual(deleteDraft);

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
    expect(applyDiffHunks(replaceBase, replaceHunks)).toEqual(replaceDraft);
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
    expect(applyDiffHunks(base, hunks)).toEqual(draft);
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
    expect(applyDiffHunks(base, hunks)).toEqual(draft);
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

    expect(applyDiffHunks(base, [onlyTree])).toEqual(
      doc([paragraph("block-a", "湖边有胡桃树。他拿着蓝毛巾。")]),
    );
  });

  it("同段部分采纳后 rebase 空插入 hunk 时按完整目标块避开重复文本误定位", () => {
    const base = doc([paragraph("block-a", "df eeffba  efdefe b ")]);
    const draft = doc([paragraph("block-a-draft", "df eeffbbac ed befee ebff ")]);
    const hunks = buildDraftDiff(base, draft, { baseVersion: 7 });
    expect(hunks.map((hunk) => [hunk.beforeText, hunk.afterText])).toEqual([
      ["a  efd", "bac ed b"],
      ["", "e"],
      ["b", "ebff"],
    ]);

    const committed = applyDiffHunks(base, [hunks[0]!, hunks[2]!]);
    const applied = applyDiffHunkToDoc(committed, hunks[1]!, {
      oldBaseDoc: base,
      anchorByBlockId: true,
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

    const committed = applyDiffHunks(base, hunks.filter((hunk) => hunk !== insert));
    const applied = applyDiffHunkToDoc(committed, insert, {
      oldBaseDoc: base,
      anchorByBlockId: true,
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

    const committed = applyDiffHunks(base, [hunks[0]!, hunks[2]!]);
    const applied = applyDiffHunkToDoc(committed, hunks[1]!, {
      oldBaseDoc: base,
      anchorByBlockId: true,
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(firstBlockText(applied.doc)).toBe("e cce dcdbf feadcfbb cecffaec dce");
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
      expect(applyDiffHunks(base, buildDraftDiff(base, draft))).toEqual(draft);
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
      expect(applyDiffHunks(base, [hunks[0]!])).toEqual(draft);
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
    expect(applyDiffHunks(base, hunks)).toEqual(draft);
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
    expect(applyDiffHunks(base, hunks)).toEqual(draft);
  });

  it("codeBlock 仅改 language 产出 hunk,不再被当 noop(p09 死锁解除)", () => {
    const base = doc([codeBlock("c1", "typescript", "const a = 1;")]);
    const draft = doc([codeBlock("c1", "javascript", "const a = 1;")]);

    const hunks = buildDraftDiff(base, draft, { baseVersion: 1 });

    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.op).toBe("replace");
    expect(applyDiffHunks(base, hunks)).toEqual(draft);
  });

  it("attrs 完全相同(仅键序不同)不产生虚假 hunk", () => {
    const a = doc([{ type: "heading", attrs: { blockId: "h", level: 2 }, content: [text("题")] } as PmBlockNode]);
    const b = doc([{ type: "heading", attrs: { level: 2, blockId: "h" }, content: [text("题")] } as PmBlockNode]);

    expect(buildDraftDiff(a, b, { baseVersion: 1 })).toHaveLength(0);
  });
});

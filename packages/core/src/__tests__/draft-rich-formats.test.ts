import { describe, expect, it } from "vitest";
import {
  aiBlockToQingml,
  aiBlocksToQingml,
  aiIrToPm,
  applyBlockEdits,
  compileAiDocumentToPm,
  getStablePmJson,
  pmToAiIr,
  pmToLegacySections,
  type AiBlock,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
  type PmMark,
} from "@qingagent/pm-schema";
import {
  createSession,
  createSessionScopedTools,
} from "../bridge/index.js";
import { buildDraftDiff } from "../doc-engine/proposalDiff.js";

const ctx = {} as any;
const INLINE_ATOM_PLACEHOLDER = "\uFFFC";

function qingmlBlock(block: unknown): string {
  return aiBlockToQingml(block as never);
}

function qingmlBlocks(blocks: readonly unknown[]): string {
  return aiBlocksToQingml(blocks as never);
}

function text(value: string, marks?: PmMark[]): PmInlineNode {
  return marks && marks.length > 0
    ? { type: "text", text: value, marks }
    : { type: "text", text: value };
}

function inlineMath(latex: string): PmInlineNode {
  return { type: "inlineMath", attrs: { latex } };
}

function paragraph(
  blockId: string,
  content: string | PmInlineNode[],
): Extract<PmBlockNode, { type: "paragraph" }> {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: typeof content === "string" ? [text(content)] : content,
  };
}

function taskList(
  blockId: string,
  items: Array<{ checked: boolean; text: string }>,
): PmBlockNode {
  return {
    type: "taskList",
    attrs: { blockId },
    content: items.map((item, index) => ({
      type: "taskItem",
      attrs: { blockId: `${blockId}-item-${index + 1}`, checked: item.checked },
      content: [paragraph(`${blockId}-item-${index + 1}-p`, item.text)],
    })),
  };
}

function doc(content: PmBlockNode[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function bindDoc(state: ReturnType<typeof createSession>, value: PmDoc): void {
  state.doc = value;
  state.docVersion = 1;
}

function compileDoc(blocks: readonly unknown[]): PmDoc {
  const result = compileAiDocumentToPm({ blocks });
  expect(result.ok).toBe(true);
  return result.doc!;
}

function inlineProjection(block: PmBlockNode): string {
  if (!("content" in block) || !Array.isArray(block.content)) return "";
  return block.content
    .map((node: any) => {
      if (node.type === "hardBreak") return "\n";
      if (node.type === "inlineMath") return INLINE_ATOM_PLACEHOLDER;
      return node.text;
    })
    .join("");
}

function taskChecks(block: PmBlockNode): boolean[] {
  expect(block.type).toBe("taskList");
  return block.type === "taskList"
    ? block.content.map((item) => item.attrs.checked)
    : [];
}

describe("draft rich formats AI 草稿工具链路", () => {
  it("editDraft 块级混合事务:替换 taskList、插入 callout/blockMath、删除块,失败时整组回滚", async () => {
    const base = doc([
      taskList("block-tasks", [
        { checked: false, text: "梳理提纲" },
        { checked: true, text: "确认素材" },
      ]),
      paragraph("block-delete", "临时说明"),
      paragraph("block-tail", "收尾"),
    ]);
    const state = createSession("rich-block-edits");
    bindDoc(state, base);
    const { editDraft } = createSessionScopedTools(state);

    const success = await editDraft.execute!({
      ops: [
        {
          action: "replaceBlock",
          ref: "block-tasks",
          block: qingmlBlock({
            type: "taskList",
            items: [
              { checked: true, runs: [{ text: "梳理提纲" }] },
              { checked: true, runs: [{ text: "确认素材" }] },
            ],
          }),
        },
        {
          action: "insertBlock",
          position: "after",
          ref: "block-tasks",
          blocks: qingmlBlocks([
            { type: "callout", emoji: "!", tone: "warning", runs: [{ text: "风险项需要复核" }] },
            { type: "blockMath", latex: "E=mc^2" },
          ]),
        },
        { action: "deleteBlock", ref: "block-delete" },
      ],
    }, ctx) as any;

    expect(success.ok).toBe(true);
    expect(state.docDraftCandidateDoc?.content.map((block) => block.type)).toEqual([
      "taskList",
      "callout",
      "blockMath",
      "paragraph",
    ]);
    expect(taskChecks(state.docDraftCandidateDoc!.content[0]!)).toEqual([true, true]);
    expect(state.docDraftCandidateDoc!.content[1]).toMatchObject({
      type: "callout",
      attrs: { emoji: "!", tone: "warning" },
    });
    expect(state.docDraftCandidateDoc!.content[2]).toMatchObject({
      type: "blockMath",
      attrs: { latex: "E=mc^2" },
    });
    expect(state.docDraftCandidateDoc!.content[3]!.attrs.blockId).toBe("block-tail");
    expect(state.doc!.content.map((block) => block.attrs.blockId)).toEqual([
      "block-tasks",
      "block-delete",
      "block-tail",
    ]);

    const rollbackState = createSession("rich-block-edits-rollback");
    bindDoc(rollbackState, base);
    const { editDraft: rollbackEditDraft } = createSessionScopedTools(rollbackState);
    const before = getStablePmJson(rollbackState.doc);
    const failed = await rollbackEditDraft.execute!({
      ops: [
        {
          action: "replaceBlock",
          ref: "block-tasks",
          block: qingmlBlock({
            type: "taskList",
            items: [{ checked: true, runs: [{ text: "不会落盘" }] }],
          }),
        },
        {
          action: "insertBlock",
          position: "after",
          ref: "block-tasks",
          blocks: qingmlBlock({ type: "callout", tone: "info", runs: [{ text: "也不会落盘" }] }),
        },
        { action: "deleteBlock", ref: "block-missing" },
      ],
    }, ctx) as any;

    expect(failed.ok).toBe(false);
    expect(failed.failedOpIndex).toBe(2);
    expect(getStablePmJson(rollbackState.docDraftCandidateDoc ?? rollbackState.doc)).toBe(before);
  });

  it("QingML 脏输入:合法 taskList 可插入,math+bold 混用不崩,坏片段给可读错误", async () => {
    const state = createSession("rich-dirty-aiir");
    bindDoc(state, doc([paragraph("block-anchor", "基准")]));
    const { editDraft } = createSessionScopedTools(state);

    const repaired = await editDraft.execute!({
      ops: [{
        action: "insertBlock",
        position: "after",
        ref: "block-anchor",
        blocks: "<tasks><task>普通任务</task><task>公式 <math>a^2+b^2</math></task></tasks>",
      }],
    }, ctx) as any;

    expect(repaired.ok).toBe(true);
    const insertedTaskList = state.docDraftCandidateDoc!.content[1]!;
    expect(taskChecks(insertedTaskList)).toEqual([false, false]);

    const mixedMath = compileAiDocumentToPm({
      blocks: [{
        type: "paragraph",
        runs: [{ text: "x+y", marks: [{ type: "math" }, { type: "bold" }] }],
      }],
    });
    expect(mixedMath.ok).toBe(true);
    expect(mixedMath.doc!.content[0]).toMatchObject({
      type: "paragraph",
      content: [{ type: "inlineMath", attrs: { latex: "x+y" } }],
    });

    const emptyMath = await editDraft.execute!({
      ops: [{
        action: "insertBlock",
        position: "after",
        ref: "block-anchor",
        blocks: "<math-block></math-block>",
      }],
    }, ctx) as any;
    expect(emptyMath.ok).toBe(false);
    expect(emptyMath.failedOpIndex).toBe(0);
    expect(emptyMath.error).toContain("QingML bad-block");
    expect(emptyMath.error).toContain("latex");

    const invalidCallout = await editDraft.execute!({
      ops: [{
        action: "insertBlock",
        position: "after",
        ref: "block-anchor",
        blocks: "<callout><h2>callout 仅允许 paragraph</h2></callout>",
      }],
    }, ctx) as any;
    expect(invalidCallout.ok).toBe(false);
    expect(invalidCallout.failedOpIndex).toBe(0);
    expect(invalidCallout.error).toContain("QingML bad-block");
    expect(invalidCallout.error).not.toContain("TypeError");
  });

  it("replaceText/markText 在 inlineMath 的 U+FFFC 占位 offset 下不跑偏,横跨公式区间不崩", async () => {
    const bold: PmMark = { type: "bold" };
    const state = createSession("rich-inline-math-text");
    bindDoc(state, doc([
      paragraph("block-formula", [
        text("速度 "),
        inlineMath("v=t^2"),
        text(" 很快"),
      ]),
    ]));
    const { editDraft } = createSessionScopedTools(state);

    const result = await editDraft.execute!({
      ops: [
        { action: "replaceText", find: "速度 ", replace: "平均速度 " },
        { action: "replaceText", find: " 很快", replace: " 稳定" },
        {
          action: "markText",
          find: `度 ${INLINE_ATOM_PLACEHOLDER} 稳`,
          mark: { type: "bold" },
          op: "add",
        },
      ],
    }, ctx) as any;

    expect(result.ok).toBe(true);
    const block = state.docDraftCandidateDoc!.content[0]!;
    expect(inlineProjection(block)).toBe(`平均速度 ${INLINE_ATOM_PLACEHOLDER} 稳定`);
    expect(block).toMatchObject({
      content: [
        { type: "text", text: "平均速" },
        { type: "text", text: "度 ", marks: [bold] },
        { type: "inlineMath", attrs: { latex: "v=t^2" } },
        { type: "text", text: " 稳", marks: [bold] },
        { type: "text", text: "定" },
      ],
    });
  });

  it("buildDraftDiff:taskList checked 翻转是单块 replace,插入 blockMath 是 insert,含 U+FFFC 投影不崩", () => {
    const baseTask = doc([
      taskList("block-tasks", [
        { checked: false, text: "写摘要" },
        { checked: true, text: "审校" },
      ]),
    ]);
    const editedTask = applyBlockEdits(baseTask, [{
      action: "replaceBlock",
      ref: "block-tasks",
      block: {
        type: "taskList",
        items: [
          { checked: true, runs: [{ text: "写摘要" }] },
          { checked: true, runs: [{ text: "审校" }] },
        ],
      },
    }]);
    expect(editedTask.ok).toBe(true);

    const taskHunks = buildDraftDiff(baseTask, editedTask.doc!);
    expect(taskHunks).toHaveLength(1);
    expect(taskHunks[0]).toMatchObject({
      op: "replace",
      blockPath: [0],
      anchor: { blockId: "block-tasks" },
      beforeText: "[ ] 写摘要\n[x] 审校",
      afterText: "[x] 写摘要\n[x] 审校",
    });
    expect(taskHunks.map((hunk) => hunk.op)).not.toEqual(expect.arrayContaining(["insert", "delete"]));

    const baseInsert = doc([paragraph("block-a", "正文")]);
    const insertedMath = applyBlockEdits(baseInsert, [{
      action: "insertBlock",
      position: "after",
      ref: "block-a",
      blocks: [{ type: "blockMath", latex: "\\int_0^1 x^2 dx" }],
    }]);
    expect(insertedMath.ok).toBe(true);
    const insertHunks = buildDraftDiff(baseInsert, insertedMath.doc!);
    expect(insertHunks).toHaveLength(1);
    expect(insertHunks[0]).toMatchObject({
      op: "insert",
      blockPath: [1],
      afterText: "\\int_0^1 x^2 dx",
      afterBlock: { type: "blockMath", attrs: { latex: "\\int_0^1 x^2 dx" } },
    });

    const baseInline = doc([paragraph("block-formula", [
      text("令 "),
      inlineMath("x+1"),
      text(" 成立"),
    ])]);
    const draftInline = doc([paragraph("block-formula", "令 条件 成立")]);
    const inlineHunks = buildDraftDiff(baseInline, draftInline);
    expect(inlineHunks).toHaveLength(1);
    expect(inlineHunks[0]).toMatchObject({
      op: "replace",
      anchor: { blockId: "block-formula" },
      beforeText: INLINE_ATOM_PLACEHOLDER,
      afterText: "条件",
    });
  });

  it("pmToAiIr/aiIrToPm 对 taskList/callout/blockMath/inlineMath 连续 3 轮字节级稳定", () => {
    const richBlocks: AiBlock[] = [
      {
        type: "taskList",
        items: [
          { checked: false, runs: [{ text: "准备" }] },
          { checked: true, runs: [{ text: "复核公式 ", marks: [{ type: "bold" }] }, { text: "a^2+b^2", marks: [{ type: "math" }] }] },
        ],
      },
      { type: "callout", emoji: "i", tone: "info", runs: [{ text: "注意公式上下文" }] },
      { type: "paragraph", runs: [{ text: "行内 " }, { text: "\\alpha+\\beta", marks: [{ type: "math" }] }, { text: " 结束" }] },
      { type: "blockMath", latex: "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}" },
    ];
    let current = compileDoc(richBlocks);
    let stable = getStablePmJson(current);

    for (let round = 0; round < 3; round += 1) {
      current = aiIrToPm(pmToAiIr(current));
      const nextStable = getStablePmJson(current);
      expect(nextStable).toBe(stable);
      stable = nextStable;
    }
  });
});

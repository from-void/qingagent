import { describe, expect, it } from "vitest";
import { analyzeAiIrEditability } from "../ai-ir/aiIrEditability";
import type { PmBlockNode } from "../types";

const paragraph = (blockId: string, text = ""): PmBlockNode => ({
  type: "paragraph",
  attrs: { blockId },
  content: text ? [{ type: "text", text }] : [],
});

const heading = (blockId: string): PmBlockNode => ({
  type: "heading",
  attrs: { blockId, level: 2 },
  content: [{ type: "text", text: "标题" }],
});

const penNote = (blockId: string): PmBlockNode => ({
  type: "penNote",
  attrs: { blockId },
  content: [{ type: "text", text: "手写" }],
});

describe("analyzeAiIrEditability", () => {
  it("普通段落、标题、单段列表项允许 replaceBlock", () => {
    expect(analyzeAiIrEditability(paragraph("block-p")).replaceBlockAllowed).toBe(true);
    expect(analyzeAiIrEditability(heading("block-h")).lossyReasons).toEqual([]);
    const list: PmBlockNode = {
      type: "bulletList",
      attrs: { blockId: "block-list" },
      content: [{ type: "listItem", attrs: { blockId: "block-item" }, content: [paragraph("block-item-p")] }],
    };
    expect(analyzeAiIrEditability(list)).toEqual({ replaceBlockAllowed: true, lossyReasons: [] });
  });

  it("taskItem 首段 paragraph 加子 list/taskList 可由 AI-IR children 无损替换", () => {
    const taskList: PmBlockNode = {
      type: "taskList",
      attrs: { blockId: "block-tasks" },
      content: [
        {
          type: "taskItem",
          attrs: { blockId: "block-task-1", checked: false },
          content: [
            paragraph("block-task-1-p", "父任务"),
            {
              type: "taskList",
              attrs: { blockId: "block-task-1-child-tasks" },
              content: [
                {
                  type: "taskItem",
                  attrs: { blockId: "block-child-task-1", checked: true },
                  content: [paragraph("block-child-task-1-p", "子任务")],
                },
              ],
            },
            {
              type: "bulletList",
              attrs: { blockId: "block-task-1-child-list" },
              content: [
                {
                  type: "listItem",
                  attrs: { blockId: "block-task-1-child-item" },
                  content: [paragraph("block-task-1-child-item-p", "补充项")],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(analyzeAiIrEditability(taskList)).toEqual({ replaceBlockAllowed: true, lossyReasons: [] });
  });

  it("taskItem 子层级不是 list/taskList 时仍标记有损", () => {
    const taskList: PmBlockNode = {
      type: "taskList",
      attrs: { blockId: "block-tasks" },
      content: [
        {
          type: "taskItem",
          attrs: { blockId: "block-task-1", checked: false },
          content: [
            paragraph("block-task-1-p", "父任务"),
            paragraph("block-task-1-extra", "额外段落"),
          ],
        },
      ],
    };

    expect(analyzeAiIrEditability(taskList)).toEqual({
      replaceBlockAllowed: false,
      lossyReasons: ["multiBlockListItem"],
    });
  });

  it("嵌套列表、多块列表项、复杂列表子块支持 AI-IR 递归替换", () => {
    const nested: PmBlockNode = {
      type: "bulletList",
      attrs: { blockId: "block-list" },
      content: [
        {
          type: "listItem",
          attrs: { blockId: "block-item" },
          content: [
            paragraph("block-p"),
            {
              type: "orderedList",
              attrs: { blockId: "block-nested", start: 1 },
              content: [{ type: "listItem", attrs: { blockId: "block-nested-item" }, content: [paragraph("block-nested-p")] }],
            },
            { type: "codeBlock", attrs: { blockId: "block-code", language: "text" }, content: [{ type: "text", text: "x" }] },
          ],
        },
      ],
    };

    const result = analyzeAiIrEditability(nested);

    expect(result).toEqual({ replaceBlockAllowed: true, lossyReasons: [] });
  });

  it("columnList 递归检查列内块,简单分栏可替换", () => {
    const columns: PmBlockNode = {
      type: "columnList",
      attrs: { blockId: "block-columns" },
      content: [
        {
          type: "column",
          attrs: { blockId: "block-col-1", widthRatio: 0.5 },
          content: [heading("block-h"), paragraph("block-p")],
        },
        {
          type: "column",
          attrs: { blockId: "block-col-2", widthRatio: 0.5 },
          content: [penNote("block-note")],
        },
      ],
    };

    expect(analyzeAiIrEditability(columns)).toEqual({ replaceBlockAllowed: true, lossyReasons: [] });
  });

  it("table cell 多块或复杂子块可无损编辑", () => {
    const table: PmBlockNode = {
      type: "table",
      attrs: { blockId: "block-table" },
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [paragraph("block-c1"), penNote("block-c2")] },
            {
              type: "tableCell",
              content: [{ type: "blockquote", attrs: { blockId: "block-q" }, content: [paragraph("block-qp")] }],
            },
          ],
        },
      ],
    };

    const result = analyzeAiIrEditability(table);

    expect(result).toEqual({ replaceBlockAllowed: true, lossyReasons: [] });
  });

  it("合并表仅在存在 colwidth 时临时拒绝 replaceBlock", () => {
    const merged = (colwidth?: number[]): PmBlockNode => ({
      type: "table",
      attrs: { blockId: "block-merged" },
      content: [{
        type: "tableRow",
        content: [{
          type: "tableCell",
          attrs: { colspan: 2, ...(colwidth ? { colwidth } : {}) },
          content: [paragraph("block-merged-p")],
        }],
      }],
    });

    expect(analyzeAiIrEditability(merged([120, 160]))).toEqual({
      replaceBlockAllowed: false,
      lossyReasons: ["mergedTableColwidth"],
    });
    expect(analyzeAiIrEditability(merged())).toEqual({
      replaceBlockAllowed: true,
      lossyReasons: [],
    });
  });

  it("blockquote 多块或复杂子块标 lossy", () => {
    const quote: PmBlockNode = {
      type: "blockquote",
      attrs: { blockId: "block-q" },
      content: [paragraph("block-p"), { type: "horizontalRule", attrs: { blockId: "block-hr" } }],
    };

    const result = analyzeAiIrEditability(quote);

    expect(result.replaceBlockAllowed).toBe(false);
    expect(result.lossyReasons).toEqual(expect.arrayContaining(["multiBlockBlockquote", "complexBlockquoteChild"]));
  });
});

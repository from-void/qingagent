import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../bridge/sessionState.js";
import type { BridgeFrame, PmDoc } from "@qingagent/contract-ts";

const agentStreamCalls: Array<{ messages: unknown[]; options: Record<string, unknown> }> = [];

async function collectFrames(
  gen: AsyncGenerator<BridgeFrame>,
): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) {
    frames.push(frame);
  }
  return frames;
}

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async () => []),
}));

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock("../agents/qingagent.js", () => ({
  getQingagentSkills: vi.fn(async () => ({
    maybeRefresh: vi.fn(async () => {}),
    has: vi.fn(async () => false),
  })),
  qingagentAgent: {
    stream: vi.fn(async (messages: unknown[], options: Record<string, unknown>) => {
      agentStreamCalls.push({ messages, options });
      return {
        fullStream: (async function* () {
          yield { type: "text-delta" as const, payload: { text: "收到。" } };
        })(),
        toolCalls: Promise.resolve([]),
      };
    }),
  },
}));

/**
 * 复现真实 bug:文档里第 9 章是一个【图表】原子块,前面隔着若干表格/列表,后面第 11 章是表格。
 * 旧实现用 PM text block 长度估算反推位置——表格/列表/原子块全算错,
 * from/to 漂移,图表(无内联文字)又只剩 label,readDraft(query) 模糊命中到了第 11 章表格。
 * 新实现:chip 携带稳定 blockId(放进 resourceRef.id),后端按 id 精确命中该图表块。
 */
function makeDocWithDiagram(): PmDoc {
  const para = (blockId: string, text: string) => ({
    type: "paragraph",
    attrs: { blockId },
    content: text ? [{ type: "text", text }] : [],
  });
  const cell = (text: string) => ({
    type: "tableCell",
    attrs: { blockId: `cell-${text}` },
    content: [para(`cellp-${text}`, text)],
  });
  const tableRow = (a: string, b: string) => ({
    type: "tableRow",
    attrs: { blockId: `row-${a}` },
    content: [cell(a), cell(b)],
  });
  const table = (blockId: string, a: string, b: string) => ({
    type: "table",
    attrs: { blockId },
    content: [tableRow(a, b)],
  });
  const listItem = (text: string) => ({
    type: "listItem",
    attrs: { blockId: `li-${text}` },
    content: [para(`lip-${text}`, text)],
  });
  const bulletList = (blockId: string, ...items: string[]) => ({
    type: "bulletList",
    attrs: { blockId },
    content: items.map(listItem),
  });

  return {
    type: "doc",
    attrs: {},
    content: [
      { type: "heading", attrs: { blockId: "h-ch1", level: 1 }, content: [{ type: "text", text: "第1章" }] },
      table("tbl-ch1", "成本", "100"),
      bulletList("ul-ch2", "要点一", "要点二", "要点三"),
      table("tbl-ch5", "指标", "增长"),
      { type: "heading", attrs: { blockId: "h-ch9", level: 1 }, content: [{ type: "text", text: "第9章" }] },
      // 被引用的图表块(原子块,无内联文字)
      {
        type: "diagram",
        attrs: { blockId: "diagram-ch9", lang: "mermaid", source: "flowchart TD\n  A[第九章起点] --> B[第九章终点]", svg: null },
      },
      { type: "heading", attrs: { blockId: "h-ch11", level: 1 }, content: [{ type: "text", text: "第11章" }] },
      table("tbl-ch11", "项目", "金额"),
    ],
  } as unknown as PmDoc;
}

function pBlock(blockId: string, text: string) {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [{ type: "text", text }] : [],
  };
}

function liBlock(blockId: string, paragraphId: string, text: string) {
  return {
    type: "listItem",
    attrs: { blockId },
    content: [pBlock(paragraphId, text)],
  };
}

function bulletBlock(blockId: string, items: Array<{ blockId: string; paragraphId: string; text: string }>) {
  return {
    type: "bulletList",
    attrs: { blockId },
    content: items.map((item) => liBlock(item.blockId, item.paragraphId, item.text)),
  };
}

describe("selection chip resolves referenced block by stable blockId", () => {
  beforeEach(() => {
    agentStreamCalls.length = 0;
  });

  it("引用第9章图表(原子块)精确命中该图表,而非漂移到第11章表格", async () => {
    const { runAgentTurn } = await import("../bridge/runAgentTurn.js");

    const state = createSession("sess-blockid-ref");
    state.doc = makeDocWithDiagram();
    state.docVersion = 1;
    state.docState = { kind: "editing" };

    await collectFrames(
      runAgentTurn(
        state,
        "把这个图表配色改暖一点",
        [],
        [
          {
            kind: { kind: "selection" },
            // 关键:resourceRef.id 承载被选中图表块的 blockId
            resourceRef: { id: "diagram-ch9", domain: { kind: "docSpan" } },
            prefix: null,
            label: "图表",
            suffix: "批注",
            from: 999,
            to: 1000,
          },
        ],
      ),
    );

    const userMsg = state.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const content = userMsg!.content as string;

    // 精确命中图表块:带上它的 mermaid 源码 + 确切 ref
    expect(content).toContain("【用户选中的文档片段】");
    expect(content).toContain("第九章起点");
    expect(content).toContain('ref="diagram-ch9"');
    expect(content).toContain("类型:diagram");
    // 走精确路径:不再让模型对"图表"做模糊 query(那正是命中错块的根源)
    expect(content).not.toContain('readDraft(query: "图表")');
    // 没把第11章表格内容错当成被引用内容
    expect(content).not.toContain("第11章");
  });

  it("文本部分选区:精确锁定所在段落块,同时点名块内具体选中的子串", async () => {
    const { runAgentTurn } = await import("../bridge/runAgentTurn.js");

    const fullPara = "三月的阳光透过教学楼的玻璃窗,洒在走廊的地砖上。";
    const selected = "三月的阳光";
    const state = createSession("sess-text-subselection");
    state.doc = {
      type: "doc",
      attrs: {},
      content: [
        { type: "heading", attrs: { blockId: "h-1", level: 1 }, content: [{ type: "text", text: "春天的校园" }] },
        { type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text: fullPara }] },
      ],
    } as unknown as PmDoc;
    state.docVersion = 1;
    state.docState = { kind: "editing" };

    await collectFrames(
      runAgentTurn(
        state,
        "把它改得更温暖一点",
        [],
        [
          {
            kind: { kind: "selection" },
            resourceRef: { id: "p-1", domain: { kind: "docSpan" } },
            prefix: null,
            label: selected,
            suffix: "批注",
            from: 30,
            to: 30 + selected.length,
          },
        ],
      ),
    );

    const content = state.messages.find((m) => m.role === "user")!.content as string;
    // 块级精确:锁定段落块 p-1,给整段
    expect(content).toContain('ref="p-1"');
    expect(content).toContain(fullPara);
    // 子串精确:点名用户具体选中的那段,引导 replaceText/markText withinRef
    expect(content).toContain("用户在该块内具体选中的文字是");
    expect(content).toContain(selected);
    expect(content).toContain('action:"replaceText" withinRef:"p-1"');
    expect(content).toContain('action:"markText" withinRef:"p-1"');
  });

  it("列表行选区:递归命中 column 内 listItem ref,提示 replaceText withinRef 只改该行", async () => {
    const { runAgentTurn } = await import("../bridge/runAgentTurn.js");

    const state = createSession("sess-list-item-in-column");
    state.doc = {
      type: "doc",
      attrs: {},
      content: [
        {
          type: "columnList",
          attrs: { blockId: "cols-1" },
          content: [
            {
              type: "column",
              attrs: { blockId: "col-1", widthRatio: 1 },
              content: [
                bulletBlock("list-in-col", [
                  { blockId: "item-1", paragraphId: "item-1-p", text: "第一行" },
                  { blockId: "item-2", paragraphId: "item-2-p", text: "第二行" },
                ]),
              ],
            },
          ],
        },
      ],
    } as unknown as PmDoc;
    state.docVersion = 1;
    state.docState = { kind: "editing" };

    await collectFrames(
      runAgentTurn(
        state,
        "把这行改得更明确",
        [],
        [
          {
            kind: { kind: "selection" },
            resourceRef: { id: "item-2", domain: { kind: "docSpan" } },
            prefix: null,
            label: "第二行",
            suffix: "批注",
            from: 1,
            to: 4,
          },
        ],
      ),
    );

    const content = state.messages.find((m) => m.role === "user")!.content as string;
    expect(content).toContain('列表行 ref="item-2"');
    expect(content).toContain('父列表 ref="list-in-col"');
    expect(content).toContain('readDraft(mode:"range", from:"item-2", to:"item-2", includeText:true)');
    expect(content).toContain('action:"replaceText" withinRef:"item-2"');
    expect(content).toContain("不要改未选中的 sibling 行");
    expect(content).not.toContain("readDraft(query:");
  });

  it("多行列表选区:selectionRefs 按多 item ref 注入上下文", async () => {
    const { runAgentTurn } = await import("../bridge/runAgentTurn.js");

    const state = createSession("sess-list-item-multi");
    state.doc = {
      type: "doc",
      attrs: {},
      content: [
        bulletBlock("list-1", [
          { blockId: "item-1", paragraphId: "item-1-p", text: "第一行" },
          { blockId: "item-2", paragraphId: "item-2-p", text: "第二行" },
          { blockId: "item-3", paragraphId: "item-3-p", text: "第三行" },
        ]),
      ],
    } as unknown as PmDoc;
    state.docVersion = 1;
    state.docState = { kind: "editing" };

    await collectFrames(
      runAgentTurn(
        state,
        "把选中的两行都改短",
        [],
        [
          {
            kind: { kind: "selection" },
            resourceRef: { id: "item-1", domain: { kind: "docSpan" } },
            selectionRefs: ["item-1", "item-2"],
            prefix: null,
            label: "第一行\n第二行",
            suffix: "批注",
            from: 1,
            to: 8,
          },
        ],
      ),
    );

    const content = state.messages.find((m) => m.role === "user")!.content as string;
    expect(content).toContain("已选中 2 个列表行");
    expect(content).toContain('ref="item-1"');
    expect(content).toContain('ref="item-2"');
    expect(content).toContain('refs=["item-1","item-2"]');
    expect(content).toContain('action:"replaceText" withinRef:<itemRef>');
    expect(content).not.toContain("readDraft(query:");
  });

  it("命中不到 blockId(老链路/占位 id)时降级到文本模糊定位,不抛错", async () => {
    const { runAgentTurn } = await import("../bridge/runAgentTurn.js");

    const state = createSession("sess-blockid-fallback");
    state.legacySections = [
      { kind: "h1", data: { text: "标题" } },
      { kind: "p", data: { text: "三月的阳光透过窗子洒在地上。" } },
    ];
    state.docVersion = 1;
    state.docState = { kind: "editing" };

    await collectFrames(
      runAgentTurn(
        state,
        "改暖一点",
        [],
        [
          {
            kind: { kind: "selection" },
            // 占位 id,文档里没有任何块的 blockId 等于它 → 降级
            resourceRef: { id: "sel-1700000000000", domain: { kind: "docSpan" } },
            prefix: null,
            label: "三月的阳光",
            suffix: null,
            from: 9,
            to: 9 + "三月的阳光".length,
          },
        ],
      ),
    );

    const userMsg = state.messages.find((m) => m.role === "user");
    const content = userMsg!.content as string;
    expect(content).toContain("【用户选中的文档片段】");
    // 降级路径不再做位置估算,直接使用 chip label 做 readDraft query,仍给出 query 提示、不抛错。
    expect(content).toContain("readDraft(query:");
    expect(content).toContain('readDraft(query: "三月的阳光")');
    expect(content).not.toContain("透过窗子");
    expect(content).toContain('action:"replaceText"');
    expect(content).toContain('action:"markText"');
    expect(content).toContain("withinRef");
  });
});

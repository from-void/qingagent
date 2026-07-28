import { describe, expect, it, vi } from "vitest";
import { legacySectionsToPm, type PmBlockNode, type PmDoc } from "@qingagent/pm-schema";
import {
  advanceNativeConcurrentState,
  buildNativeDiffInstructions,
  buildNativePresentationSeedSections,
  cloneNativePresentationRun,
  createNativeConcurrentState,
  planNativeTiming,
  type NativePresentationRun,
} from "./nativeDiffAnimation";
import { laneColor } from "./humanCursorLanes";
import * as presentationSpans from "./presentationSpans";
import { sectionText } from "./presentationSpans";
import type { ViewBlock } from "./protocol";
import { viewSectionsToHtml } from "./viewDocHtml";

function p(text: string): ViewBlock {
  return { kind: "p", spans: [{ kind: "text", text }] };
}

function columnDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "columnList",
      attrs: { blockId: "columns-native" },
      content: [
        {
          type: "column",
          attrs: { blockId: "column-native-left", widthRatio: 0.5 },
          content: [{ type: "paragraph", attrs: { blockId: "column-native-left-p" }, content: [{ type: "text", text: "左栏动画" }] }],
        },
        {
          type: "column",
          attrs: { blockId: "column-native-right", widthRatio: 0.5 },
          content: [{ type: "paragraph", attrs: { blockId: "column-native-right-p" }, content: [{ type: "text", text: "右栏动画" }] }],
        },
      ],
    }],
  } as PmDoc;
}

describe("native PM presentation animation", () => {
  it("builds whole-document insert instructions ordered by headings first", () => {
    const finalSections: ViewBlock[] = [
      p("正文"),
      { kind: "h1", text: "标题" },
      { kind: "h2", text: "小节", anchor: "a" },
    ];

    const instructions = buildNativeDiffInstructions({ finalSections });

    expect(instructions.map((instruction) => instruction.kind)).toEqual([
      "insertSection",
      "insertSection",
      "insertSection",
    ]);
    expect(instructions.map((instruction) =>
      instruction.kind === "insertSection" ? sectionText(instruction.section) : "",
    )).toEqual(["标题", "小节", "正文"]);
  });

  it("attaches PM block ids and positions when a final PM doc is available", () => {
    const finalSections: ViewBlock[] = [{ kind: "h1", text: "标题" }, p("正文")];
    const finalDoc = legacySectionsToPm([
      { kind: "h1", data: { text: "标题" } },
      { kind: "p", data: { text: "正文" } },
    ]);

    const instructions = buildNativeDiffInstructions({ finalSections, finalDoc });

    expect(instructions[0]).toMatchObject({
      kind: "insertSection",
      blockId: finalDoc.content[0]?.attrs.blockId,
      pmAt: 1,
    });
    expect(instructions[1]).toMatchObject({
      kind: "insertSection",
      blockId: finalDoc.content[1]?.attrs.blockId,
    });
  });

  it("attaches PM refs for columnList by using flattened column text", () => {
    const finalDoc = columnDoc();
    const instructions = buildNativeDiffInstructions({
      finalDoc,
      finalSections: [p("左栏动画\n右栏动画")],
    });

    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toMatchObject({
      kind: "insertSection",
      blockId: "columns-native",
      pmAt: 1,
    });
  });

  it("seeds editable text blocks as empty placeholders for whole-document animation", () => {
    const finalSections: ViewBlock[] = [
      { kind: "h1", text: "标题" },
      p("正文"),
      { kind: "table", head: ["A"], rows: [["B"]] },
    ];

    expect(buildNativePresentationSeedSections({ finalSections }).map(sectionText)).toEqual([
      "",
      "",
      "\n",
    ]);
  });

  it("只让安全纯文本表格丢弃 node 进入逐格动画，复杂表格种子保留原始 node", () => {
    const textCell = {
      type: "tableCell",
      attrs: { colspan: 1, rowspan: 1, colwidth: null, backgroundColor: null },
      content: [{
        type: "paragraph",
        attrs: { blockId: "safe-p" },
        content: [{ type: "text", text: "安全单元" }],
      }],
    } as const;
    const safeTable = {
      type: "table",
      attrs: { blockId: "safe-table" },
      content: [{ type: "tableRow", content: [textCell] }],
    } as unknown as PmBlockNode;
    const complexTable = {
      type: "table",
      attrs: { blockId: "complex-table" },
      content: [{
        type: "tableRow",
        content: [{
          ...textCell,
          attrs: { ...textCell.attrs, colspan: 2, colwidth: [120, 180] },
        }],
      }],
    } as unknown as PmBlockNode;
    const finalSections: ViewBlock[] = [
      { kind: "table", head: [], rows: [["安全单元"]], node: safeTable },
      { kind: "table", head: [], rows: [["复杂单元"]], node: complexTable },
    ];
    const finalDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [safeTable, complexTable],
    } as PmDoc;

    const seed = buildNativePresentationSeedSections({ finalSections, finalDoc });
    const safeSeed = seed[0] as Extract<ViewBlock, { kind: "table" }>;
    const complexSeed = seed[1] as Extract<ViewBlock, { kind: "table" }>;

    expect(safeSeed.rows).toEqual([[""]]);
    expect(safeSeed.node).toBeUndefined();
    expect(complexSeed.rows).toEqual([["复杂单元"]]);
    expect(complexSeed.node).toEqual(complexTable);
  });

  it("带 marks、列宽和底色的表格从真实动画种子入口保留 node 与保真 HTML", () => {
    const formattedTable = {
      type: "table",
      attrs: { blockId: "formatted-table" },
      content: [{
        type: "tableRow",
        content: [{
          type: "tableCell",
          attrs: {
            colspan: 1,
            rowspan: 1,
            colwidth: [120],
            backgroundColor: "sky",
          },
          content: [{
            type: "paragraph",
            attrs: { blockId: "formatted-p", textAlign: null },
            content: [{
              type: "text",
              text: "格式保真",
              marks: [{ type: "bold" }],
            }],
          }],
        }],
      }],
    } as unknown as PmBlockNode;
    const finalSections: ViewBlock[] = [{
      kind: "table",
      head: [],
      rows: [["格式保真"]],
      node: formattedTable,
    }];
    const finalDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [formattedTable],
    } as PmDoc;

    const seed = buildNativePresentationSeedSections({ finalSections, finalDoc });
    const tableSeed = seed[0] as Extract<ViewBlock, { kind: "table" }>;
    const html = viewSectionsToHtml(seed);

    expect(tableSeed.node).toEqual(formattedTable);
    expect(html).toContain('colwidth="120"');
    expect(html).toContain('data-bg-color="sky"');
    expect(html).toContain("<strong>格式保真</strong>");
  });

  it("clones presentation runs without sharing section references", () => {
    const run: NativePresentationRun = {
      id: 1,
      docVersion: 2,
      sessionId: "s",
      mode: "whole",
      baselineSections: [],
      finalSections: [p("正文")],
    };

    const cloned = cloneNativePresentationRun(run);
    if (cloned.finalSections[0]?.kind === "p") {
      cloned.finalSections[0].spans[0] = { kind: "text", text: "修改" };
    }

    expect(sectionText(run.finalSections[0]!)).toBe("正文");
    expect(sectionText(cloned.finalSections[0]!)).toBe("修改");
  });

  it("cloneNativePresentationRun 保留 quote node 与容器内部 diff,避免动画路径降级", () => {
    const latex = String.raw`\sqrt{\sigma^{}}`;
    const quoteNode: PmBlockNode = {
      type: "blockquote",
      attrs: { blockId: "quote-native" },
      content: [{ type: "paragraph", attrs: { blockId: "quote-native-p" }, content: [{ type: "text", text: "引文" }] }],
    } as PmBlockNode;
    const calloutNode: PmBlockNode = {
      type: "callout",
      attrs: { blockId: "callout-native", emoji: "💡", tone: "info" },
      content: [{ type: "paragraph", attrs: { blockId: "callout-native-p" }, content: [{ type: "text", text: "公式 old" }] }],
    } as PmBlockNode;
    const run: NativePresentationRun = {
      id: 11,
      docVersion: 2,
      sessionId: "s",
      mode: "diff",
      baselineSections: [],
      finalSections: [
        { kind: "quote", text: "引文", node: quoteNode, spans: [{ kind: "text", text: "引文" }] },
        {
          kind: "callout",
          text: "公式 old",
          node: calloutNode,
          bodyDiff: [{
            status: "changed",
            kind: "list",
            node: {
              type: "bulletList",
              attrs: { blockId: "list-native" },
              content: [{
                type: "listItem",
                attrs: { blockId: "li-native" },
                content: [{ type: "paragraph", attrs: { blockId: "li-native-p" }, content: [] }],
              }],
            } as PmBlockNode,
            rowDiff: [{
              status: "changed",
              oldText: "公式 old",
              spans: [{ kind: "patchInsMath", latex, patchId: "native-math" }],
            }],
          }],
        },
      ],
    };

    const cloned = cloneNativePresentationRun(run);
    const clonedQuote = cloned.finalSections[0] as Extract<ViewBlock, { kind: "quote" }>;
    const clonedCallout = cloned.finalSections[1] as Extract<ViewBlock, { kind: "callout" }>;
    expect(clonedQuote.node).toEqual(quoteNode);
    expect(clonedQuote.node).not.toBe(quoteNode);
    const clonedEntry = clonedCallout.bodyDiff?.[0];
    expect(clonedEntry?.status).toBe("changed");
    expect(clonedEntry?.status === "changed" ? clonedEntry.kind : null).toBe("list");

    const row = clonedEntry?.status === "changed" && clonedEntry.kind === "list" ? clonedEntry.rowDiff[0] : null;
    const span = row?.status === "changed" ? row.spans[0] : null;
    if (span?.kind === "patchInsMath") span.latex = "changed";
    const originalCallout = run.finalSections[1] as Extract<ViewBlock, { kind: "callout" }>;
    const originalEntry = originalCallout.bodyDiff?.[0];
    const originalRow = originalEntry?.status === "changed" && originalEntry.kind === "list" ? originalEntry.rowDiff[0] : null;
    expect(originalRow?.status === "changed" ? originalRow.spans[0] : null).toEqual({ kind: "patchInsMath", latex, patchId: "native-math" });
  });

  it("creates concurrent whole-document tasks and advances them", () => {
    const run: NativePresentationRun = {
      id: 1,
      docVersion: 1,
      sessionId: "s",
      mode: "whole",
      baselineSections: [],
      finalSections: [{ kind: "h1", text: "标题" }, p("正文")],
    };
    const instructions = buildNativeDiffInstructions(run);
    const state = createNativeConcurrentState({
      run,
      instructions,
      agentCount: 2,
      stepDelayMs: 1,
      chunkSize: 2,
      maxDurationMs: 1000,
      startJitter: false,
    });

    expect(state.tasks.map((task) => task.phase)).toEqual(["skeleton", "content"]);
    const next = advanceNativeConcurrentState(state, 1);
    expect(next.steps.length).toBeGreaterThan(0);
  });

  it("表格按 cell 建一个 content task，且 operation 跟随时长预算放大 chunk", () => {
    const finalSections: ViewBlock[] = [{ kind: "table", head: ["AB"], rows: [["😀C", "D"]] }];
    const run: NativePresentationRun = {
      id: 9,
      docVersion: 1,
      sessionId: "s",
      mode: "whole",
      baselineSections: [],
      finalSections,
    };
    const instructions = buildNativeDiffInstructions(run);
    const state = createNativeConcurrentState({
      run,
      instructions,
      agentCount: 1,
      stepDelayMs: 18,
      chunkSize: 20,
      maxDurationMs: 1000,
      startJitter: false,
    });
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]?.operations).toHaveLength(3);
    expect(state.tasks[0]?.operations.map((operation) => operation.target)).toEqual([
      { kind: "tableCell", rowIndex: 0, cellIndex: 0, textBlockIndex: 0 },
      { kind: "tableCell", rowIndex: 1, cellIndex: 0, textBlockIndex: 0 },
      { kind: "tableCell", rowIndex: 1, cellIndex: 1, textBlockIndex: 0 },
    ]);
    const next = advanceNativeConcurrentState(state, 18);
    expect(next.steps[0]).toMatchObject({ kind: "insertText", text: "AB", chunkFrom: 0, chunkTo: 2 });
  });

  it("预算内的大表按放大 chunk 连续播放完全部字符，不在中途跳终态", () => {
    const text = "字".repeat(200);
    const finalSections: ViewBlock[] = [{ kind: "table", head: [], rows: [[text]] }];
    const run: NativePresentationRun = {
      id: 10,
      docVersion: 1,
      sessionId: "s",
      mode: "whole",
      baselineSections: [],
      finalSections,
    };
    const instructions = buildNativeDiffInstructions(run);
    const timing = planNativeTiming(instructions, 1_000);
    let state = createNativeConcurrentState({
      run,
      instructions,
      agentCount: 1,
      stepDelayMs: timing.stepDelayMs,
      chunkSize: timing.chunkSize,
      maxDurationMs: timing.maxDurationMs,
    });
    const emitted: string[] = [];
    let firstFrame = true;

    while (state.phase !== "done") {
      const advanced = advanceNativeConcurrentState(
        state,
        firstFrame ? 1 : state.stepDelayMs,
      );
      firstFrame = false;
      emitted.push(...advanced.steps.flatMap((step) =>
        step.kind === "insertText" ? [step.text] : []));
      state = advanced.state;
    }

    expect(timing.chunkSize).toBeGreaterThan(1);
    expect(emitted.some((chunk) => Array.from(chunk).length > 1)).toBe(true);
    expect(emitted.join("")).toBe(text);
  });

  it("30fps 双 tick 积压会被消费，完整表格文本先发出再进入终态", () => {
    const text = "字".repeat(200);
    const finalSections: ViewBlock[] = [{ kind: "table", head: [], rows: [[text]] }];
    const run: NativePresentationRun = {
      id: 12,
      docVersion: 1,
      sessionId: "s",
      mode: "whole",
      baselineSections: [],
      finalSections,
    };
    const instructions = buildNativeDiffInstructions(run);
    const timing = planNativeTiming(instructions, 1_000);
    let state = createNativeConcurrentState({
      run,
      instructions,
      agentCount: 1,
      stepDelayMs: timing.stepDelayMs,
      chunkSize: timing.chunkSize,
      maxDurationMs: timing.maxDurationMs,
      startJitter: false,
    });
    const chunks: string[] = [];

    while (state.phase !== "done") {
      const advanced = advanceNativeConcurrentState(
        state,
        state.stepDelayMs * 2,
      );
      chunks.push(...advanced.steps.flatMap((step) =>
        step.kind === "insertText" ? [step.text] : []));
      state = advanced.state;
    }

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("到达 deadline 时通过 step 发出剩余表格内容，不以零步骤跳终态", () => {
    const text = "截止时仍须完整发出".repeat(30);
    const finalSections: ViewBlock[] = [{ kind: "table", head: [], rows: [[text]] }];
    const run: NativePresentationRun = {
      id: 13,
      docVersion: 1,
      sessionId: "s",
      mode: "whole",
      baselineSections: [],
      finalSections,
    };
    const instructions = buildNativeDiffInstructions(run);
    const state = createNativeConcurrentState({
      run,
      instructions,
      agentCount: 1,
      stepDelayMs: 48,
      chunkSize: 1,
      maxDurationMs: 1_000,
      startJitter: false,
    });

    const advanced = advanceNativeConcurrentState(state, 1_000);
    const emitted = advanced.steps.flatMap((step) =>
      step.kind === "insertText" ? [step.text] : []).join("");

    expect(advanced.state.phase).toBe("done");
    expect(advanced.steps.length).toBeGreaterThan(0);
    expect(emitted).toBe(text);
  });

  it("短 cell 也会在同一拍复用剩余 chunk，阈值内多格表不超时跳终态", () => {
    const cellText = "字".repeat(12);
    const rows = Array.from({ length: 120 }, () => [cellText]);
    const finalSections: ViewBlock[] = [{ kind: "table", head: [], rows }];
    const run: NativePresentationRun = {
      id: 11,
      docVersion: 1,
      sessionId: "s",
      mode: "whole",
      baselineSections: [],
      finalSections,
    };
    const instructions = buildNativeDiffInstructions(run);
    const timing = planNativeTiming(instructions, 1_000);
    let state = createNativeConcurrentState({
      run,
      instructions,
      agentCount: 1,
      stepDelayMs: timing.stepDelayMs,
      chunkSize: timing.chunkSize,
      maxDurationMs: timing.maxDurationMs,
    });
    let firstFrame = true;
    let emitted = "";
    let batchedAcrossCells = false;

    while (state.phase !== "done") {
      const advanced = advanceNativeConcurrentState(
        state,
        firstFrame ? 1 : state.stepDelayMs,
      );
      firstFrame = false;
      const inserts = advanced.steps.filter((step) => step.kind === "insertText");
      emitted += inserts.map((step) => step.text).join("");
      batchedAcrossCells ||= inserts.length > 1;
      state = advanced.state;
    }

    expect(timing.chunkSize).toBeGreaterThan(cellText.length);
    expect(batchedAcrossCells).toBe(true);
    expect(emitted).toBe(cellText.repeat(rows.length));
  });

  it("表格时长只累计 cell grapheme，不把 tab/newline 当字符", () => {
    const instructions = buildNativeDiffInstructions({
      finalSections: [{ kind: "table", head: ["A", "B"], rows: [["😀", " "]] }],
    });
    const timing = planNativeTiming(instructions, 60_000);
    expect(timing.totalDurationMs).toBe(timing.stepDelayMs * 4);
  });

  it("fallback 大表不参与 timing，也不放大同文普通段落 chunk", () => {
    const paragraphInstructions = buildNativeDiffInstructions({ finalSections: [p("普通段落")] });
    const mixedInstructions = buildNativeDiffInstructions({
      finalSections: [
        { kind: "table", head: [], rows: [["字".repeat(1501)]] },
        p("普通段落"),
      ],
    });
    expect(planNativeTiming(mixedInstructions, 1_000)).toEqual(
      planNativeTiming(paragraphInstructions, 1_000),
    );
  });

  it("保持拟人光标主题色单一色源，防止旧色数组复活", () => {
    const run: NativePresentationRun = {
      id: 2,
      docVersion: 1,
      sessionId: "s",
      mode: "whole",
      baselineSections: [],
      finalSections: [
        p("甲一"),
        p("乙二"),
        p("丙三"),
        p("丁四"),
        p("戊五"),
        p("己六"),
      ],
    };
    const instructions = buildNativeDiffInstructions(run);
    const oldAgentColors = [
      "#3b82f6",
      "#10b981",
      "#8b5cf6",
      "#f97316",
      "#ec4899",
      "#0ea5e9",
    ];

    const state = createNativeConcurrentState({
      run,
      instructions,
      agentCount: 6,
      stepDelayMs: 1,
      chunkSize: 2,
      maxDurationMs: 1000,
      startJitter: false,
    });

    // 拟人光标主题色单一色源回归:Agent·N 必须跟 lane N 同色,不能回落到旧蓝紫数组。
    state.agents.forEach((agent, index) => {
      expect(agent.color).toBe(laneColor(index + 1));
      expect(oldAgentColors).not.toContain(agent.color);
    });

    let next = advanceNativeConcurrentState(state, 1);
    for (let i = 0; i < 3 && next.steps.length === 0; i += 1) {
      next = advanceNativeConcurrentState(next.state, 1);
    }

    expect(next.steps.length).toBeGreaterThan(0);
    next.steps.forEach((step) => {
      const lane = Number(step.agentId.replace("agent-", ""));
      expect(step.color).toBe(laneColor(lane));
      expect(oldAgentColors).not.toContain(step.color);
    });
  });

  it("同一 insert operation 跨多帧 advance 只切一次 grapheme", () => {
    const run: NativePresentationRun = {
      id: 3,
      docVersion: 1,
      sessionId: "s",
      mode: "whole",
      baselineSections: [],
      finalSections: [p("A😀BC")],
    };
    const instructions = buildNativeDiffInstructions(run);
    let state = createNativeConcurrentState({
      run,
      instructions,
      agentCount: 1,
      stepDelayMs: 1,
      chunkSize: 1,
      maxDurationMs: 1000,
      startJitter: false,
    });
    const splitSpy = vi.spyOn(presentationSpans, "splitGraphemes");

    try {
      for (let i = 0; i < 3; i += 1) {
        const advanced = advanceNativeConcurrentState(state, state.stepDelayMs);
        expect(advanced.steps).toHaveLength(1);
        expect(advanced.steps[0]?.kind).toBe("insertText");
        state = advanced.state;
      }

      expect(splitSpy).toHaveBeenCalledTimes(1);
    } finally {
      splitSpy.mockRestore();
    }
  });
});

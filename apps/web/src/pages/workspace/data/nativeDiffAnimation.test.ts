import { describe, expect, it, vi } from "vitest";
import { legacySectionsToPm, type PmBlockNode, type PmDoc } from "@qingagent/pm-schema";
import {
  advanceNativeConcurrentState,
  buildNativeDiffInstructions,
  buildNativePresentationSeedSections,
  cloneNativePresentationRun,
  createNativeConcurrentState,
  type NativePresentationRun,
} from "./nativeDiffAnimation";
import { laneColor } from "./humanCursorLanes";
import * as presentationSpans from "./presentationSpans";
import { sectionText } from "./presentationSpans";
import type { ViewBlock } from "./protocol";

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
      "A\nB",
    ]);
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

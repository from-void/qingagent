import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  aiBlockToQingml,
  compileAiDocumentToPm,
  countDocVisibleChars,
  pmToLegacySections,
  pmToPlainText,
  safeParsePmDoc,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
  type PmMark,
  type PmParagraphNode,
} from "@qingagent/pm-schema";
import {
  createSession,
  createSessionScopedTools,
} from "../bridge/index.js";

const streamTextMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, streamText: (...args: unknown[]) => streamTextMock(...args) };
});

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => () => ({ modelId: "mock-rich-format-tools" }),
}));

// writeDraft 现走AI SDK 流式适配层 streamInnerModel(非 streamText),按其形态 mock
const streamInnerModelMock = vi.hoisted(() => vi.fn());
vi.mock("../llm/innerModelStream.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, streamInnerModel: (...args: unknown[]) => streamInnerModelMock(...args) };
});

const ctx = {} as any;

function qingmlBlock(block: unknown): string {
  return aiBlockToQingml(block as never);
}

function text(value: string, marks?: PmMark[]): PmInlineNode {
  return marks && marks.length > 0
    ? { type: "text", text: value, marks }
    : { type: "text", text: value };
}

function inlineMath(latex: string): PmInlineNode {
  return { type: "inlineMath", attrs: { latex } };
}

function paragraph(blockId: string, content: string | PmInlineNode[]): PmParagraphNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: typeof content === "string" ? [text(content)] : content,
  };
}

function taskList(
  blockId: string,
  items: Array<{ checked: boolean; content: string | PmInlineNode[] }>,
): PmBlockNode {
  return {
    type: "taskList",
    attrs: { blockId },
    content: items.map((item, index) => ({
      type: "taskItem",
      attrs: { blockId: `${blockId}-item-${index + 1}`, checked: item.checked },
      content: [paragraph(`${blockId}-item-${index + 1}-p`, item.content)],
    })),
  };
}

function callout(
  blockId: string,
  paragraphs: Array<string | PmInlineNode[]>,
  attrs: { emoji?: string | null; tone?: "info" | "success" | "warning" | "danger" | "neutral" | null } = {},
): PmBlockNode {
  return {
    type: "callout",
    attrs: { blockId, emoji: attrs.emoji ?? "!", tone: attrs.tone ?? "info" },
    content: paragraphs.map((content, index) => paragraph(`${blockId}-p-${index + 1}`, content)),
  };
}

function blockMath(blockId: string, latex: string): PmBlockNode {
  return { type: "blockMath", attrs: { blockId, latex } };
}

function doc(content: PmBlockNode[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function bindDoc(state: ReturnType<typeof createSession>, value: PmDoc): void {
  state.doc = value;
  state.legacySections = pmToLegacySections(value) as any;
  state.docVersion = 1;
}

function compileDoc(blocks: readonly unknown[]): PmDoc {
  const result = compileAiDocumentToPm({ blocks });
  expect(result.ok).toBe(true);
  return result.doc!;
}

function assertSafeDoc(value: PmDoc | null | undefined, label: string): void {
  expect(value, `${label} should exist`).toBeTruthy();
  const parsed = safeParsePmDoc(value);
  expect(parsed.success ? "ok" : parsed.error.message).toBe("ok");
}

function mockWriteDraftQingml(raw: string): void {
  streamInnerModelMock.mockImplementation(async () => ({
    raw,
    contentStartMs: 0,
  }));
}

function acceptCandidateAsCanonical(state: ReturnType<typeof createSession>): void {
  assertSafeDoc(state.docDraftCandidateDoc, "candidate before accept");
  state.doc = state.docDraftCandidateDoc!;
  state.legacySections = pmToLegacySections(state.doc) as any;
  state.docVersion += 1;
  state.docDraftBaseSections = null;
  state.docDraftBaseVersion = null;
  state.docDraftBaseDoc = null;
  state.docDraftCandidateSections = null;
  state.docDraftCandidateDoc = null;
}

describe("draft rich formats session-scoped tools", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    streamInnerModelMock.mockReset();
    delete process.env.QINGAGENT_RACE_LANES;
    delete process.env.QINGAGENT_RACE_ROUNDS;
  });

  it("readDraft 返回 taskList/callout/blockMath 的 QingML 片段与 editability,并能用占位符语义定位 inlineMath 周边文本", async () => {
    const state = createSession("rich-tools-read");
    bindDoc(state, doc([
      taskList("block-tasks", [
        { checked: false, content: "复核数据" },
        { checked: true, content: "确认口径" },
      ]),
      callout("block-callout", ["第一段提示", "第二段提示"], { tone: "warning" }),
      blockMath("block-math", "\\sum_{i=1}^{n} i"),
      paragraph("block-inline", [
        text("行内公式前 "),
        inlineMath("\\alpha+\\beta"),
        text(" 行内公式后"),
      ]),
    ]));
    const { readDraftAiIr } = createSessionScopedTools(state);

    const full = await readDraftAiIr.execute!({ mode: "full", includeText: true }, ctx) as any;

    expect(full.ok).toBe(true);
    const byRef = new Map(full.blocks.map((block: any) => [block.ref, block]));
    expect(byRef.get("block-tasks")).toMatchObject({
      type: "taskList",
      qingml: "<tasks><task>复核数据</task><task checked>确认口径</task></tasks>",
      editability: { replaceBlockAllowed: true, lossyReasons: [] },
    });
    expect(byRef.get("block-callout")).toMatchObject({
      type: "callout",
      qingml: "<callout emoji=\"!\" tone=\"warning\">第一段提示<br/>第二段提示</callout>",
      editability: { replaceBlockAllowed: false, lossyReasons: ["multiBlockBlockquote"] },
    });
    expect(byRef.get("block-math")).toMatchObject({
      type: "blockMath",
      qingml: "<math-block>\\sum_{i=1}^{n} i</math-block>",
      editability: { replaceBlockAllowed: true, lossyReasons: [] },
      text: "\\sum_{i=1}^{n} i",
    });

    const query = await readDraftAiIr.execute!({
      query: "行内公式前 . 行内公式后",
      isRegex: true,
    }, ctx) as any;
    expect(query.ok).toBe(true);
    expect(query.blocks.map((block: any) => block.ref)).toEqual(["block-inline"]);
    expect(query.blocks[0]).toMatchObject({
      text: "行内公式前 \\alpha+\\beta 行内公式后",
      qingml: "<p>行内公式前 <math>\\alpha+\\beta</math> 行内公式后</p>",
    });
  });

  it("editDraft replaceBlock 使用 readDraft qingml 片段改写", async () => {
    const state = createSession("rich-tools-envelope-contract");
    bindDoc(state, doc([paragraph("block-a", "原文")]));
    const { editDraft, readDraftAiIr } = createSessionScopedTools(state);
    const draft = await readDraftAiIr.execute!({ mode: "full", includeText: true }, ctx) as any;
    expect(draft.blocks[0].qingml).toBe("<p>原文</p>");

    const result = await editDraft.execute!({
      ops: [{ action: "replaceBlock", ref: "block-a", block: "<p>新文</p>" }],
    }, ctx) as any;

    expect(result.ok).toBe(true);
    expect(state.docDraftCandidateDoc?.content[0]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: "新文" }],
    });
  });

  it("editDraft replaceBlock 对 taskList/callout/blockMath 坏 QingML 给出字段或 bad-block 错误", async () => {
    const cases: Array<{ name: string; block: string; field: string }> = [
      { name: "taskList", block: "<tasks></tasks>", field: "items" },
      { name: "callout", block: "<callout><p>块级越界</p></callout>", field: "QingML bad-block" },
      { name: "blockMath", block: "<math-block></math-block>", field: "latex" },
    ];

    for (const item of cases) {
      const state = createSession(`rich-tools-missing-${item.name}`);
      bindDoc(state, doc([paragraph("block-a", "锚点")]));
      const { editDraft } = createSessionScopedTools(state);

      const result = await editDraft.execute!({
        ops: [{ action: "replaceBlock", ref: "block-a", block: item.block }],
      }, ctx) as any;

      expect(result.ok).toBe(false);
      expect(result.failedOpIndex).toBe(0);
      expect(result.error).toContain(item.field);
      assertSafeDoc(state.docDraftCandidateDoc ?? state.doc, `${item.name} failed candidate`);
    }
  });

  it("editDraft markText 拒绝 math mark,普通 bold 标记含 inlineMath 段落时公式无损", async () => {
    const state = createSession("rich-tools-mark-inline-math");
    bindDoc(state, doc([
      paragraph("block-formula", [
        text("核心指标 "),
        inlineMath("F=ma"),
        text(" 需要强调"),
      ]),
    ]));
    const { editDraft } = createSessionScopedTools(state);

    await expect(editDraft.execute!({
      ops: [{ action: "markText", find: "核心指标", mark: { type: "math" }, op: "add" }],
    }, ctx)).rejects.toThrow("math mark 不能与文本样式混用");
    assertSafeDoc(state.docDraftCandidateDoc ?? state.doc, "candidate after rejected math mark");

    const result = await editDraft.execute!({
      ops: [{ action: "markText", find: "需要强调", mark: { type: "bold" }, op: "add" }],
    }, ctx) as any;

    expect(result.ok).toBe(true);
    assertSafeDoc(state.docDraftCandidateDoc, "candidate after bold mark");
    expect(state.docDraftCandidateDoc!.content[0]).toMatchObject({
      type: "paragraph",
      content: [
        { type: "text", text: "核心指标 " },
        { type: "inlineMath", attrs: { latex: "F=ma" } },
        { type: "text", text: " " },
        { type: "text", text: "需要强调", marks: [{ type: "bold" }] },
      ],
    });
    expect(pmToPlainText(state.docDraftCandidateDoc!)).toBe("核心指标 F=ma 需要强调");
  });

  it("editDraft replaceText 用 isRegex/all 在多个富格式顶层块中批量命中,readDiff 返回累计 hunk 映射和统计", async () => {
    const state = createSession("rich-tools-regex-all");
    bindDoc(state, doc([
      paragraph("block-intro", [
        text("阶段A: 待校验；公式 "),
        inlineMath("x^2"),
        text(" 保留"),
      ]),
      taskList("block-tasks", [
        { checked: false, content: "阶段B: 待校验" },
        { checked: true, content: "旁支任务" },
      ]),
      callout("block-callout", ["阶段C: 待校验"], { tone: "info" }),
      blockMath("block-math", "x^2+y^2=z^2"),
    ]));
    const { editDraft, readDiff } = createSessionScopedTools(state);

    const edit = await editDraft.execute!({
      ops: [{
        action: "replaceText",
        find: "阶段([A-C]): 待校验",
        replace: "阶段$1: 已完成校验",
        isRegex: true,
        all: true,
      }],
    }, ctx) as any;

    expect(edit).toMatchObject({
      ok: true,
      applied: ["block-intro", "block-tasks", "block-callout"],
    });
    assertSafeDoc(state.docDraftCandidateDoc, "candidate after regex replace");
    expect(pmToPlainText(state.docDraftCandidateDoc!)).toContain("阶段A: 已完成校验");
    expect(pmToPlainText(state.docDraftCandidateDoc!)).toContain("阶段B: 已完成校验");
    expect(pmToPlainText(state.docDraftCandidateDoc!)).toContain("阶段C: 已完成校验");
    expect(pmToPlainText(state.docDraftCandidateDoc!)).toContain("x^2+y^2=z^2");

    const diff = await readDiff.execute!({}, ctx) as any;

    expect(diff.ok).toBe(true);
    expect(diff.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "replace",
        ref: "block-intro",
        before: "待",
        after: "已完成",
      }),
      expect.objectContaining({
        kind: "replace",
        ref: "block-tasks",
        before: expect.stringContaining("阶段B: 待校验"),
        after: expect.stringContaining("阶段B: 已完成校验"),
      }),
      expect.objectContaining({
        kind: "replace",
        ref: "block-callout",
        before: "阶段C: 待校验",
        after: "阶段C: 已完成校验",
      }),
    ]));
    expect(diff.changes).toHaveLength(3);
    expect(diff.stats).toMatchObject({
      blocksChanged: 3,
      marksChanged: 0,
      wordsRemoved: 0,
    });
    expect(diff.stats.wordsAdded).toBeGreaterThan(0);
    // totalWords 用文档可见字符口径(countDocVisibleChars:去空白/跳过媒体),与右下角落款同尺
    expect(diff.stats.totalWords).toBe(countDocVisibleChars(state.docDraftCandidateDoc!));
  });

  it("writeDraft 风格产出富文档后,两轮 editDraft/readDiff 闭环每步都保持 PM doc 合法", async () => {
    mockWriteDraftQingml([
      `<h2>实验记录</h2>`,
      `<p>核心指标 <math>F=ma</math> 需要复核</p>`,
      `<tasks><task>校验风险阈值</task><task checked="true">同步记录</task></tasks>`,
      `<callout tone="warning" emoji="!">风险阈值暂按旧版</callout>`,
      `<math-block>\\int_0^1 x dx</math-block>`,
    ].join(""));
    const state = createSession("rich-tools-full-loop");
    const tools = createSessionScopedTools(state);

    const written = await tools.writeDraft!.execute!({
      title: "富格式工具链",
      outline: "生成包含任务、提示、块公式和行内公式的测试文档",
      // 新版 Mastra 的 tool.execute 首参为解析后(output)形态,带 .default() 的 intent
      // 解析后必 present,需显式给出。
      intent: "express",
    }, ctx) as any;

    expect(written.ok).toBe(true);
    assertSafeDoc(state.docDraftCandidateDoc, "candidate after writeDraft");
    acceptCandidateAsCanonical(state);
    assertSafeDoc(state.doc, "canonical after accepting writeDraft output");

    const beforeEdit = await tools.readDraftAiIr.execute!({ mode: "full", includeText: true }, ctx) as any;
    const mathRef = beforeEdit.blocks.find((block: any) => block.type === "blockMath").ref;
    const taskRef = beforeEdit.blocks.find((block: any) => block.type === "taskList").ref;

    const firstEdit = await tools.editDraft.execute!({
      ops: [
        { action: "markText", find: "核心指标", mark: { type: "bold" }, op: "add" },
        { action: "replaceText", find: "风险阈值", replace: "安全阈值", all: true },
        {
          action: "insertBlock",
          position: "after",
          ref: mathRef,
          blocks: "<callout tone=\"success\" emoji=\"OK\">一轮校对完成</callout>",
        },
      ],
    }, ctx) as any;

    expect(firstEdit.ok).toBe(true);
    assertSafeDoc(state.docDraftCandidateDoc, "candidate after first edit");
    const diff1 = await tools.readDiff.execute!({}, ctx) as any;
    expect(diff1.ok).toBe(true);
    expect(diff1.changes.map((change: any) => change.kind)).toEqual(expect.arrayContaining([
      "markChange",
      "replace",
      "insert",
    ]));
    expect(diff1.stats.marksChanged).toBeGreaterThan(0);
    expect(diff1.stats.blocksChanged).toBeGreaterThanOrEqual(3);

    const secondEdit = await tools.editDraft.execute!({
      ops: [
        {
          action: "replaceBlock",
          ref: taskRef,
          block: qingmlBlock({
            type: "taskList",
            items: [
              { checked: true, runs: [{ text: "校验安全阈值" }] },
              { checked: true, runs: [{ text: "同步记录" }] },
              { checked: false, runs: [{ text: "发布结论" }] },
            ],
          }),
        },
        { action: "replaceText", find: "需要复核", replace: "已经复核" },
      ],
    }, ctx) as any;

    expect(secondEdit.ok).toBe(true);
    assertSafeDoc(state.docDraftCandidateDoc, "candidate after second edit");
    const diff2 = await tools.readDiff.execute!({}, ctx) as any;
    expect(diff2.ok).toBe(true);
    expect(diff2.stats.blocksChanged).toBeGreaterThanOrEqual(diff1.stats.blocksChanged);
    expect(diff2.stats.totalWords).toBe(countDocVisibleChars(state.docDraftCandidateDoc!));
    expect(pmToPlainText(state.docDraftCandidateDoc!)).toContain("核心指标 F=ma 已经复核");
    expect(diff2.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: taskRef, after: expect.stringContaining("发布结论") }),
      expect.objectContaining({ before: "需要", after: "已经" }),
    ]));

    const afterSecond = await tools.readDraftAiIr.execute!({ query: "F=ma" }, ctx) as any;
    expect(afterSecond.blocks[0].qingml).toContain("<math>F=ma</math>");
  });
});

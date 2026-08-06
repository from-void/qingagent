import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import {
  beginTurnOwnership,
  bindTurnOwnershipToRequestContext,
} from "../session/turnOwnership.js";
import {
  pmDocHasNestedList,
  pmToLegacySections,
  pmToPlainText,
  type PmDoc,
} from "@qingagent/pm-schema";
import {
  activateDiagramVizSkill,
  inferDiagramVizLanguages,
} from "../skills/diagramViz.js";

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    getMemory: () => null,
  },
  getObservability: () => null,
}));

const streamInnerModelMock = vi.fn();
vi.mock("../llm/innerModelStream.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    streamInnerModel: (...args: unknown[]) => streamInnerModelMock(...args),
  };
});

describe("diagram-viz 写作意图识别", () => {
  it.each([
    ["画一张流程图", ["mermaid"]],
    ["生成 ER 图", ["mermaid"]],
    ["用 mermaid 画时序图", ["mermaid"]],
    ["请画系统架构图", ["drawio"]],
    ["请画系统架构", ["drawio"]],
    ["请画流程", ["mermaid"]],
    ["把服务时序可视化", ["mermaid"]],
    ["绘制云原生架构设计图", ["drawio"]],
    ["请画系统架构，标出核心依赖", ["drawio"]],
    ["请绘制登录时序示意", ["mermaid"]],
    ["请画审批流程优化。", ["mermaid"]],
    ["绘制服务拓扑结构图；补充故障域", ["drawio"]],
    ["请画退款状态机视图。", ["mermaid"]],
  ])("%s 会激活对应图表语言", (text, expected) => {
    expect(inferDiagramVizLanguages(text)).toEqual(expected);
  });

  it.each([
    "帮我写一篇公司审批流程优化方案的文章",
    "请画一个审批流程优化方案的封面",
    "绘制时序小说的封面插画",
    "可视化架构师成长路径的海报",
    "write a user onboarding guide",
    "a quarterly report for the leadership team",
    "写一篇关于登录状态管理的技术博客",
    "帮我优化审批流程",
    "状态管理最佳实践",
    "请画系统架构师。",
    "请画审批流程封面。",
    "请画系统架构师画像",
    "绘制状态机学习手册的封面",
    "请画审批流程优化版。",
    "请画服务拓扑结构图册封面。",
  ])("%s 不会误激活图表技能", (text) => {
    expect(inferDiagramVizLanguages(text)).toEqual([]);
  });
});

interface InnerModelCall {
  messages?: unknown[];
  requestContext?: RequestContext;
  callSite: string;
  lane?: number;
  tier?: "flash" | "pro";
  thinking: boolean;
  temperature: number;
  abortSignal?: AbortSignal;
  onContentStart?: () => void;
  onContentDelta?: (delta: string, raw: string) => void;
  branchSteeringTail?: string;
}

function qingmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function qingmlParagraph(text: string): string {
  return `<p>${qingmlText(text)}</p>`;
}

function twoLevelListQingml(): string {
  return [
    "<ul>",
    "<li>打开项目<ul><li>安装依赖</li><li>启动服务</li></ul></li>",
    "<li>运行测试</li>",
    "</ul>",
  ].join("");
}

function threeLevelListQingml(): string {
  return [
    "<ul>",
    "<li>选题阶段<ul><li>明确问题<ul><li>确认对象</li></ul></li></ul></li>",
    "<li>写作阶段<ul><li>搭建结构<ul><li>补充案例</li></ul></li></ul></li>",
    "</ul>",
  ].join("");
}

function structurallyValidThreeLevelQingml(): string {
  return "<ul><li>达标一级<ul><li>达标二级<ul><li>达标三级</li></ul></li></ul></li></ul>";
}

function namedThreeLevelQingml(prefix: string): string {
  return `<ul><li>${prefix}一级<ul><li>${prefix}二级<ul><li>${prefix}三级</li></ul></li></ul></li></ul>`;
}

function bindDoc(state: { doc?: PmDoc | null; legacySections: unknown; docVersion: number }, value: PmDoc): void {
  state.doc = value;
  state.legacySections = pmToLegacySections(value);
  state.docVersion = 1;
}

function pmFlatOrderedList(texts: readonly string[]): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "orderedList",
      attrs: { blockId: "block-list", start: 1 },
      content: texts.map((text, index) => ({
        type: "listItem",
        attrs: { blockId: `block-list-item-${index + 1}` },
        content: [{
          type: "paragraph",
          attrs: { blockId: `block-list-item-${index + 1}-p` },
          content: [{ type: "text", text }],
        }],
      })),
    }],
  };
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForCalls(calls: unknown[], expected: number) {
  for (let i = 0; i < 20 && calls.length < expected; i += 1) {
    await flushPromises();
  }
}

async function makeTool() {
  const { createWriteDraftTool } = await import("../tools/writeDraft.js");
  const { createSession } = await import("../bridge/index.js");
  const state = createSession("wd-intent");
  const tool = createWriteDraftTool({
    state,
    replaceDraftCandidateDoc: (s, doc, legacySections) => {
      s.docDraftCandidateDoc = doc;
      return legacySections ?? [];
    },
  });
  return { tool, state };
}

type ExecuteResult = {
  ok: boolean;
  wordCount?: number;
  targetLength?: number;
  revisionCount?: number;
  lengthStatus?: string;
  nestedListReachedDepth?: boolean;
  structuralFailures?: string[];
};

async function run(tool: unknown, input: Record<string, unknown>, ctx?: Record<string, unknown>): Promise<ExecuteResult> {
  const t = tool as { execute: (input: never, ctx?: never) => Promise<unknown> };
  return (await t.execute(input as never, ctx as never)) as ExecuteResult;
}

describe("writeDraft intent 调度", () => {
  beforeEach(() => {
    streamInnerModelMock.mockReset();
    delete process.env.QINGAGENT_RACE_LANES;
    delete process.env.QINGAGENT_RACE_ROUNDS;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("忘调 diagram-viz 且无画图意图时不注入，默认 express 仍固定 4 路并携带 V4 messages", async () => {
    const { tool } = await makeTool();
    streamInnerModelMock.mockResolvedValueOnce({ raw: qingmlParagraph("默认 express"), contentStartMs: 0 });
    const parent = new AbortController();

    const out = await run(tool, { title: "t", outline: "o" }, { abortSignal: parent.signal });

    expect(out.ok).toBe(true);
    expect(out.lengthStatus).toBe("not_requested");
    expect(out.revisionCount).toBeUndefined();
    expect(streamInnerModelMock).toHaveBeenCalledTimes(4);
    const firstCall = streamInnerModelMock.mock.calls[0]![0] as InnerModelCall;
    expect(firstCall).toMatchObject({
      thinking: false,
      temperature: 0.4,
      callSite: "writeDraft",
      lane: 0,
    });
    expect(firstCall.abortSignal).toBeInstanceOf(AbortSignal);
    expect(firstCall.messages?.length).toBeGreaterThanOrEqual(2);
    expect(firstCall.messages?.[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("输出 QingML"),
    });
    expect(String((firstCall.messages?.[0] as { content?: unknown } | undefined)?.content)).toContain(
      "writeDraft QingML 生成总规",
    );
    expect(String((firstCall.messages?.at(-1) as { content?: unknown } | undefined)?.content)).toContain(
      "首字符必须是 <",
    );
    expect(String((firstCall.messages?.at(-1) as { content?: unknown } | undefined)?.content)).toContain("标题: t");
    expect(String((firstCall.messages?.at(-1) as { content?: unknown } | undefined)?.content)).toContain(
      "原文每个空行必须在原位输出为空 <p></p>",
    );
    expect(firstCall.branchSteeringTail).toContain("不要调用任何工具");
    expect(firstCall.branchSteeringTail).toContain("标题: t");
    expect(firstCall.branchSteeringTail).not.toContain("允许的块级标签与基础形状");
    expect(JSON.stringify(firstCall.messages)).not.toContain("<diagram_viz_instruction");
    expect(firstCall.branchSteeringTail).not.toContain("<diagram_viz_instruction");
  });

  it("忘调 diagram-viz 但 writeDraft 参数含画图意图时静默激活并注入对应规范", async () => {
    const { tool } = await makeTool();
    streamInnerModelMock.mockResolvedValue({
      raw: qingmlParagraph("含系统架构图的正文"),
      contentStartMs: 0,
      finishReason: "stop",
    });
    const requestContext = new RequestContext([
      ["userText", "写一份技术方案"],
      ["messages", [{ role: "user", content: "写一份技术方案" }]],
    ]);

    const out = await run(
      tool,
      { title: "系统架构图方案", outline: "说明组件和部署关系" },
      { requestContext },
    );

    expect(out.ok).toBe(true);
    const firstCall = streamInnerModelMock.mock.calls[0]![0] as InnerModelCall;
    const innerTail = String(
      (firstCall.messages?.at(-1) as { content?: unknown } | undefined)?.content,
    );
    expect(innerTail).toContain(
      '<diagram_viz_instruction purpose="write" languages="drawio"',
    );
    expect(innerTail).toContain("工程图必须写成 `<drawio>");
    expect(innerTail).not.toContain("Mermaid 语法只认半角");
  });

  it("激活 diagram-viz 后把 Mermaid 规范桥接到内层 messages 与旁支尾部，未携带 draw.io 段", async () => {
    const { tool } = await makeTool();
    streamInnerModelMock.mockResolvedValue({
      raw: qingmlParagraph("含 Mermaid 流程图的正文"),
      contentStartMs: 0,
      finishReason: "stop",
    });
    const requestContext = new RequestContext([
      ["userText", "写一份带 Mermaid 流程图的发布说明"],
      ["messages", [{ role: "user", content: "请画 Mermaid 流程图" }]],
    ]);
    activateDiagramVizSkill(
      requestContext as unknown as RequestContext,
      "Mermaid 流程图",
    );

    const out = await run(
      tool,
      { title: "发布说明", outline: "用 Mermaid 展示发布流程" },
      { requestContext },
    );

    expect(out.ok).toBe(true);
    const firstCall = streamInnerModelMock.mock.calls[0]![0] as InnerModelCall;
    const innerMessages = JSON.stringify(firstCall.messages);
    const innerSystem = String(
      (firstCall.messages?.[0] as { content?: unknown } | undefined)?.content,
    );
    const innerTail = String(
      (firstCall.messages?.at(-1) as { content?: unknown } | undefined)?.content,
    );
    expect(innerSystem).not.toContain("<diagram_viz_instruction");
    expect(innerSystem).not.toContain("Mermaid 语法只认半角");
    expect(innerTail).toContain("<diagram_viz_instruction");
    expect(innerTail).toContain("Mermaid 语法只认半角");
    expect(innerMessages).toContain('<diagram_viz_instruction purpose=\\"write\\" languages=\\"mermaid\\"');
    expect(innerMessages).toContain("Mermaid 语法只认半角");
    expect(innerMessages).not.toContain("未压缩明文 mxGraph XML");
    expect(firstCall.branchSteeringTail).toContain(
      '<diagram_viz_instruction purpose="write" languages="mermaid"',
    );
    expect(firstCall.branchSteeringTail).toContain("Mermaid 语法只认半角");
    expect(firstCall.branchSteeringTail).not.toContain("未压缩明文 mxGraph XML");
    expect(innerTail.match(/<diagram_viz_instruction\b/g)).toHaveLength(1);
  });

  it("Anthropic 协议也保留 V4 messages 上下文", async () => {
    const { tool } = await makeTool();
    streamInnerModelMock.mockResolvedValue({ raw: qingmlParagraph("anthropic 上下文"), contentStartMs: 0, finishReason: "stop" });
    const requestContext = new RequestContext([
      ["modelOverrides", { protocol: "anthropic" }],
      ["messages", [
        { role: "system", content: "母对话 agent system 不应成为 draft system" },
        { role: "user", content: "历史用户细节: 枣树" },
        { role: "assistant", content: "历史助手确认" },
      ]],
    ]);

    const out = await run(tool, { title: "t", outline: "o" }, { requestContext });

    expect(out.ok).toBe(true);
    const firstCall = streamInnerModelMock.mock.calls[0]![0] as InnerModelCall;
    expect(firstCall.requestContext).toBe(requestContext);
    expect(firstCall.messages).toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("输出 QingML"),
      }),
      { role: "user", content: "历史用户细节: 枣树" },
      { role: "assistant", content: "历史助手确认" },
      expect.objectContaining({ role: "user" }),
    ]);
    expect(JSON.stringify(firstCall.messages)).not.toContain("母对话 agent system 不应成为 draft system");
  });

  it("自定义 OpenAI 兼容端点默认不带 response_format,避免不支持该参数的端点 400", async () => {
    const { tool } = await makeTool();
    streamInnerModelMock.mockResolvedValue({ raw: qingmlParagraph("兼容端点"), contentStartMs: 0, finishReason: "stop" });
    const requestContext = new RequestContext([
      ["modelOverrides", { baseUrl: "https://compat.example.com/v1", modelIds: { flash: "compat-chat" } }],
    ]);

    const out = await run(tool, { title: "t", outline: "o" }, { requestContext });

    expect(out.ok).toBe(true);
    const firstCall = streamInnerModelMock.mock.calls[0]![0] as InnerModelCall;
    expect(firstCall.requestContext).toBe(requestContext);
  });

  it("pro 档 reason 使用 pro 模型并放大预算;默认 flash 预算保持旧值", async () => {
    const { writeDraftInternals } = await import("../tools/writeDraft.js");
    expect(writeDraftInternals.makeReasonBudget(1000, "flash")).toEqual({
      outputMs: 10_000,
      thinkMs: 15_000,
      totalMs: 25_000,
      thinkEffectiveMs: 15_000,
    });
    expect(writeDraftInternals.reasonBudgetMultiplier("pro")).toBe(3);
    expect(writeDraftInternals.makeReasonBudget(1000, "pro")).toEqual({
      outputMs: 30_000,
      thinkMs: 45_000,
      totalMs: 75_000,
      thinkEffectiveMs: 45_000,
    });

    const { tool } = await makeTool();
    streamInnerModelMock.mockResolvedValue({ raw: qingmlParagraph("pro 档正文"), contentStartMs: 0, finishReason: "stop" });
    const requestContext = new RequestContext([["modelOverrides", { tier: "pro" }]]);

    const out = await run(tool, { title: "t", outline: "o", intent: "reason" }, { requestContext });

    expect(out.ok).toBe(true);
    expect(streamInnerModelMock).toHaveBeenCalledTimes(4);
    expect(streamInnerModelMock.mock.calls.every((call) =>
      (call[0] as InnerModelCall).requestContext === requestContext
    )).toBe(true);
  });

  it("两级嵌套列表首稿使用 children 递归表示，一轮 4 路即可编译成真实嵌套 PM", async () => {
    const { tool, state } = await makeTool();
    streamInnerModelMock.mockResolvedValue({ raw: twoLevelListQingml(), contentStartMs: 0, finishReason: "stop" });

    const out = await run(
      tool,
      { title: "开发流程", outline: "请生成两级嵌套列表，列出开发流程" },
      { requestContext: new RequestContext([["userText", "请生成两级嵌套列表，列出开发流程"]]) },
    );

    expect(out.ok).toBe(true);
    expect(streamInnerModelMock).toHaveBeenCalledTimes(4);
    expect(state.docDraftCandidateDoc).toBeTruthy();
    expect(pmDocHasNestedList(state.docDraftCandidateDoc!, 2)).toBe(true);
  });

  it("写新文章成嵌套列表仍走 writeDraft 生成路径", async () => {
    const { tool, state } = await makeTool();
    bindDoc(state, pmFlatOrderedList(["旧内容"]));
    streamInnerModelMock.mockResolvedValue({ raw: twoLevelListQingml(), contentStartMs: 0, finishReason: "stop" });

    const out = await run(
      tool,
      { title: "新文章", outline: "写一篇两级嵌套列表，列出开发流程" },
      { requestContext: new RequestContext([["userText", "写一篇两级嵌套列表，列出开发流程"]]) },
    );

    expect(out.ok).toBe(true);
    expect(streamInnerModelMock).toHaveBeenCalledTimes(4);
    expect(state.docDraftCandidateDoc).toBeTruthy();
    expect(pmDocHasNestedList(state.docDraftCandidateDoc!, 2)).toBe(true);
    expect(pmToPlainText(state.docDraftCandidateDoc!)).toContain("打开项目");
  });

  it("两级嵌套列表首稿若模型仍给旧平铺列表，不再额外补一路结构重试，但仍返回结构失败诊断标记", async () => {
    const { tool, state } = await makeTool();
    const flatList = `<ul><li>苹果</li><li>香蕉</li><li>橙子</li><li>梨子</li></ul>`;
    streamInnerModelMock.mockResolvedValue({ raw: flatList, contentStartMs: 0 });

    const out = await run(
      tool,
      { title: "水果结构", outline: "请生成两级嵌套列表，列出水果结构" },
      { requestContext: new RequestContext([["userText", "请生成两级嵌套列表，列出水果结构"]]) },
    );

    expect(out.ok).toBe(true);
    expect(out.nestedListReachedDepth).toBe(false);
    // 仍返回结构失败诊断(交回 agent / 上层),只是不再因此自动补一路 LLM 重试。
    expect(out.structuralFailures).toContain("nested-list");
    // 不再触发"上一版未达 N 层"那一路额外重试。
    expect(
      streamInnerModelMock.mock.calls.some((c) =>
        JSON.stringify((c[0] as InnerModelCall).messages ?? []).includes("上一版未达到"),
      ),
    ).toBe(false);
    expect(state.docDraftCandidateDoc).toBeTruthy();
    expect(pmDocHasNestedList(state.docDraftCandidateDoc!, 2)).toBe(false);
    expect(pmToPlainText(state.docDraftCandidateDoc!)).toContain("苹果");
  });

  it("嵌套列表意图只读取用户原话，不受模型自产写稿参数影响", async () => {
    const { tool } = await makeTool();
    streamInnerModelMock.mockResolvedValue({
      raw: qingmlParagraph("普通说明正文"),
      contentStartMs: 0,
      finishReason: "stop",
    });

    const out = await run(
      tool,
      {
        title: "三级嵌套列表说明",
        outline: "请用三级嵌套列表组织内容",
        styleHint: "使用多级清单",
      },
      { requestContext: new RequestContext([["userText", "请写一段普通说明"]]) },
    );

    expect(out.ok).toBe(true);
    expect(out.nestedListReachedDepth).toBeUndefined();
    expect(out.structuralFailures).toBeUndefined();
  });

  it("三级嵌套诉求下 children 递归直接编译到三级，不继续 LLM 重构", async () => {
    const { tool, state } = await makeTool();
    streamInnerModelMock.mockResolvedValue({ raw: threeLevelListQingml(), contentStartMs: 0, finishReason: "stop" });

    const out = await run(
      tool,
      { title: "写作流程", outline: "请生成三级嵌套列表，列出写作流程" },
      { requestContext: new RequestContext([["userText", "请生成三级嵌套列表，列出写作流程"]]) },
    );

    expect(out.ok).toBe(true);
    expect(streamInnerModelMock).toHaveBeenCalledTimes(4);
    expect(pmDocHasNestedList(state.docDraftCandidateDoc!, 3)).toBe(true);
  });

  it("三级嵌套诉求下候选里有达标者时优先选达标候选，而不是纯按字数选", async () => {
    process.env.QINGAGENT_RACE_LANES = "2";
    process.env.QINGAGENT_RACE_ROUNDS = "1";
    const { tool, state } = await makeTool();
    const lengthBestButFlat = qingmlParagraph("字".repeat(120));
    const structurallyValidButShort = structurallyValidThreeLevelQingml();
    streamInnerModelMock
      .mockResolvedValueOnce({ raw: lengthBestButFlat, contentStartMs: 0 })
      .mockResolvedValueOnce({ raw: structurallyValidButShort, contentStartMs: 0 })
      .mockResolvedValueOnce({ raw: lengthBestButFlat, contentStartMs: 0 })
      .mockResolvedValueOnce({ raw: lengthBestButFlat, contentStartMs: 0 });

    const out = await run(
      tool,
      {
        title: "层级计划",
        outline: "请生成三级嵌套列表，列出层级计划",
        lengthTarget: 120,
        lengthBound: "exact",
      },
      { requestContext: new RequestContext([["userText", "请生成三级嵌套列表，列出层级计划"]]) },
    );

    expect(out.ok).toBe(true);
    expect(out.nestedListReachedDepth).toBe(true);
    expect(out.structuralFailures).toBeUndefined();
    expect(streamInnerModelMock).toHaveBeenCalledTimes(4);
    expect(state.docDraftCandidateDoc).toBeTruthy();
    expect(pmDocHasNestedList(state.docDraftCandidateDoc!, 3)).toBe(true);
    expect(pmToPlainText(state.docDraftCandidateDoc!)).toContain("达标三级");
    expect(pmToPlainText(state.docDraftCandidateDoc!)).not.toContain("字".repeat(20));
  });

  it("reason 已有兜底候选时仍等满 T_think 争取精修，随后立即收摊而不等 hardTimer", async () => {
    vi.useFakeTimers();
    const { tool } = await makeTool();
    const calls: InnerModelCall[] = [];
    streamInnerModelMock.mockImplementation((input: InnerModelCall) => {
      calls.push(input);
      const index = calls.length - 1;
      if (index === 0) {
        return new Promise((resolve) => {
          setTimeout(() => {
            const raw = qingmlParagraph("保".repeat(80));
            input.onContentStart?.();
            input.onContentDelta?.(raw, raw);
            resolve({ raw, contentStartMs: 1_000, finishReason: "stop" });
          }, 1_000);
        });
      }

      input.onContentStart?.();
      return new Promise((_resolve, reject) => {
        input.abortSignal?.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    });

    let settled = false;
    const pending = run(tool, {
      title: "t",
      outline: "o",
      intent: "reason",
      lengthTarget: 100,
      lengthBound: "exact",
    }).finally(() => {
      settled = true;
    });
    await waitForCalls(calls, 4);
    expect(calls).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    const settledAtThink = settled;

    // 旧实现要到 25s hardTimer 才收口；先把它清掉再断言红测，避免留下悬空 Promise。
    if (!settledAtThink) await vi.advanceTimersByTimeAsync(10_000);
    const out = await pending;

    expect(settledAtThink).toBe(true);
    expect(out).toMatchObject({ ok: true, wordCount: 80, lengthStatus: "below_min" });
    expect(calls[0]!.abortSignal?.aborted).toBe(false);
    expect(calls.slice(1).every((call) => call.abortSignal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reason 严格提前终止仍同时要求 refinement、嵌套深度与字数达标", async () => {
    vi.useFakeTimers();
    const { tool, state } = await makeTool();
    const calls: InnerModelCall[] = [];
    const raws = [
      namedThreeLevelQingml("保底"), // fallback：结构和字数达标，但类型不够格
      qingmlParagraph("平铺内容".repeat(3)), // refinement：字数达标，但没有嵌套
      namedThreeLevelQingml("超长内容"), // refinement：结构达标，但字数超限
      namedThreeLevelQingml("精修"), // refinement：三条全部达标
    ];
    streamInnerModelMock.mockImplementation((input: InnerModelCall) => {
      calls.push(input);
      const index = calls.length - 1;
      const raw = raws[index]!;
      input.onContentStart?.();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          input.onContentDelta?.(raw, raw);
          resolve({ raw, contentStartMs: (index + 1) * 1_000, finishReason: "stop" });
        }, (index + 1) * 1_000);
        input.abortSignal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(abortError());
        }, { once: true });
      });
    });

    let settled = false;
    const pending = run(
      tool,
      {
        title: "层级计划",
        outline: "请生成三级嵌套列表",
        intent: "reason",
        lengthTarget: 12,
        lengthBound: "exact",
      },
      { requestContext: new RequestContext([["userText", "请生成三级嵌套列表"]]) },
    ).finally(() => {
      settled = true;
    });
    await waitForCalls(calls, 4);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    const out = await pending;

    expect(out).toMatchObject({
      ok: true,
      wordCount: 12,
      lengthStatus: "accepted_first_pass",
      nestedListReachedDepth: true,
    });
    expect(pmToPlainText(state.docDraftCandidateDoc!)).toContain("精修三级");
    expect(calls.slice(0, 3).every((call) => call.abortSignal?.aborted)).toBe(true);
    expect(calls[3]!.abortSignal?.aborted).toBe(false);
  });

  it("reason 全部 lane 编译失败时随最后一路 settle 立即失败，不把无效输出当兜底候选", async () => {
    vi.useFakeTimers();
    const { tool, state } = await makeTool();
    const calls: InnerModelCall[] = [];
    streamInnerModelMock.mockImplementation((input: InnerModelCall) => {
      calls.push(input);
      return new Promise((resolve) => {
        setTimeout(() => resolve({
          raw: "<pre>text<p>block</p></pre>",
          contentStartMs: 1_000,
          finishReason: "stop",
        }), 1_000);
      });
    });

    let settled = false;
    const pending = run(tool, { title: "t", outline: "o", intent: "reason" }).finally(() => {
      settled = true;
    });
    await waitForCalls(calls, 4);
    await vi.advanceTimersByTimeAsync(1_000);
    const out = await pending;

    expect(settled).toBe(true);
    expect(out.ok).toBe(false);
    expect((out as { error?: string }).error).toContain("重新调用 writeDraft");
    expect(state.docDraftCandidateDoc).toBeNull();
    expect(calls.every((call) => call.abortSignal?.aborted === false)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reason:1 保底 + 3 精修,未出正文精修路到 T_think 被 abort 且不入候选,心跳清 timer", async () => {
    vi.useFakeTimers();
    const { tool } = await makeTool();
    const calls: InnerModelCall[] = [];
    streamInnerModelMock.mockImplementation((input: InnerModelCall) => {
      calls.push(input);
      const index = calls.length - 1;
      if (index === 1) {
        input.onContentDelta?.("partial", qingmlParagraph("x".repeat(400)));
        return new Promise((_resolve, reject) => {
          input.abortSignal?.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      }

      const text = index === 0 ? "a".repeat(80) : index === 2 ? "b".repeat(100) : "c".repeat(50);
      const raw = qingmlParagraph(text);
      input.onContentStart?.();
      input.onContentDelta?.(raw, raw);
      if (index === 3) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ raw, contentStartMs: 1 }), 1_000);
          input.abortSignal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(abortError());
          }, { once: true });
        });
      }
      return Promise.resolve({ raw, contentStartMs: 1 });
    });
    const writes: Array<Record<string, unknown>> = [];
    const ctx = { writer: { write: (chunk: Record<string, unknown>) => void writes.push(chunk) } };

    const pending = run(tool, { title: "t", outline: "o", intent: "reason", lengthTarget: 100 }, ctx);
    await waitForCalls(calls, 4);
    expect(calls).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(15_000);
    const out = await pending;

    expect(out.ok).toBe(true);
    expect(out.wordCount).toBe(100);
    expect(out.revisionCount).toBe(1);
    expect(out.lengthStatus).toBe("accepted_first_pass");
    expect(calls.map((call) => call.thinking)).toEqual([false, true, true, true]);
    expect(calls.map((call) => call.lane)).toEqual([0, 1, 2, 3]);
    expect(calls[1]!.abortSignal?.aborted).toBe(true);
    const progressEvents = writes.filter((w) => w.type === "writedraft-progress");
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    expect(progressEvents.map((w) => (w.progress as { phase: string }).phase)).toContain("finalizing");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reason 尚无兜底候选时，T_think 保留已见首字的精修路继续争取", async () => {
    vi.useFakeTimers();
    const { tool } = await makeTool();
    const calls: InnerModelCall[] = [];
    streamInnerModelMock.mockImplementation((input: InnerModelCall) => {
      calls.push(input);
      const index = calls.length - 1;
      if (index === 0) {
        return new Promise((_resolve, reject) => {
          input.abortSignal?.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      }
      if (index === 1) {
        return new Promise((resolve, reject) => {
          const startTimer = setTimeout(() => {
            // 模拟 branch 原始流首字时机信号；验真回放尚未发生。
            input.onContentStart?.();
          }, 2_000);
          const finishTimer = setTimeout(() => {
            input.abortSignal?.removeEventListener("abort", onAbort);
            const raw = qingmlParagraph("b".repeat(100));
            input.onContentDelta?.(raw, raw);
            resolve({ raw, contentStartMs: 2_000, finishReason: "stop" });
          }, 20_000);
          const onAbort = () => {
            clearTimeout(startTimer);
            clearTimeout(finishTimer);
            reject(abortError());
          };
          input.abortSignal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      return new Promise((_resolve, reject) => {
        input.abortSignal?.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    });

    const pending = run(tool, { title: "t", outline: "o", intent: "reason", lengthTarget: 100 });
    await waitForCalls(calls, 4);
    expect(calls).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls[1]!.abortSignal?.aborted).toBe(false);
    expect(calls[2]!.abortSignal?.aborted).toBe(true);
    expect(calls[3]!.abortSignal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    const out = await pending;
    expect(out.ok).toBe(true);
    expect(out.wordCount).toBe(100);
    expect(out.revisionCount).toBe(1);
    expect(calls[1]!.abortSignal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reason 无字数时 fallback 不提前截停 thinking 精修", async () => {
    const { tool, state } = await makeTool();
    const calls: InnerModelCall[] = [];
    streamInnerModelMock.mockImplementation((input: InnerModelCall) => {
      calls.push(input);
      const index = calls.length - 1;
      const text = index === 0 ? "fallback".repeat(20) : index === 1 ? "refinement".repeat(30) : "slow".repeat(30);
      const raw = qingmlParagraph(text);

      if (index === 0) {
        input.onContentStart?.();
        input.onContentDelta?.(raw, raw);
        return Promise.resolve({ raw, contentStartMs: 1, finishReason: "stop" });
      }

      const delayMs = index === 1 ? 20 : 500;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          input.abortSignal?.removeEventListener("abort", onAbort);
          input.onContentStart?.();
          input.onContentDelta?.(raw, raw);
          resolve({ raw, contentStartMs: 1, finishReason: "stop" });
        }, delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(abortError());
        };
        input.abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
    });

    const out = await run(tool, { title: "t", outline: "o", intent: "reason" });

    expect(out.ok).toBe(true);
    expect(out.lengthStatus).toBe("not_requested");
    expect(out.revisionCount).toBe(1);
    expect(calls).toHaveLength(4);
    expect(calls[0]!.thinking).toBe(false);
    expect(calls.slice(1).every((call) => call.thinking)).toBe(true);
    expect(calls[1]!.abortSignal?.aborted).toBe(false);
    expect(calls[2]!.abortSignal?.aborted).toBe(true);
    expect(calls[3]!.abortSignal?.aborted).toBe(true);
    const text = pmToPlainText(state.docDraftCandidateDoc!);
    expect(text).toContain("refinement");
    expect(text).not.toContain("fallback");
  });

  it("reason 合并 context.abortSignal,外层 abort 会取消内层 lane; 4 路全废快速返回 ok:false", async () => {
    const { tool } = await makeTool();
    const calls: InnerModelCall[] = [];
    streamInnerModelMock.mockImplementation((input: InnerModelCall) => {
      calls.push(input);
      return new Promise((_resolve, reject) => {
        input.abortSignal?.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    });
    const parent = new AbortController();

    const pending = run(tool, { title: "t", outline: "o", intent: "reason" }, { abortSignal: parent.signal });
    await waitForCalls(calls, 4);
    expect(calls).toHaveLength(4);
    parent.abort();

    const out = await pending;
    expect(out.ok).toBe(false);
    expect((out as { error?: string }).error).toContain("重新调用 writeDraft");
    expect(out.targetLength).toBeUndefined();
    expect(out.lengthStatus).toBeUndefined();
    expect(calls).toHaveLength(4);
    expect(calls.slice(0, 4).every((call) => call.abortSignal?.aborted)).toBe(true);

    const { writeDraftInternals } = await import("../tools/writeDraft.js");
    expect(writeDraftInternals.makeReasonBudget(1000)).toEqual({
      outputMs: 10_000,
      thinkMs: 15_000,
      totalMs: 25_000,
      thinkEffectiveMs: 15_000,
    });
  });

  it("真实 Mastra writeDraft 工具拒绝 idle-timeout 后迟到的 abort/旧代次写入", async () => {
    const runLateTool = async (mode: "abort" | "generation") => {
      const { tool, state } = await makeTool();
      const controller = new AbortController();
      const ownership = beginTurnOwnership(state, `late-${mode}:attempt:0`);
      const requestContext = new RequestContext([["abortSignal", controller.signal]]);
      bindTurnOwnershipToRequestContext(requestContext, ownership);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls: InnerModelCall[] = [];
      streamInnerModelMock.mockImplementation(async (input: InnerModelCall) => {
        calls.push(input);
        await gate;
        return {
          raw: qingmlParagraph(`不应落库-${mode}`),
          contentStartMs: 0,
          finishReason: "stop",
        };
      });

      const pending = run(
        tool,
        { title: "迟到写入", outline: "模拟流帧已被 idle timeout 挡住" },
        { abortSignal: controller.signal, requestContext },
      );
      await waitForCalls(calls, 4);
      expect(calls).toHaveLength(4);
      if (mode === "abort") {
        controller.abort(new DOMException("idle timeout", "AbortError"));
      } else {
        beginTurnOwnership(state, "late-generation:attempt:1");
      }
      release();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(state.docDraftCandidateDoc).toBeNull();
      expect(state.docDraftCandidateSections).toBeNull();
    };

    await runLateTool("abort");
    streamInnerModelMock.mockReset();
    await runLateTool("generation");
  });
});

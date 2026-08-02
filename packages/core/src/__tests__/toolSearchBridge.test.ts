import { beforeEach, describe, expect, it, vi } from "vitest";
import { MASTRA_THREAD_ID_KEY, RequestContext } from "@mastra/core/request-context";
import type { BridgeFrame } from "@qingagent/contract-ts";
import {
  getActivatedSkillRegistrations,
} from "../skills/writeInject.js";
import { BUILTIN_SKILLS_DIR } from "../skills/paths.js";
import { EXTERNAL_SKILL_POSITIONING_NOTICE } from "../skills/externalSkillNotice.js";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  disabledSkills: new Set<string>(),
}));

vi.mock("../skills/enabledStore.js", () => ({
  readDisabledSet: vi.fn(async () => new Set(h.disabledSkills)),
}));

vi.mock("@qingagent/doc-render/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@qingagent/doc-render/browser")>()),
  getAgentBrowserTools: () => ({}),
}));

vi.mock("../tools/runPython.js", () => ({
  getPyodideTools: () => ({}),
}));

async function* streamOf(...chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk;
}

async function collect(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

describe("ToolSearch bridge", () => {
  beforeEach(() => {
    h.disabledSkills.clear();
  });

  it("只把 UI/状态工具常驻,低频能力工具进入 ToolSearch 候选", async () => {
    const { buildCapabilityToolSearchBridge } = await import("../session/sessionTools.js");

    const bridge = await buildCapabilityToolSearchBridge(["image-gen", "materials"]);

    expect(Object.keys(bridge.alwaysTools).sort()).toEqual(["show_qr", "updateTodos"]);
    expect(Object.keys(bridge.searchableTools).sort()).toEqual(expect.arrayContaining([
      "fetchArticle",
      "editSvgWithCodexFallback",
      "generateSvg",
      "importGeneratedImage",
      "parseFile",
      "prepareImageEditSource",
      "readImage",
      "run_js",
      "webSearch",
    ]));
    expect(Object.keys(bridge.searchableTools)).not.toContain("show_qr");
    expect(Object.keys(bridge.searchableTools)).not.toContain("updateTodos");
    expect(bridge.preloadToolNames.sort()).toEqual([
      "editSvgWithCodexFallback",
      "generateSvg",
      "importGeneratedImage",
      "parseFile",
      "prepareImageEditSource",
    ]);
  });

  it("doc-calc 点召预加载 run_js,停用 doc-calc 后 run_js 仍作为通用计算工具可搜索", async () => {
    const { buildCapabilityToolSearchBridge } = await import("../session/sessionTools.js");

    const bridge = await buildCapabilityToolSearchBridge(["doc-calc"]);
    expect(Object.keys(bridge.searchableTools)).toContain("run_js");
    expect(bridge.preloadToolNames).toEqual(["run_js"]);

    h.disabledSkills.add("doc-calc");
    const disabledBridge = await buildCapabilityToolSearchBridge([]);
    expect(Object.keys(disabledBridge.searchableTools)).toContain("run_js");
    expect(disabledBridge.preloadToolNames).toEqual([]);
  });

  it("review 汇总审查专用工具，旧技能禁用记录不影响新技能", async () => {
    const {
      buildCapabilityToolSearchBridge,
      buildCapabilityTools,
    } = await import("../session/sessionTools.js");
    const oldReviewNames = [
      "sensitive-review",
      "source-check",
      "deai-review",
      "consistency-review",
      "privacy-review",
      "format-review",
      "role-review",
      "custom-review",
    ];
    for (const oldName of oldReviewNames) h.disabledSkills.add(oldName);

    const tools = await buildCapabilityTools();
    expect(Object.keys(tools)).toEqual(expect.arrayContaining([
      "lexicon_list",
      "sensitive_scan",
      "lexicon_manage",
      "style_template_get",
    ]));
    const bridge = await buildCapabilityToolSearchBridge(["review"]);
    expect(bridge.preloadToolNames.sort()).toEqual([
      "lexicon_list",
      "lexicon_manage",
      "sensitive_scan",
      "style_template_get",
    ]);
  });

  it("关闭 web-search 后 schema 同时移除 webSearch 与间接联网 fetchArticle", async () => {
    h.disabledSkills.add("web-search");
    const {
      buildCapabilityToolSearchBridge,
      buildCapabilityTools,
    } = await import("../session/sessionTools.js");

    const tools = await buildCapabilityTools();
    expect(Object.keys(tools)).not.toContain("webSearch");
    expect(Object.keys(tools)).not.toContain("fetchArticle");
    expect(Object.keys(tools)).toContain("generateSvg");
    expect(Object.keys(tools)).toContain("prepareImageEditSource");
    expect(Object.keys(tools)).toContain("editSvgWithCodexFallback");
    expect(Object.keys(tools)).toContain("importGeneratedImage");
    expect(Object.keys(tools)).toContain("run_js");

    const bridge = await buildCapabilityToolSearchBridge([
      "web-search",
      "wechat-official-account",
      "derivative-writing",
    ]);
    expect(Object.keys(bridge.searchableTools)).not.toContain("webSearch");
    expect(Object.keys(bridge.searchableTools)).not.toContain("fetchArticle");
    expect(bridge.preloadToolNames).not.toContain("webSearch");
    expect(bridge.preloadToolNames).not.toContain("fetchArticle");
    expect(Object.keys(bridge.searchableTools)).toContain("wechat_auth_status");
    expect(Object.keys(bridge.searchableTools)).toContain("style_template_list");
  });

  it("关闭 web-search 后硬调联网工具会在 Agent dispatch 前 fail-closed", async () => {
    h.disabledSkills.add("web-search");
    const { qingagentAgent } = await import("../agents/qingagent.js");
    const beforeToolCall = qingagentAgent.getConfiguredToolHooks()?.beforeToolCall;
    expect(beforeToolCall).toBeTypeOf("function");

    const execute = vi.fn();
    for (const [toolName, input] of [
      ["webSearch", { query: "今天的新闻" }],
      ["fetchArticle", { url: "https://example.com/news" }],
    ] as const) {
      const decision = await beforeToolCall!({
        toolName,
        input,
        context: {},
      });
      const output = decision?.proceed === false
        ? decision.output
        : await execute();

      expect(output).toMatchObject({
        ok: false,
        blocked: true,
        code: "SKILL_DISABLED",
        skillName: "web-search",
        toolName,
      });
      expect(output).toHaveProperty(
        "message",
        expect.stringContaining("“联网搜”技能已停用"),
      );
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("skill() 按名称登记通用激活状态，diagram-viz 停用时仍 fail-closed", async () => {
    const { buildQingagentStaticTools, qingagentAgent } = await import("../agents/qingagent.js");
    const beforeToolCall = qingagentAgent.getConfiguredToolHooks()?.beforeToolCall;
    const requestContext = new RequestContext([
      ["userText", "请画一个 Mermaid 流程图"],
    ]) as unknown as RequestContext;
    const systemBefore = await qingagentAgent.getInstructions({ requestContext });
    const toolsBefore = Object.entries(buildQingagentStaticTools()).map(
      ([name, tool]) => [name, (tool as { description?: string }).description],
    );

    await expect(beforeToolCall!({
      toolName: "skill",
      input: { name: "diagram-viz" },
      context: { requestContext },
    })).resolves.toBeUndefined();
    expect(getActivatedSkillRegistrations(requestContext)).toEqual([{
      name: "diagram-viz",
      hints: ["请画一个 Mermaid 流程图"],
    }]);
    await expect(beforeToolCall!({
      toolName: "skill",
      input: { name: "image-gen" },
      context: { requestContext },
    })).resolves.toBeUndefined();
    expect(
      getActivatedSkillRegistrations(requestContext).map((entry) => entry.name),
    ).toEqual(["diagram-viz", "image-gen"]);
    expect(await qingagentAgent.getInstructions({ requestContext })).toBe(systemBefore);
    expect(
      Object.entries(buildQingagentStaticTools()).map(
        ([name, tool]) => [name, (tool as { description?: string }).description],
      ),
    ).toEqual(toolsBefore);
    expect(systemBefore).not.toContain("Mermaid 语法只认半角");

    h.disabledSkills.add("diagram-viz");
    const disabledContext = new RequestContext();
    await expect(beforeToolCall!({
      toolName: "skill",
      input: { name: "diagram-viz" },
      context: { requestContext: disabledContext },
    })).resolves.toMatchObject({
      proceed: false,
      output: {
        code: "SKILL_DISABLED",
        skillName: "diagram-viz",
        toolName: "skill",
      },
    });
    expect(getActivatedSkillRegistrations(disabledContext)).toEqual([]);
  });

  it("skill() 只给非 builtin 技能正文追加第三方定位声明", async () => {
    const { qingagentAgent } = await import("../agents/qingagent.js");
    const beforeToolCall = qingagentAgent.getConfiguredToolHooks()?.beforeToolCall;
    const externalSkill = {
      name: "external-cli",
      description: "外部 CLI",
      path: "/tmp/qingagent-external-cli",
      instructions: "# 外部技能\n执行 external-cli",
      source: "local",
      references: [],
      scripts: [],
      assets: [],
    };
    const builtinSkill = {
      ...externalSkill,
      name: "review",
      path: join(BUILTIN_SKILLS_DIR, "capability", "review"),
      instructions: "# 文档审查",
    };
    const skills = {
      maybeRefresh: vi.fn(async () => undefined),
      get: vi.fn(async (name: string) =>
        name === "external-cli"
          ? externalSkill
          : name === "review"
            ? builtinSkill
            : null
      ),
    };
    const workspace = { skills };

    await expect(beforeToolCall!({
      toolName: "skill",
      input: { name: "external-cli" },
      context: { workspace },
    } as never)).resolves.toEqual({
      proceed: false,
      output: expect.stringContaining(EXTERNAL_SKILL_POSITIONING_NOTICE),
    });
    await expect(beforeToolCall!({
      toolName: "skill",
      input: { name: "review" },
      context: { workspace },
    } as never)).resolves.toBeUndefined();
  });

  it("ToolSearch 工具签名变化时替换旧 processor,不保留关闭前 schema", async () => {
    const { createSession } = await import("../session/sessionState.js");
    const {
      buildCapabilityToolSearchBridge,
      ensureSessionToolSearchProcessor,
    } = await import("../session/sessionTools.js");
    const state = createSession("tool-search-toggle-session");
    const enabledBridge = await buildCapabilityToolSearchBridge([]);
    const enabledProcessor = ensureSessionToolSearchProcessor(state, enabledBridge);

    h.disabledSkills.add("web-search");
    const disabledBridge = await buildCapabilityToolSearchBridge([]);
    const disabledProcessor = ensureSessionToolSearchProcessor(state, disabledBridge);

    expect(disabledProcessor).not.toBe(enabledProcessor);
    expect(state._toolSearchToolSignature).toBe(disabledBridge.signature);
    expect(disabledBridge.signature).not.toContain("webSearch");
    expect(disabledBridge.signature).not.toContain("fetchArticle");
  });

  it("processor 按会话复用,selected skill 预加载写入 loaded state", async () => {
    const { createSession } = await import("../session/sessionState.js");
    const {
      buildCapabilityToolSearchBridge,
      ensureSessionToolSearchProcessor,
    } = await import("../session/sessionTools.js");
    const { preloadQingagentToolSearchTools } = await import("../agents/toolSearch.js");
    const state = createSession("tool-search-session");
    const bridge = await buildCapabilityToolSearchBridge(["image-gen"]);

    const processor = ensureSessionToolSearchProcessor(state, bridge);
    expect(ensureSessionToolSearchProcessor(state, bridge)).toBe(processor);

    const requestContext = new RequestContext([
      [MASTRA_THREAD_ID_KEY, state.sessionId],
    ]) as unknown as RequestContext;
    expect(await processor.getLoadedToolsForRequestContext({ requestContext })).toEqual({});

    await expect(preloadQingagentToolSearchTools({
      processor,
      requestContext,
      messages: [],
      toolNames: bridge.preloadToolNames,
    })).resolves.toEqual([
      "generateSvg",
      "prepareImageEditSource",
      "editSvgWithCodexFallback",
      "importGeneratedImage",
    ]);

    const loaded = await processor.getLoadedToolsForRequestContext({ requestContext });
    expect(Object.keys(loaded)).toEqual([
      "generateSvg",
      "prepareImageEditSource",
      "editSvgWithCodexFallback",
      "importGeneratedImage",
    ]);
  });

  it("ToolSearch preload 在 pro 档使用 pro router model", async () => {
    const { preloadQingagentToolSearchTools } = await import("../agents/toolSearch.js");
    const processInputStep = vi.fn(async () => ({
      tools: {
        search_tools: {
          execute: vi.fn(async () => ({ results: [{ name: "parseFile" }] })),
        },
      },
    }));
    const requestContext = new RequestContext([
      [MASTRA_THREAD_ID_KEY, "tool-search-pro-session"],
      ["modelOverrides", { tier: "pro" }],
    ]) as unknown as RequestContext;

    await expect(preloadQingagentToolSearchTools({
      processor: { processInputStep } as never,
      requestContext,
      messages: [],
      toolNames: ["parseFile"],
    })).resolves.toEqual(["parseFile"]);

    expect(processInputStep).toHaveBeenCalledWith(expect.objectContaining({
      model: "deepseek/deepseek-v4-pro",
    }));
  });

  it("动态 search 结果记录后,下一轮会从会话 state 预加载已加载工具", async () => {
    const { createSession } = await import("../session/sessionState.js");
    const {
      buildCapabilityToolSearchBridge,
      ensureSessionToolSearchProcessor,
    } = await import("../session/sessionTools.js");
    const {
      extractLoadedToolNamesFromToolSearchResult,
      preloadQingagentToolSearchTools,
    } = await import("../agents/toolSearch.js");
    const state = createSession("tool-search-dynamic-session");
    const bridge = await buildCapabilityToolSearchBridge([]);

    state._toolSearchLoadedToolNames = extractLoadedToolNamesFromToolSearchResult({
      results: [
        { name: "parseFile", description: "解析文件" },
        { name: "parseFile", description: "重复结果只保留一次" },
      ],
    });
    expect(state._toolSearchLoadedToolNames).toEqual(["parseFile"]);

    const processor = ensureSessionToolSearchProcessor(state, bridge);
    const requestContext = new RequestContext([
      [MASTRA_THREAD_ID_KEY, state.sessionId],
    ]) as unknown as RequestContext;

    await expect(preloadQingagentToolSearchTools({
      processor,
      requestContext,
      messages: state.messages,
      toolNames: state._toolSearchLoadedToolNames,
    })).resolves.toEqual(["parseFile"]);

    const loaded = await processor.getLoadedToolsForRequestContext({ requestContext });
    expect(Object.keys(loaded)).toEqual(["parseFile"]);
  });

  it("tool-result output 字段也会记录 ToolSearch loaded state", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("tool-search-output-result");

    await collect(processAgentStream(
      streamOf({
        type: "tool-result",
        payload: {
          toolName: "search_tools",
          toolCallId: "search-output-1",
          args: { query: "parseFile" },
          output: {
            results: [{ name: "parseFile", description: "解析文件", score: 1 }],
          },
        },
      }),
      { state, agentMessageId: "agent-msg", streamId: "stream-tool-search-output", runId: "run-tool-search-output" },
    ));

    expect(state._toolSearchLoadedToolNames).toEqual(["parseFile"]);
  });
});

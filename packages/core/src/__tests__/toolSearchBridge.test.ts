import { beforeEach, describe, expect, it, vi } from "vitest";
import { MASTRA_THREAD_ID_KEY, RequestContext } from "@mastra/core/request-context";
import type { BridgeFrame } from "@qingagent/contract-ts";

const h = vi.hoisted(() => ({
  disabledSkills: new Set<string>(),
}));

vi.mock("../skills/enabledStore.js", () => ({
  readDisabledSet: vi.fn(async () => new Set(h.disabledSkills)),
}));

vi.mock("../browser/agentBrowser.js", () => ({
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
    const { buildCapabilityToolSearchBridge } = await import("../bridge/sessionTools.js");

    const bridge = await buildCapabilityToolSearchBridge(["image-gen", "materials"]);

    expect(Object.keys(bridge.alwaysTools).sort()).toEqual(["show_qr", "updateTodos"]);
    expect(Object.keys(bridge.searchableTools).sort()).toEqual(expect.arrayContaining([
      "fetchArticle",
      "generateSvg",
      "parseFile",
      "readImage",
      "run_js",
      "webSearch",
    ]));
    expect(Object.keys(bridge.searchableTools)).not.toContain("show_qr");
    expect(Object.keys(bridge.searchableTools)).not.toContain("updateTodos");
    expect(bridge.preloadToolNames.sort()).toEqual([
      "fetchArticle",
      "generateSvg",
      "parseFile",
    ]);
  });

  it("doc-calc 点召预加载 run_js,停用 doc-calc 后 run_js 仍作为通用计算工具可搜索", async () => {
    const { buildCapabilityToolSearchBridge } = await import("../bridge/sessionTools.js");

    const bridge = await buildCapabilityToolSearchBridge(["doc-calc"]);
    expect(Object.keys(bridge.searchableTools)).toContain("run_js");
    expect(bridge.preloadToolNames).toEqual(["run_js"]);

    h.disabledSkills.add("doc-calc");
    const disabledBridge = await buildCapabilityToolSearchBridge([]);
    expect(Object.keys(disabledBridge.searchableTools)).toContain("run_js");
    expect(disabledBridge.preloadToolNames).toEqual([]);
  });

  it("processor 按会话复用,selected skill 预加载写入 loaded state", async () => {
    const { createSession } = await import("../bridge/sessionState.js");
    const {
      buildCapabilityToolSearchBridge,
      ensureSessionToolSearchProcessor,
    } = await import("../bridge/sessionTools.js");
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
    })).resolves.toEqual(["generateSvg"]);

    const loaded = await processor.getLoadedToolsForRequestContext({ requestContext });
    expect(Object.keys(loaded)).toEqual(["generateSvg"]);
  });

  it("动态 search 结果记录后,下一轮会从会话 state 预加载已加载工具", async () => {
    const { createSession } = await import("../bridge/sessionState.js");
    const {
      buildCapabilityToolSearchBridge,
      ensureSessionToolSearchProcessor,
    } = await import("../bridge/sessionTools.js");
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

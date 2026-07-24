import { afterEach, describe, expect, it } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import {
  QINGAGENT_PROCESSOR_ENV,
  buildQingagentInputProcessors,
  buildQingagentOutputProcessors,
  resolveQingagentGuardrailModel,
  resolveQingagentProcessorFlags,
} from "../agents/processors.js";
import {
  QINGAGENT_TOOL_SEARCH_PROCESSOR_CONTEXT_KEY,
  QINGAGENT_TOOL_SEARCH_ENV,
  createQingagentToolSearchProcessor,
} from "../agents/toolSearch.js";
import { buildQingagentStaticTools } from "../agents/qingagent.js";
import {
  DIAGRAM_VIZ_EDITING_PROCESSOR_ID,
  markDiagramVizEditing,
} from "../skills/diagramViz.js";

const savedEnv = Object.fromEntries(
  [...Object.values(QINGAGENT_PROCESSOR_ENV), QINGAGENT_TOOL_SEARCH_ENV]
    .map((key) => [key, process.env[key]]),
);

function processorIds(processors: unknown[]): string[] {
  return processors.map((processor) => String((processor as { id?: unknown }).id ?? ""));
}

function resetProcessorEnv() {
  for (const key of [...Object.values(QINGAGENT_PROCESSOR_ENV), QINGAGENT_TOOL_SEARCH_ENV]) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  resetProcessorEnv();
});

describe("qingagent processors", () => {
  it("默认只启用非 LLM 型 UnicodeNormalizer 与 BatchPartsProcessor", () => {
    resetProcessorEnv();

    expect(processorIds(buildQingagentInputProcessors())).toEqual([
      "unicode-normalizer",
      DIAGRAM_VIZ_EDITING_PROCESSOR_ID,
    ]);
    expect(processorIds(buildQingagentOutputProcessors())).toEqual(["batch-parts"]);
    expect(Object.keys(buildQingagentStaticTools())).toEqual([
      "planDraft",
      "askUserQuestion",
      "parseFile",
      "storeMaterial",
    ]);
  });

  it("ToolSearch flag 打开后静态低频工具移出常驻列表,processor 仍按会话显式注入", () => {
    resetProcessorEnv();
    process.env[QINGAGENT_TOOL_SEARCH_ENV] = "1";

    expect(processorIds(buildQingagentInputProcessors())).toEqual([
      "unicode-normalizer",
      DIAGRAM_VIZ_EDITING_PROCESSOR_ID,
    ]);
    expect(Object.keys(buildQingagentStaticTools())).toEqual([
      "planDraft",
      "askUserQuestion",
      "storeMaterial",
    ]);
    expect(Object.keys(buildQingagentStaticTools())).not.toContain("askUser");

    const toolSearch = createQingagentToolSearchProcessor({});
    const requestContext = new RequestContext([
      [QINGAGENT_TOOL_SEARCH_PROCESSOR_CONTEXT_KEY, toolSearch],
    ]);
    expect(processorIds(buildQingagentInputProcessors({
      requestContext: requestContext as unknown as RequestContext,
    }))).toEqual([
      "unicode-normalizer",
      DIAGRAM_VIZ_EDITING_PROCESSOR_ID,
      "tool-search",
    ]);
  });

  it("联网工具不进入 Agent 静态 schema,统一由 capability 开关装配", () => {
    resetProcessorEnv();

    expect(Object.keys(buildQingagentStaticTools())).toEqual([
      "planDraft",
      "askUserQuestion",
      "parseFile",
      "storeMaterial",
    ]);
    expect(Object.keys(buildQingagentStaticTools())).not.toContain("fetchArticle");
    expect(Object.keys(buildQingagentStaticTools())).not.toContain("webSearch");
  });

  it("UnicodeNormalizer 会清掉控制字符并折叠空白", async () => {
    resetProcessorEnv();
    const [normalizer] = buildQingagentInputProcessors();
    const input = "请\u0000\u0008  帮我\t\t写作：ＡＢＣ";
    const messages = [
      {
        id: "m1",
        role: "user",
        content: {
          content: input,
          parts: [{ type: "text", text: input }],
        },
      },
    ];

    const output = await (normalizer as unknown as {
      processInput: (args: { messages: typeof messages; abort: (reason?: string) => never }) => typeof messages;
    }).processInput({
      messages,
      abort: (reason?: string): never => {
        throw new Error(reason ?? "aborted");
      },
    });

    const text = output[0]!.content.parts[0]!.text;
    expect(text).toBe("请 帮我 写作:ABC");
    expect(text).not.toContain("\u0000");
    expect(text).not.toContain("\u0008");
  });

  it("LLM 型 guardrail 开关默认关,各自开启时接入对应 workflow", () => {
    resetProcessorEnv();
    expect(resolveQingagentProcessorFlags()).toEqual({
      promptInjection: false,
      moderation: false,
      pii: false,
    });

    process.env[QINGAGENT_PROCESSOR_ENV.promptInjection] = "1";
    expect(resolveQingagentProcessorFlags().promptInjection).toBe(true);
    expect(processorIds(buildQingagentInputProcessors())).toEqual([
      "unicode-normalizer",
      DIAGRAM_VIZ_EDITING_PROCESSOR_ID,
      "qingagent-input-llm-guardrails",
    ]);
    expect(processorIds(buildQingagentOutputProcessors())).toEqual(["batch-parts"]);

    resetProcessorEnv();
    process.env[QINGAGENT_PROCESSOR_ENV.pii] = "true";
    expect(processorIds(buildQingagentInputProcessors())).toEqual([
      "unicode-normalizer",
      DIAGRAM_VIZ_EDITING_PROCESSOR_ID,
      "qingagent-input-llm-guardrails",
    ]);
    expect(processorIds(buildQingagentOutputProcessors())).toEqual([
      "batch-parts",
      "qingagent-output-llm-guardrails",
    ]);

    resetProcessorEnv();
    process.env[QINGAGENT_PROCESSOR_ENV.moderation] = "on";
    expect(processorIds(buildQingagentInputProcessors())).toEqual([
      "unicode-normalizer",
      DIAGRAM_VIZ_EDITING_PROCESSOR_ID,
      "qingagent-input-llm-guardrails",
    ]);
    expect(processorIds(buildQingagentOutputProcessors())).toEqual([
      "batch-parts",
      "qingagent-output-llm-guardrails",
    ]);
  });

  it("图表编辑 processor 只在 RequestContext 标记后为下一 step 注入对应引擎 system", async () => {
    resetProcessorEnv();
    const requestContext = new RequestContext();
    const processor = buildQingagentInputProcessors({ requestContext })
      .find((item) => (item as { id?: string }).id === DIAGRAM_VIZ_EDITING_PROCESSOR_ID) as unknown as {
        processInputStep: (args: {
          requestContext: RequestContext;
          messageList: { addSystem: (content: string, tag?: string) => unknown };
        }) => Promise<unknown>;
      };
    const added: Array<{ content: string; tag?: string }> = [];
    const messageList = {
      addSystem: (content: string, tag?: string) => {
        added.push({ content, tag });
        return messageList;
      },
    };

    await processor.processInputStep({ requestContext, messageList });
    expect(added).toEqual([]);

    markDiagramVizEditing(requestContext, ["mermaid"]);
    await processor.processInputStep({ requestContext, messageList });

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ tag: DIAGRAM_VIZ_EDITING_PROCESSOR_ID });
    expect(added[0]!.content).toContain('purpose="edit" languages="mermaid"');
    expect(added[0]!.content).toContain("Mermaid 语法只认半角");
    expect(added[0]!.content).not.toContain("未压缩明文 mxGraph XML");
  });

  it("LLM detector 默认走当前 flash 解析,并沿用请求级 key/baseURL/模型别名", () => {
    const requestContext = new RequestContext([
      [
        "modelOverrides",
        {
          visitorApiKey: "visitor-key",
          baseUrl: "https://proxy.example.com/openai/chat/completions",
          modelIds: { flash: "custom-flash" },
        },
      ],
    ]);

    expect(resolveQingagentGuardrailModel(requestContext as unknown as RequestContext)).toEqual({
      id: "deepseek/custom-flash",
      url: "https://proxy.example.com/openai/v1",
      apiKey: "visitor-key",
    });
  });

  it("LLM detector 在 pro 档解析到 pro 模型", () => {
    const requestContext = new RequestContext([
      [
        "modelOverrides",
        {
          visitorApiKey: "visitor-key",
          tier: "pro",
          modelIds: { flash: "custom-flash", pro: "custom-pro" },
        },
      ],
    ]);

    expect(resolveQingagentGuardrailModel(requestContext as unknown as RequestContext)).toMatchObject({
      id: "deepseek/custom-pro",
      apiKey: "visitor-key",
    });
  });
});

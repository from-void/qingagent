import { afterEach, describe, expect, it, vi } from "vitest";
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
  markDiagramVizEditing,
} from "../skills/diagramViz.js";
import {
  diagramVizEditingSourceFromRequestContext,
  wrapModelWithDiagramVizEditing,
} from "../llm/diagramVizEditingPrompt.js";

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
  it("默认启用 UnicodeNormalizer、BatchParts 与工具回放输出守卫", () => {
    resetProcessorEnv();

    expect(processorIds(buildQingagentInputProcessors())).toEqual([
      "unicode-normalizer",
    ]);
    expect(processorIds(buildQingagentOutputProcessors())).toEqual([
      "batch-parts",
      "tool-transcript-output-guard",
    ]);
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

  it("UnicodeNormalizer 只清理协议控制字符并保留多行结构与 Unicode 正文", async () => {
    resetProcessorEnv();
    const [normalizer] = buildQingagentInputProcessors();
    const input = [
      "\u0000① 版本：ＡＢＣ",
      "yaml:",
      "  root:",
      "    child:\tvalue",
      "",
      "```ts",
      "  const marker = \"①\";",
      "```",
      "\u0008",
    ].join("\r\n");
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
    const expected = input.replace(/[\u0000\u0008]/g, "");
    expect(text).toBe(expected);
    expect(output[0]!.content.content).toBe(expected);
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
      "qingagent-input-llm-guardrails",
    ]);
    expect(processorIds(buildQingagentOutputProcessors())).toEqual([
      "batch-parts",
      "tool-transcript-output-guard",
    ]);

    resetProcessorEnv();
    process.env[QINGAGENT_PROCESSOR_ENV.pii] = "true";
    expect(processorIds(buildQingagentInputProcessors())).toEqual([
      "unicode-normalizer",
      "qingagent-input-llm-guardrails",
    ]);
    expect(processorIds(buildQingagentOutputProcessors())).toEqual([
      "batch-parts",
      "tool-transcript-output-guard",
      "qingagent-output-llm-guardrails",
    ]);

    resetProcessorEnv();
    process.env[QINGAGENT_PROCESSOR_ENV.moderation] = "on";
    expect(processorIds(buildQingagentInputProcessors())).toEqual([
      "unicode-normalizer",
      "qingagent-input-llm-guardrails",
    ]);
    expect(processorIds(buildQingagentOutputProcessors())).toEqual([
      "batch-parts",
      "tool-transcript-output-guard",
      "qingagent-output-llm-guardrails",
    ]);
  });

  it("图表编辑包装器只在 RequestContext 标记后向 provider prompt 尾部注入 user 消息", async () => {
    resetProcessorEnv();
    const requestContext = new RequestContext();
    const seenPrompts: Array<Array<{ role: string; content: unknown }>> = [];
    const baseModel = {
      async doGenerate(options: { prompt?: unknown }) {
        seenPrompts.push(options.prompt as Array<{ role: string; content: unknown }>);
        return { content: [], finishReason: "stop", usage: {}, warnings: [] };
      },
      async doStream(options: { prompt?: unknown }) {
        seenPrompts.push(options.prompt as Array<{ role: string; content: unknown }>);
        return { stream: new ReadableStream() };
      },
    };
    const wrapped = wrapModelWithDiagramVizEditing(
      baseModel,
      diagramVizEditingSourceFromRequestContext(requestContext),
    );
    const originalPrompt = [{ role: "user", content: "请修改图表" }];

    await wrapped.doGenerate({ prompt: originalPrompt });
    expect(seenPrompts[0]).toBe(originalPrompt);

    markDiagramVizEditing(requestContext, ["mermaid"]);
    await wrapped.doGenerate({ prompt: originalPrompt });
    await wrapped.doStream({ prompt: originalPrompt });

    for (const prompt of seenPrompts.slice(1)) {
      expect(prompt).toHaveLength(2);
      expect(prompt.at(-1)?.role).toBe("user");
      const content = JSON.stringify(prompt.at(-1)?.content);
      expect(content).toContain('purpose=\\"edit\\" languages=\\"mermaid\\"');
      expect(content).toContain("Mermaid 语法只认半角");
      expect(content).not.toContain("未压缩明文 mxGraph XML");
    }
  });

  it("图表编辑注入解析失败时跳过注入并继续调用 provider", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const baseModel = {
      async doGenerate(options: { prompt?: unknown }) {
        return { options };
      },
      async doStream(options: { prompt?: unknown }) {
        return { options };
      },
    };
    const wrapped = wrapModelWithDiagramVizEditing(baseModel, () => {
      throw new Error("diagram-viz 资源标记漂移");
    });
    const originalPrompt = [{ role: "user", content: "继续编辑" }];

    await expect(wrapped.doGenerate({ prompt: originalPrompt })).resolves.toMatchObject({
      options: { prompt: originalPrompt },
    });
    await expect(wrapped.doStream({ prompt: originalPrompt })).resolves.toMatchObject({
      options: { prompt: originalPrompt },
    });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      "[diagram-viz] 图表编辑注入警告",
      expect.objectContaining({
        kind: "resolver-failed",
        message: "diagram-viz 资源标记漂移",
      }),
    );
    warnSpy.mockRestore();
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

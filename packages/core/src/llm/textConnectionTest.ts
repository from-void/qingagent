import { RequestContext } from "@mastra/core/request-context";
import { streamText } from "ai";
import {
  getDeepseekModel,
  MODEL_OVERRIDES_CONTEXT_KEY,
  type ModelProtocol,
} from "./modelConfig.js";

export interface TextConnectionTestInput {
  apiKey: string;
  baseUrl: string;
  model: string;
  protocol: ModelProtocol;
  timeoutMs?: number;
}

/** 自定义文本模型真实 messages 连通测试；经模型工厂中间件自动记录 usage/missing。 */
export async function testTextModelConnection(input: TextConnectionTestInput): Promise<void> {
  const requestContext = new RequestContext([
    [MODEL_OVERRIDES_CONTEXT_KEY, {
      visitorApiKey: input.apiKey,
      baseUrl: input.baseUrl,
      protocol: input.protocol,
      modelIds: { flash: input.model },
    }],
    ["sessionId", "model-settings"],
    ["runId", `connection-test:${Date.now()}`],
  ] as never);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 12_000);
  try {
    const result = streamText({
      model: getDeepseekModel(requestContext, "flash", { callSite: "anthropicConnectionTest" }),
      prompt: "hi",
      maxTokens: 4,
      maxRetries: 0,
      toolChoice: "none",
      abortSignal: controller.signal,
      ...(input.protocol === "anthropic"
        ? { providerOptions: { anthropic: { thinking: { type: "disabled" } } } }
        : {}),
    });
    for await (const part of result.fullStream) {
      if (part.type === "error") {
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

import { RequestContext } from "@mastra/core/request-context";
import { streamText } from "ai-v5";
import {
  getDeepseekModel,
  MODEL_OVERRIDES_CONTEXT_KEY,
  type ModelProvider,
  type ModelProtocol,
} from "./modelConfig.js";

export interface TextConnectionTestInput {
  provider?: ModelProvider;
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
      provider: input.provider ?? "deepseek",
      visitorApiKey: input.apiKey,
      baseUrl: input.baseUrl,
      protocol: input.protocol,
      modelIds: { flash: input.model },
    }],
    ["sessionId", "model-settings"],
    ["runId", `connection-test:${Date.now()}`],
  ] as never);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Text connection test timed out", "TimeoutError")),
    input.timeoutMs ?? 12_000,
  );
  try {
    const result = streamText({
      // 保留既有 callSite，避免 DeepSeek usage 维度和覆盖矩阵发生兼容性变化。
      model: getDeepseekModel(requestContext, "flash", { callSite: "anthropicConnectionTest" }),
      prompt: "hi",
      maxOutputTokens: 4,
      maxRetries: 0,
      toolChoice: "none",
      abortSignal: controller.signal,
      ...(input.protocol === "anthropic"
        ? { providerOptions: { anthropic: { thinking: { type: "disabled" } } } }
        : {}),
    });
    for await (const part of result.fullStream) {
      if (part.type === "error") {
        controller.signal.throwIfAborted();
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
      if (part.type === "abort") {
        controller.signal.throwIfAborted();
        throw new DOMException("Text connection test aborted", "AbortError");
      }
    }
    controller.signal.throwIfAborted();
  } finally {
    clearTimeout(timer);
  }
}

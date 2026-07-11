import type { RequestContext } from "@mastra/core/request-context";
import { streamText, type CoreMessage } from "ai";
import { getDeepseekModel, resolveProtocol, type DeepseekTier } from "./modelConfig.js";

export interface InnerModelStreamCall {
  requestContext?: RequestContext;
  callSite: string;
  lane?: number | null;
  attempt?: number;
  tier?: DeepseekTier;
  system?: string;
  prompt?: string;
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  thinking: boolean;
  temperature: number;
  abortSignal?: AbortSignal;
  maxRetries?: number;
  maxTokens?: number;
  onContentStart?: (elapsedMs: number) => void;
  onContentDelta?: (delta: string, raw: string) => void;
}

export interface InnerModelStreamResult {
  raw: string;
  contentStartMs: number | null;
  finishReason: string | null;
}

/** AI SDK 流式适配层：只做文本累积/进度回调，传输、协议、重试、usage 均交给框架与模型工厂。 */
export async function streamInnerModel(input: InnerModelStreamCall): Promise<InnerModelStreamResult> {
  const startedAt = Date.now();
  const protocol = resolveProtocol(input.requestContext);
  const result = streamText({
    model: getDeepseekModel(input.requestContext, input.tier ?? "flash", {
      callSite: input.callSite,
      lane: input.lane,
      attempt: input.attempt,
      thinking: input.thinking,
    }),
    ...(input.messages
      ? { messages: input.messages as CoreMessage[] }
      : { system: input.system ?? "", prompt: input.prompt ?? "" }),
    ...(input.thinking ? {} : { temperature: input.temperature }),
    ...(protocol === "anthropic"
      ? { providerOptions: { anthropic: {
          thinking: input.thinking
            ? { type: "enabled", budgetTokens: 2048 }
            : { type: "disabled" },
        } } }
      : {}),
    abortSignal: input.abortSignal,
    maxRetries: input.maxRetries,
    maxTokens: input.maxTokens,
  });

  let raw = "";
  let contentStartMs: number | null = null;
  let finishReason: string | null = null;
  for await (const part of result.fullStream) {
    if (part.type === "error") {
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
    if (part.type === "finish") {
      finishReason = part.finishReason;
      continue;
    }
    if (part.type !== "text-delta" || !part.textDelta) continue;
    if (contentStartMs === null) {
      contentStartMs = Date.now() - startedAt;
      input.onContentStart?.(contentStartMs);
    }
    raw += part.textDelta;
    input.onContentDelta?.(part.textDelta, raw);
  }
  return { raw, contentStartMs, finishReason };
}

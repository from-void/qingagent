import type { RequestContext } from "@mastra/core/request-context";
import { streamText, type CoreMessage } from "ai";
import {
  branchCall,
  getDeepseekModel,
  getSessionSnapshot,
  resolveProtocol,
  type BranchMessage,
  type DeepseekTier,
} from "./modelConfig.js";

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
  /** 有主链快照时优先借道；失败则原样回退下面的 streamText 请求。 */
  branchSteeringTail?: string | BranchMessage[];
}

export interface InnerModelStreamResult {
  raw: string;
  contentStartMs: number | null;
  finishReason: string | null;
}

/** AI SDK 流式适配层：只做文本累积/进度回调，传输、协议、重试、usage 均交给框架与模型工厂。 */
export async function streamInnerModel(input: InnerModelStreamCall): Promise<InnerModelStreamResult> {
  const startedAt = Date.now();
  const snapshot = input.branchSteeringTail ? getSessionSnapshot(input.requestContext) : null;
  let branchAttempts = 0;
  if (snapshot && input.branchSteeringTail) {
    let contentStartMs: number | null = null;
    const branched = await branchCall({
      sessionSnapshot: snapshot,
      steeringTail: input.branchSteeringTail,
      callSite: input.callSite,
      requestContext: input.requestContext,
      lane: input.lane,
      attempt: input.attempt,
      abortSignal: input.abortSignal,
      streamTextDeltas: true,
      thinking: input.thinking,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      onActivity: () => {
        if (contentStartMs === null) {
          contentStartMs = Date.now() - startedAt;
          input.onContentStart?.(contentStartMs);
        } else {
          input.onContentStart?.(contentStartMs);
        }
      },
      onTextDelta: (delta, raw) => {
        if (contentStartMs === null) {
          contentStartMs = Date.now() - startedAt;
          input.onContentStart?.(contentStartMs);
        }
        input.onContentDelta?.(delta, raw);
      },
    });
    branchAttempts = branched.attempts;
    if (branched.ok) {
      return { raw: branched.text, contentStartMs, finishReason: branched.finishReason };
    }
    if (input.abortSignal?.aborted) {
      throw input.abortSignal.reason instanceof Error
        ? input.abortSignal.reason
        : new DOMException("Inner model branch aborted", "AbortError");
    }
  }
  const protocol = resolveProtocol(input.requestContext);
  const result = streamText({
    model: getDeepseekModel(input.requestContext, input.tier ?? "flash", {
      callSite: input.callSite,
      lane: input.lane,
      attempt: input.requestContext || input.attempt == null
        ? undefined
        : input.attempt + branchAttempts,
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

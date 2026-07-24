import type { RequestContext } from "@mastra/core/request-context";
import type { ModelMessage } from "ai-v5";
import { streamText } from "./streamTextCompat.js";
import {
  branchCall,
  DEFAULT_BRANCH_STREAM_BUFFER_BYTES,
  getDeepseekModel,
  getSessionSnapshot,
  resolveModelParams,
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
  topP?: number;
  abortSignal?: AbortSignal;
  maxRetries?: number;
  maxTokens?: number;
  /** 分支验真前允许缓存的文本字节数，缺省使用安全上限。 */
  maxBufferedTextBytes?: number;
  /** 每次上游流有活动时触发；与只触发一次的内容启动事件分离。 */
  onActivity?: () => void;
  onContentStart?: (elapsedMs: number, observedAt?: number) => void;
  onContentDelta?: (delta: string, raw: string, observedAt?: number) => void;
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
  const overrides = resolveModelParams(input.requestContext);
  const temperature = overrides.temperature ?? input.temperature;
  const topP = overrides.topP ?? input.topP;
  const maxTokens = overrides.maxOutputTokens ?? input.maxTokens;
  const snapshot = input.branchSteeringTail ? getSessionSnapshot(input.requestContext) : null;
  let branchAttempts = 0;
  let contentStartMs: number | null = null;
  const markContentStarted = (observedAt?: number) => {
    if (contentStartMs !== null) return;
    const detectedAt = observedAt ?? Date.now();
    contentStartMs = detectedAt - startedAt;
    input.onContentStart?.(contentStartMs, observedAt);
  };
  if (snapshot && input.branchSteeringTail) {
    // SIDECHANNEL_PHASE2_EXEMPT: fallback attempt 必须叠加 branch attempts；统一入口当前不暴露该计数。
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
      temperature,
      topP,
      maxTokens,
      maxBufferedTextBytes: input.maxBufferedTextBytes ?? DEFAULT_BRANCH_STREAM_BUFFER_BYTES,
      onActivity: () => {
        input.onActivity?.();
      },
      onRawContentStart: (observedAt) => {
        markContentStarted(observedAt);
      },
      onTextDelta: (delta, raw, observedAt) => {
        input.onContentDelta?.(delta, raw, observedAt);
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
    console.warn(
      `[sideChannel] site=${input.callSite} fallback engaged reason=${branched.reason} snapshot=true`,
    );
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
      ? { messages: input.messages as ModelMessage[] }
      : { system: input.system ?? "", prompt: input.prompt ?? "" }),
    ...(input.thinking ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(protocol === "anthropic"
      ? { providerOptions: { anthropic: {
          thinking: input.thinking
            ? { type: "enabled", budgetTokens: 2048 }
            : { type: "disabled" },
        } } }
      : {}),
    abortSignal: input.abortSignal,
    maxRetries: input.maxRetries,
    maxOutputTokens: maxTokens,
  });

  let raw = "";
  let finishReason: string | null = null;
  for await (const part of result.fullStream) {
    input.onActivity?.();
    if (part.type === "error") {
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
    if (part.type === "finish") {
      finishReason = part.finishReason;
      continue;
    }
    if (part.type !== "text-delta" || !part.text) continue;
    markContentStarted();
    raw += part.text;
    input.onContentDelta?.(part.text, raw);
  }
  return { raw, contentStartMs, finishReason };
}

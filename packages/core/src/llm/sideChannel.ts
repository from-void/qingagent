import type { RequestContext } from "@mastra/core/request-context";
import {
  branchCall,
  getSessionSnapshot,
  type BranchCallInput,
  type BranchCallResult,
  type BranchMessage,
} from "./modelConfig.js";

export type SideChannelFailure =
  | Exclude<BranchCallResult, { ok: true }>["reason"]
  | "snapshot_unavailable"
  | "parse_failed";

export interface RunSideChannelInput<T> {
  callSite: string;
  requestContext?: RequestContext;
  steeringTail: string | BranchMessage[];
  parse: (text: string, context: { finishReason: string | null }) => T | null;
  /**
   * 降级若需要请求模型，必须走 AI SDK generateText/streamText 或项目既有模型包装，
   * 以便自动进入 usage 账本；禁止在 fallback 内自行发送 HTTP。
   */
  fallback: (reason: SideChannelFailure) => Promise<T>;
  streamTextDeltas?: boolean;
  /** 边读边交 delta,不等验真。仅出题这类「半成品可露出、失败被整体覆盖」的调用点可开。 */
  liveTextDeltas?: boolean;
  onTextDelta?: BranchCallInput["onTextDelta"];
  onActivity?: BranchCallInput["onActivity"];
  lane?: number | null;
  abortSignal?: AbortSignal;
  thinking?: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export interface RunSideChannelResult<T> {
  value: T;
  transport: "branch" | "fallback";
  branchFailure: SideChannelFailure | null;
  toolCallRetries: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Side channel aborted", "AbortError");
}

/** 旁支生成统一入口：快照、借道、失败归一、日志与降级编排均由此处负责。 */
export async function runSideChannel<T>(
  input: RunSideChannelInput<T>,
): Promise<RunSideChannelResult<T>> {
  throwIfAborted(input.abortSignal);
  const snapshot = getSessionSnapshot(input.requestContext);
  let failure: SideChannelFailure = "snapshot_unavailable";
  let toolCallRetries = 0;

  if (snapshot) {
    const result = await branchCall({
      sessionSnapshot: snapshot,
      steeringTail: input.steeringTail,
      callSite: input.callSite,
      requestContext: input.requestContext,
      lane: input.lane,
      abortSignal: input.abortSignal,
      streamTextDeltas: input.streamTextDeltas,
      liveTextDeltas: input.liveTextDeltas,
      onTextDelta: input.onTextDelta,
      onActivity: input.onActivity,
      thinking: input.thinking,
      temperature: input.temperature,
      topP: input.topP,
      maxTokens: input.maxTokens,
    });
    throwIfAborted(input.abortSignal);
    toolCallRetries = result.toolCallRetries;
    if (result.ok) {
      const value = input.parse(result.text, { finishReason: result.finishReason });
      if (value !== null) {
        return { value, transport: "branch", branchFailure: null, toolCallRetries };
      }
      failure = "parse_failed";
    } else {
      failure = result.reason;
    }
  }

  console.warn(
    `[sideChannel] site=${input.callSite} fallback engaged reason=${failure} snapshot=${!!snapshot}`,
  );
  throwIfAborted(input.abortSignal);
  const value = await input.fallback(failure);
  throwIfAborted(input.abortSignal);
  return { value, transport: "fallback", branchFailure: failure, toolCallRetries };
}

// F1 统一模型配置层:所有 DeepSeek 调用(主 Agent + 工具内层 streamText)从这里取
// baseURL / model / apiKey / 采样参数,不再各自读 env。
//
// key 解析采用两层模型(产品决策):
//   visitor   —— 访客在浏览器里填的 key,存前端 localStorage,随请求 header 透传,
//                服务端不落盘;经 RequestContext("modelOverrides") 进入本层。
//   global-db —— 站点管理员在设置页保存的全局兜底 key(app_settings 表)。
//   env       —— DEEPSEEK_API_KEY 环境变量,最终兜底(空输入走默认,不改默认值)。
// 优先级:visitor > global-db > env。
//
// env 层不止 key:整套"默认模型 endpoint"都可由 env 兜底配置(给共享 .env / 多 worktree 用)——
//   DEEPSEEK_API_KEY        —— key
//   QINGAGENT_DEEPSEEK_BASE_URL —— baseURL(其他厂商/中转,如 GLM)
//   QINGAGENT_MODEL_PROTOCOL —— anthropic | openai(GLM Coding 走 anthropic)
//   QINGAGENT_MODEL_FLASH / QINGAGENT_MODEL_PRO —— 模型名(GLM 用 glm-* 而非 deepseek-*)
// 这样把 GLM 配置只写进共享 .env,新建 worktree 即自动生效;访客在浏览器里的自定义 endpoint
// 仍以更高优先级覆盖它(env 只是该机/该 worktree 的默认底座)。

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { wrapLanguageModel, type LanguageModel } from "ai-v5";
import type { RequestContext } from "@mastra/core/request-context";
import { Buffer } from "node:buffer";
import { validateFetchUrl } from "@qingagent/doc-render/browser";
export {
  DEEPSEEK_BASE_URL,
  MODEL_OVERRIDES_CONTEXT_KEY,
  resolveBaseUrl,
  sanitizeBaseUrl,
} from "./modelBaseUrl.js";
import { MODEL_OVERRIDES_CONTEXT_KEY, resolveBaseUrl, sanitizeBaseUrl } from "./modelBaseUrl.js";
import { createUsageMiddleware, recordUsageOutcome } from "./usageMiddleware.js";
import { observeCacheOutcome } from "./cacheEfficiencySentinel.js";
import { modelFetch } from "./modelTransport.js";
import { normalizeLlmUsageCounts } from "./usageAccounting.js";
import { nextUsageAttempt } from "./usageAttempt.js";
import {
  BRANCH_SNAPSHOT_EPOCH_CONTEXT_KEY,
  BRANCH_SNAPSHOT_GENERATION_CONTEXT_KEY,
  BRANCH_SNAPSHOT_LEASE_CONTEXT_KEY,
  createBranchSnapshotFetch,
  ownsSessionSnapshotLease,
  sessionSnapshotAuthFingerprint,
  type BranchMessage,
  type SessionSnapshot,
} from "./sessionSnapshots.js";
export {
  advanceSessionSnapshotEpoch,
  beginSessionSnapshotTurn,
  clearSessionSnapshot,
  getSessionSnapshot,
  type BranchMessage,
  type SessionSnapshot,
} from "./sessionSnapshots.js";
import type { ApiKeyOrigin } from "./modelTypes.js";
export type { ApiKeyOrigin } from "./modelTypes.js";

type InnerLanguageModel = Exclude<LanguageModel, string>;

/** 分支响应在验真前的默认内存上限，同时约束尚未完整分帧的原始 SSE 缓冲。 */
export const DEFAULT_BRANCH_STREAM_BUFFER_BYTES = 4 * 1024 * 1024;

/** 主 Agent 的 v2 provider：与 Mastra 1.49 内部使用同版 serializer，只注入快照 fetch。 */
export function createSnapshottingQingagentModel(
  requestContext?: RequestContext,
): InnerLanguageModel {
  const { apiKey } = resolveDeepseekAuth(requestContext);
  // 不强加 includeUsage：实测主链原始 body 没有 stream_options，DeepSeek 仍会在尾帧返回 usage；
  // 这里改变 body 会破坏已经验证过的 provider wire 前缀一致性。
  const provider = createOpenAICompatible({
    name: "deepseek",
    baseURL: resolveBaseUrl(requestContext),
    apiKey,
    fetch: createBranchSnapshotFetch(requestContext, apiKey, validateWireMessages),
    // deepseek-v4-flash 拒绝 json_schema；schema 请求降为 json_object + 项目侧解析。
    supportsStructuredOutputs: false,
  });
  return provider.chatModel(resolveModelId(requestContext, "flash"));
}

export interface BranchCallInput {
  sessionSnapshot: SessionSnapshot;
  steeringTail: string | BranchMessage[];
  callSite: string;
  requestContext?: RequestContext;
  lane?: number | null;
  attempt?: number;
  abortSignal?: AbortSignal;
  onTextDelta?: (
    delta: string,
    accumulated: string,
    observedAt: number,
  ) => void | Promise<void>;
  /** 原始流首次出现正文 delta 时触发；只传时机，不代表文本已通过 tool/lease 验真。 */
  onRawContentStart?: (observedAt: number) => void | Promise<void>;
  /** 原始响应每次有网络活动即触发；不代表文本已通过 tool/lease 验真。 */
  onActivity?: () => void | Promise<void>;
  /** 验真通过后按 provider 原始粒度顺序回放文本 delta。 */
  streamTextDeltas?: boolean;
  thinking?: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** 分支验真前允许缓存的文本字节数；缺省使用安全上限。 */
  maxBufferedTextBytes?: number;
}

export type BranchCallResult =
  | {
      ok: true;
      text: string;
      assistantMessage: BranchMessage;
      finishReason: string | null;
      attempts: number;
      toolCallRetries: number;
    }
  | {
      ok: false;
      reason: "stale_snapshot" | "tool_call" | "provider_error" | "invalid_response" | "preflight_failed";
      attempts: number;
      toolCallRetries: number;
      error?: string;
    };

interface RawBranchResponse {
  text: string;
  textDeltas: Array<{ text: string; observedAt: number }>;
  firstTextAt: number | null;
  reasoning: string;
  toolCalled: boolean;
  usage: unknown;
  finishReason: string | null;
  providerError: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function extractRawChunk(payload: unknown, state: RawBranchResponse): string {
  const record = asRecord(payload);
  if (!record) return "";
  const error = asRecord(record.error);
  if (typeof error?.message === "string") state.providerError = error.message;
  if (record.usage) state.usage = record.usage;
  const choice = Array.isArray(record.choices) ? asRecord(record.choices[0]) : null;
  if (!choice) return "";
  if (typeof choice.finish_reason === "string") state.finishReason = choice.finish_reason;
  if (choice.finish_reason === "tool_calls") state.toolCalled = true;
  const delta = asRecord(choice.delta) ?? asRecord(choice.message);
  if (!delta) return "";
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) state.toolCalled = true;
  const textDelta = typeof delta.content === "string" ? delta.content : "";
  if (textDelta) state.text += textDelta;
  if (typeof delta.reasoning_content === "string") state.reasoning += delta.reasoning_content;
  return textDelta;
}

export async function readRawBranchResponse(
  response: Response,
  onActivity?: BranchCallInput["onActivity"],
  maxBufferedTextBytes = DEFAULT_BRANCH_STREAM_BUFFER_BYTES,
  onRawContentStart?: BranchCallInput["onRawContentStart"],
): Promise<RawBranchResponse> {
  const state: RawBranchResponse = {
    text: "",
    textDeltas: [],
    firstTextAt: null,
    reasoning: "",
    toolCalled: false,
    usage: null,
    finishReason: null,
    providerError: null,
  };
  let bufferedTextBytes = 0;
  const recordBufferedText = (delta: string) => {
    bufferedTextBytes += Buffer.byteLength(delta, "utf8");
    if (
      bufferedTextBytes > maxBufferedTextBytes
    ) {
      throw new Error("branch_stream_buffer_exceeded");
    }
  };
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    await onActivity?.();
    const delta = extractRawChunk(await response.json(), state);
    if (delta) {
      recordBufferedText(delta);
      const observedAt = Date.now();
      state.textDeltas.push({ text: delta, observedAt });
      state.firstTextAt = observedAt;
      await onRawContentStart?.(observedAt);
    }
    return state;
  }
  if (!response.body) throw new Error("provider_stream_missing_body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeEvent = async (event: string) => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;
    const delta = extractRawChunk(JSON.parse(data), state);
    if (delta) {
      try {
        recordBufferedText(delta);
      } catch (error) {
        try {
          await reader.cancel("branch_stream_buffer_exceeded");
        } catch {
          // 读取器取消失败不能遮蔽稳定的超限错误。
        }
        throw error;
      }
      const observedAt = Date.now();
      state.textDeltas.push({ text: delta, observedAt });
      if (state.firstTextAt === null) {
        state.firstTextAt = observedAt;
        await onRawContentStart?.(observedAt);
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (!done || value) await onActivity?.();
      buffer += decoder.decode(value, { stream: !done });
      if (Buffer.byteLength(buffer, "utf8") > maxBufferedTextBytes) {
        try {
          await reader.cancel("branch_stream_buffer_exceeded");
        } catch {
          // 读取器取消失败不能遮蔽稳定的超限错误。
        }
        throw new Error("branch_stream_buffer_exceeded");
      }
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary);
        const match = buffer.slice(boundary).match(/^(?:\r?\n){2}/);
        buffer = buffer.slice(boundary + (match?.[0].length ?? 2));
        await consumeEvent(event);
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (done) break;
    }
    if (buffer.trim()) await consumeEvent(buffer);
  } finally {
    reader.releaseLock();
  }
  return state;
}

function jsonArguments(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "{}";
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

/**
 * 捕获体来自不同 AI SDK/provider serializer 版本，历史 tool-call 字段可能使用
 * args/input/toolCallId 等内部表示。回放前统一成 OpenAI wire shape，并丢弃孤儿调用/结果。
 */
/**
 * wire 形态校验：返回第一处违规描述，合法返回 null。
 * 快照跨越 AI SDK 内部表示与 OpenAI wire 两个序列化世界——边界数据必须设卡：
 * 写入时校验让问题在发生那一步就报警，回放前 preflight 兜底省一次必败的网络往返。
 */
export function validateWireMessages(messages: unknown[]): string | null {
  const pendingToolIds = new Set<string>();
  for (let i = 0; i < messages.length; i += 1) {
    const m = asRecord(messages[i]);
    if (!m) return `messages[${i}] 非对象`;
    const role = m.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
      return `messages[${i}].role 非法:${String(role)}`;
    }
    if (role === "assistant" && m.tool_calls !== undefined) {
      if (!Array.isArray(m.tool_calls)) return `messages[${i}].tool_calls 非数组`;
      for (let j = 0; j < m.tool_calls.length; j += 1) {
        const call = asRecord(m.tool_calls[j]);
        const fn = call ? asRecord(call.function) : null;
        if (!call || typeof call.id !== "string" || !call.id || !fn) {
          return `messages[${i}].tool_calls[${j}] 结构缺失`;
        }
        if (typeof fn.name !== "string" || !fn.name) {
          return `messages[${i}].tool_calls[${j}].function.name 缺失`;
        }
        if (typeof fn.arguments !== "string") {
          return `messages[${i}].tool_calls[${j}].function.arguments 缺失`;
        }
        pendingToolIds.add(call.id);
      }
    }
    if (role === "tool") {
      if (typeof m.tool_call_id !== "string" || !m.tool_call_id) {
        return `messages[${i}].tool_call_id 缺失`;
      }
      if (!pendingToolIds.has(m.tool_call_id)) {
        return `messages[${i}] 孤儿 tool 结果:${m.tool_call_id}`;
      }
    }
  }
  return null;
}

export function normalizeReplayMessages(messages: unknown[]): BranchMessage[] {
  const normalized: BranchMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const source = asRecord(messages[index]);
    if (!source || typeof source.role !== "string") continue;
    if (source.role !== "assistant" || !Array.isArray(source.tool_calls)) {
      if (source.role !== "tool") normalized.push({ ...source } as BranchMessage);
      continue;
    }
    const followingTools: Array<Record<string, unknown>> = [];
    let cursor = index + 1;
    while (cursor < messages.length) {
      const tool = asRecord(messages[cursor]);
      if (tool?.role !== "tool") break;
      followingTools.push(tool);
      cursor += 1;
    }
    const toolsById = new Map<string, Record<string, unknown>>();
    for (const tool of followingTools) {
      const id = typeof tool.tool_call_id === "string"
        ? tool.tool_call_id
        : typeof tool.toolCallId === "string" ? tool.toolCallId : null;
      if (id) toolsById.set(id, tool);
    }
    const pairedCalls: Record<string, unknown>[] = [];
    const pairedIds = new Set<string>();
    for (const rawCall of source.tool_calls) {
      const call = asRecord(rawCall);
      const fn = asRecord(call?.function);
      const id = typeof call?.id === "string"
        ? call.id
        : typeof call?.toolCallId === "string" ? call.toolCallId : null;
      const name = typeof fn?.name === "string"
        ? fn.name
        : typeof call?.toolName === "string" ? call.toolName : null;
      if (!id || !name || !toolsById.has(id)) continue;
      pairedIds.add(id);
      pairedCalls.push({
        id,
        type: "function",
        function: {
          name,
          arguments: jsonArguments(fn?.arguments ?? call?.arguments ?? call?.args ?? call?.input),
        },
      });
    }
    const assistant = { ...source };
    if (pairedCalls.length > 0) assistant.tool_calls = pairedCalls;
    else delete assistant.tool_calls;
    if (assistant.content !== "" || pairedCalls.length > 0) {
      normalized.push(assistant as BranchMessage);
    }
    for (const tool of followingTools) {
      const id = typeof tool.tool_call_id === "string"
        ? tool.tool_call_id
        : typeof tool.toolCallId === "string" ? tool.toolCallId : null;
      if (!id || !pairedIds.has(id)) continue;
      normalized.push({
        ...tool,
        role: "tool",
        tool_call_id: id,
        content: typeof tool.content === "string" ? tool.content : jsonArguments(tool.content),
      } as BranchMessage);
    }
    index = cursor - 1;
  }
  return normalized;
}

async function providerErrorSummary(response: Response): Promise<string> {
  let message = "request rejected";
  try {
    const text = await response.text();
    const payload = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof payload.error?.message === "string") message = payload.error.message;
    else if (text.trim()) message = text.trim();
  } catch {
    // 保留稳定兜底，错误观测本身不能遮蔽降级。
  }
  return redactProviderError(`HTTP ${response.status}: ${message}`).slice(0, 200);
}

function streamErrorSummary(message: string): string {
  return redactProviderError(`HTTP 200 SSE: ${message}`).slice(0, 200);
}

/** 错误体只需短摘要；在截断前清除常见授权头、key 字段和 sk-* 裸 key。 */
function redactProviderError(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s"',;)}\]]+/gi, "$1 ***")
    .replace(/\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)["']?[^\s"',;)}\]]+/gi, "$1$2***")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "sk-***");
}

async function recordBranchUsage(
  input: BranchCallInput,
  usage: unknown,
  attempt: number,
  reason: string | null,
): Promise<void> {
  const { origin } = resolveDeepseekAuth(input.requestContext);
  const normalized = normalizeLlmUsageCounts(usage);
  const hitTokens = normalized?.promptCacheHitTokens;
  const missTokens = normalized?.promptCacheMissTokens;
  if (!reason && typeof hitTokens === "number" && typeof missTokens === "number") {
    void observeCacheOutcome({
      sessionId: input.sessionSnapshot.sessionId,
      callSite: input.callSite,
      hitTokens,
      missTokens,
    });
  }
  await recordUsageOutcome({
    sessionId: input.sessionSnapshot.sessionId,
    runId: (input.requestContext?.get("runId") as string | null | undefined) ?? null,
    callSite: input.callSite,
    modelId: resolveModelId(input.requestContext, "flash"),
    keyOrigin: origin,
    lane: input.lane ?? null,
    attempt,
    usage,
    reason,
  });
}

/**
 * 原始 body 回放器。保留主链 tools/tool_choice，规范化历史 tool 消息后 append 尾部。
 */
export async function branchCall(input: BranchCallInput): Promise<BranchCallResult> {
  const { apiKey } = resolveDeepseekAuth(input.requestContext);
  const contextGeneration = input.requestContext?.get(BRANCH_SNAPSHOT_GENERATION_CONTEXT_KEY);
  const contextEpoch = input.requestContext?.get(BRANCH_SNAPSHOT_EPOCH_CONTEXT_KEY);
  const contextLeaseId = input.requestContext?.get(BRANCH_SNAPSHOT_LEASE_CONTEXT_KEY);
  if (
    (typeof contextGeneration === "number" && contextGeneration !== input.sessionSnapshot.generation) ||
    (typeof contextEpoch === "number" && contextEpoch !== input.sessionSnapshot.epoch) ||
    (typeof contextLeaseId === "string" && contextLeaseId !== input.sessionSnapshot.leaseId)
  ) {
    return { ok: false, reason: "stale_snapshot", attempts: 0, toolCallRetries: 0 };
  }
  const ownsCurrentLease = () => ownsSessionSnapshotLease(input.sessionSnapshot);
  if (!ownsCurrentLease()) {
    return { ok: false, reason: "stale_snapshot", attempts: 0, toolCallRetries: 0 };
  }
  let baseBody: Record<string, unknown>;
  try {
    baseBody = JSON.parse(input.sessionSnapshot.bodyText) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "stale_snapshot", attempts: 0, toolCallRetries: 0 };
  }
  if (
    !Array.isArray(baseBody.messages) ||
    resolveProtocol(input.requestContext) !== "openai" ||
    baseBody.model !== resolveModelId(input.requestContext, "flash") ||
    !input.sessionSnapshot.endpoint.startsWith(resolveBaseUrl(input.requestContext).replace(/\/+$/, "")) ||
    input.sessionSnapshot.authFingerprint !==
      sessionSnapshotAuthFingerprint(apiKey, input.sessionSnapshot.endpoint, baseBody.model)
  ) {
    return { ok: false, reason: "stale_snapshot", attempts: 0, toolCallRetries: 0 };
  }
  const tail = typeof input.steeringTail === "string"
    ? [{ role: "user", content: input.steeringTail } satisfies BranchMessage]
    : input.steeringTail;
  for (let retry = 0; retry < 1; retry += 1) {
    // 两次 raw 请求之间也可能开始新主轮；迟到分支不能继续消费旧前缀。
    if (!ownsCurrentLease()) {
      return { ok: false, reason: "stale_snapshot", attempts: retry, toolCallRetries: retry };
    }
    const attempt = input.requestContext
      ? nextUsageAttempt(input.requestContext, input.callSite, input.lane)
      : (input.attempt ?? 1) + retry;
    const normalizedReplayMessages = normalizeReplayMessages(baseBody.messages);
    const replayMessages = [...normalizedReplayMessages, ...tail];
    const replayBytes = Buffer.byteLength(JSON.stringify(normalizedReplayMessages), "utf8");
    const tailBytes = Buffer.byteLength(JSON.stringify(tail), "utf8");
    {
      // 回放前 preflight:不合法就不发——省一次必败的网络往返,秒降级且日志可诊断。
      const violation = validateWireMessages(replayMessages);
      if (violation) {
        console.warn(`[branchCall] site=${input.callSite} preflight-fail: ${violation} → fallback(0ms)`);
        void recordBranchUsage(input, null, attempt, `preflight: ${violation}`.slice(0, 200));
        return { ok: false, reason: "preflight_failed", attempts: retry, toolCallRetries: retry, error: violation };
      }
    }
    const body = {
      ...baseBody,
      messages: replayMessages,
      stream: true,
      stream_options: { include_usage: true },
      // 定稿纪律(260712 spike):禁止 tool_choice:"none"——它会把 tools 块从渲染中移除,
      // 其后全部 messages 前缀错位 miss;工具抑制靠尾部指令(实测10/10),偶发 tool_call
      // 由 toolCalled 分支降级兜底。
      ...(typeof input.maxTokens === "number" ? { max_tokens: input.maxTokens } : {}),
      ...(input.thinking === undefined
        ? {}
        : { thinking: { type: input.thinking ? "enabled" : "disabled" } }),
      ...(!input.thinking && typeof input.temperature === "number"
        ? { temperature: input.temperature }
        : {}),
      ...(typeof input.topP === "number" ? { top_p: input.topP } : {}),
    };
    if (input.thinking) delete body.temperature;
    // 请求链路日志:一次借道一条起始行+一条终态行,量化时机与缓存(用户苛刻项)。
    const t0 = Date.now();
    let tFirstDelta = 0;
    console.log(
      `[branchCall] site=${input.callSite} start snapshot(gen=${input.sessionSnapshot.generation}` +
      ` epoch=${input.sessionSnapshot.epoch} age=${Date.now() - Date.parse(input.sessionSnapshot.capturedAt)}ms)` +
      ` msgs=${(baseBody.messages as unknown[]).length}+${tail.length}tail stream=${!!input.streamTextDeltas}` +
      ` replayBytes=${replayBytes} tailBytes=${tailBytes} attempt=${attempt}`,
    );
    try {
      const response = await modelFetch(input.sessionSnapshot.endpoint, {
        method: "POST",
        headers: {
          ...input.sessionSnapshot.safeHeaders,
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: input.abortSignal,
      });
      if (!response.ok) {
        const error = await providerErrorSummary(response);
        console.warn(`[branchCall] site=${input.callSite} provider-reject status=${response.status} latency=${Date.now() - t0}ms err=${error.slice(0, 120)}`);
        void recordBranchUsage(input, null, attempt, error);
        return {
          ok: false,
          reason: "provider_error",
          attempts: retry + 1,
          toolCallRetries: retry,
          error,
        };
      }
      // tool_call 与 lease 只有完整响应后才能确认；此前 delta 一律暂存，禁止污染草稿/SVG 进度。
      const raw = await readRawBranchResponse(
        response,
        input.onActivity,
        input.maxBufferedTextBytes ?? DEFAULT_BRANCH_STREAM_BUFFER_BYTES,
        input.onRawContentStart,
      );
      if (raw.firstTextAt !== null) {
        tFirstDelta = raw.firstTextAt;
        console.log(`[branchCall] site=${input.callSite} first-delta ttft=${tFirstDelta - t0}ms`);
      }
      if (raw.providerError) {
        const error = streamErrorSummary(raw.providerError);
        void recordBranchUsage(input, raw.usage, attempt, error);
        return { ok: false, reason: "provider_error", attempts: 1, toolCallRetries: 0, error };
      }
      void recordBranchUsage(input, raw.usage, attempt, null);
      {
        const u = asRecord(raw.usage);
        console.log(
          `[branchCall] site=${input.callSite} done latency=${Date.now() - t0}ms` +
          `${tFirstDelta ? ` ttft=${tFirstDelta - t0}ms` : ""}` +
          ` hit/miss=${u?.prompt_cache_hit_tokens ?? "?"}/${u?.prompt_cache_miss_tokens ?? "?"}` +
          ` replayBytes=${replayBytes} tailBytes=${tailBytes} attempt=${attempt}` +
          ` finish=${raw.finishReason ?? "?"} toolCalled=${raw.toolCalled}`,
        );
      }
      if (!ownsCurrentLease()) {
        return { ok: false, reason: "stale_snapshot", attempts: retry + 1, toolCallRetries: retry };
      }
      if (raw.toolCalled) {
        console.warn(`[branchCall] site=${input.callSite} tool_call-leak → fallback`);
        return { ok: false, reason: "tool_call", attempts: 1, toolCallRetries: 0 };
      }
      if (!raw.text) {
        return {
          ok: false,
          reason: "invalid_response",
          attempts: retry + 1,
          toolCallRetries: retry,
        };
      }
      if (input.abortSignal?.aborted) {
        return {
          ok: false,
          reason: "provider_error",
          attempts: retry + 1,
          toolCallRetries: retry,
          error: "provider_request_aborted",
        };
      }
      const replayDeltas = input.streamTextDeltas
        ? raw.textDeltas
        : [{ text: raw.text, observedAt: raw.firstTextAt ?? Date.now() }];
      let replayedText = "";
      for (const delta of replayDeltas) {
        if (!ownsCurrentLease()) {
          return { ok: false, reason: "stale_snapshot", attempts: retry + 1, toolCallRetries: retry };
        }
        if (input.abortSignal?.aborted) {
          return {
            ok: false,
            reason: "provider_error",
            attempts: retry + 1,
            toolCallRetries: retry,
            error: "provider_request_aborted",
          };
        }
        replayedText += delta.text;
        await input.onTextDelta?.(delta.text, replayedText, delta.observedAt);
        if (!ownsCurrentLease()) {
          return { ok: false, reason: "stale_snapshot", attempts: retry + 1, toolCallRetries: retry };
        }
        if (input.abortSignal?.aborted) {
          return {
            ok: false,
            reason: "provider_error",
            attempts: retry + 1,
            toolCallRetries: retry,
            error: "provider_request_aborted",
          };
        }
      }
      if (!ownsCurrentLease()) {
        return { ok: false, reason: "stale_snapshot", attempts: retry + 1, toolCallRetries: retry };
      }
      return {
        ok: true,
        text: raw.text,
        assistantMessage: {
          role: "assistant",
          content: raw.text,
          ...(raw.reasoning ? { reasoning_content: raw.reasoning } : {}),
        },
        finishReason: raw.finishReason,
        attempts: retry + 1,
        toolCallRetries: retry,
      };
    } catch (error) {
      const reason = input.abortSignal?.aborted || (error instanceof Error && error.name === "AbortError")
        ? "provider_request_aborted"
        : "provider_request_error";
      void recordBranchUsage(input, null, attempt, reason);
      return {
        ok: false,
        reason: "provider_error",
        attempts: retry + 1,
        toolCallRetries: retry,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { ok: false, reason: "tool_call", attempts: 1, toolCallRetries: 0 };
}

// env 层默认协议:QINGAGENT_MODEL_PROTOCOL=anthropic|openai(GLM Coding 走 anthropic)。
// 调用时读取(而非模块加载常量),便于 dotenv 时序与测试;非法值忽略 -> undefined。
function envModelProtocol(): ModelProtocol | undefined {
  const v = process.env.QINGAGENT_MODEL_PROTOCOL?.trim().toLowerCase();
  return v === "anthropic" || v === "openai" ? v : undefined;
}

export type DeepseekTier = "flash" | "pro";
export type ModelProtocol = "openai" | "anthropic";

/** 模型 id 单一来源。Flash 为默认档位,Pro 由请求档位显式选择。 */
export const DEEPSEEK_MODEL_IDS: Record<DeepseekTier, string> = {
  flash: "deepseek-v4-flash",
  pro: "deepseek-v4-pro",
};

/** 上下文窗口(tokens)。DeepSeek flash/pro 当前按 1M 估算口径展示,UI 标注"约"。 */
export const DEEPSEEK_CONTEXT_WINDOWS: Record<string, number> = {
  [DEEPSEEK_MODEL_IDS.flash]: 1_000_000,
  [DEEPSEEK_MODEL_IDS.pro]: 1_000_000,
};

export interface UsageTrackedModelOptions {
  /** 调用点可选以兼容仓外消费者；缺省仍留痕到 unknown。 */
  callSite?: string;
  /** 赛马 lane；同一包装模型内的 provider 请求 attempt 自动从 1 连续递增。 */
  lane?: number | null;
  /** 调用层已知的串行请求序号；省略时由同一包装模型自动递增。 */
  attempt?: number;
  /** DeepSeek OpenAI 兼容协议的 thinking 请求体开关；仅内层写稿链使用。 */
  thinking?: boolean;
}

/** 随 RequestContext 传入的本请求模型覆盖(由 server 在入口解析好)。 */
export interface ModelOverrides {
  /** 访客自带 key(visitor 层);为空表示本请求没有访客覆盖。 */
  visitorApiKey?: string;
  /** 设置页保存的全局兜底 key(global-db 层);server 入口从 app_settings 读出注入。 */
  globalApiKey?: string;
  /** 采样参数覆盖;字段缺省 = 不覆盖(走调用点各自默认)。 */
  params?: ModelParamOverrides;
  /** 自定义 baseURL(其他厂商/中转);缺省走 DEEPSEEK_BASE_URL。 */
  baseUrl?: string;
  /** 自定义模型别名(flash/pro);缺省走 DEEPSEEK_MODEL_IDS。 */
  modelIds?: { flash?: string; pro?: string };
  /** 当前模型档位;缺省 flash。只影响默认 flash 出口,显式请求 pro 仍走 pro。 */
  tier?: DeepseekTier;
  /** API 协议:openai(默认,DeepSeek/多数厂商)或 anthropic(智谱 GLM Coding 等)。 */
  protocol?: ModelProtocol;
  /** 图像识别副基模(多模态)独立配置;缺省=未配置。 */
  vision?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    protocol?: ModelProtocol;
  };
}

export interface ModelParamOverrides {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
}

export interface ResolvedDeepseekAuth {
  apiKey: string;
  origin: ApiKeyOrigin;
}

function readOverrides(requestContext?: RequestContext): ModelOverrides | undefined {
  const value = requestContext?.get(MODEL_OVERRIDES_CONTEXT_KEY);
  if (value && typeof value === "object") return value as ModelOverrides;
  return undefined;
}

/** 按 visitor > global-db > env 解析本请求实际使用的 key。 */
export function resolveDeepseekAuth(requestContext?: RequestContext): ResolvedDeepseekAuth {
  const overrides = readOverrides(requestContext);
  if (overrides?.visitorApiKey) {
    return { apiKey: overrides.visitorApiKey, origin: "visitor" };
  }
  if (overrides?.globalApiKey) {
    return { apiKey: overrides.globalApiKey, origin: "global-db" };
  }
  const envKey = process.env.DEEPSEEK_API_KEY ?? "";
  return { apiKey: envKey, origin: envKey ? "env" : "none" };
}

/** 本请求的采样参数覆盖;无覆盖时返回空对象,调用点用展开语法合并即可。 */
export function resolveModelParams(requestContext?: RequestContext): ModelParamOverrides {
  const params = readOverrides(requestContext)?.params;
  if (!params) return {};
  const out: ModelParamOverrides = {};
  // 显式逐字段拷贝:防止把 NaN/越界值透传给 provider。
  if (typeof params.temperature === "number" && Number.isFinite(params.temperature)) {
    out.temperature = Math.min(2, Math.max(0, params.temperature));
  }
  if (typeof params.topP === "number" && Number.isFinite(params.topP)) {
    out.topP = Math.min(1, Math.max(0, params.topP));
  }
  if (
    typeof params.maxOutputTokens === "number" &&
    Number.isInteger(params.maxOutputTokens) &&
    params.maxOutputTokens > 0
  ) {
    out.maxOutputTokens = params.maxOutputTokens;
  }
  return out;
}

/** 自定义模型别名:非空、长度受限、字符白名单,否则回退官方默认。 */
export function sanitizeModelId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value || value.length > 120) return undefined;
  if (!/^[A-Za-z0-9._:\/-]+$/.test(value)) return undefined;
  return value;
}

/** 当前请求选择的模型档位;非法/缺省均回退 fallback(默认 flash)。 */
export function resolveModelTier(
  requestContext?: RequestContext,
  fallback: DeepseekTier = "flash",
): DeepseekTier {
  const tier = readOverrides(requestContext)?.tier;
  return tier === "pro" || tier === "flash" ? tier : fallback;
}

/** 本请求生效的模型 id:访客自定义别名 > env 默认(QINGAGENT_MODEL_FLASH/_PRO) > 官方默认。
 *  访客自带 endpoint(baseUrl) 时不套用 env 模型名——那是给默认/env endpoint 的。 */
export function resolveModelId(requestContext?: RequestContext, tier: DeepseekTier = "flash"): string {
  const overrides = readOverrides(requestContext);
  const effectiveTier = tier === "flash" ? resolveModelTier(requestContext, tier) : tier;
  const visitor = sanitizeModelId(overrides?.modelIds?.[effectiveTier]);
  if (visitor) return visitor;
  if (!overrides?.baseUrl) {
    const envId = sanitizeModelId(
      effectiveTier === "flash" ? process.env.QINGAGENT_MODEL_FLASH : process.env.QINGAGENT_MODEL_PRO,
    );
    if (envId) return envId;
  }
  return DEEPSEEK_MODEL_IDS[effectiveTier];
}

/** Mastra ModelRouter 用模型 id(DeepSeek provider 前缀 + 当前档位模型名)。 */
export function resolveDeepseekRouterModelId(
  requestContext?: RequestContext,
  tier: DeepseekTier = "flash",
): `${string}/${string}` {
  return `deepseek/${resolveModelId(requestContext, tier)}` as `${string}/${string}`;
}

/** 本请求 API 协议:访客覆盖 > env 默认(QINGAGENT_MODEL_PROTOCOL) > openai。
 *  访客自带 endpoint(baseUrl) 时协议由访客决定(默认 openai),env 不介入,避免把 env 的
 *  anthropic 误套到访客的 openai endpoint 上。 */
export function resolveProtocol(requestContext?: RequestContext): ModelProtocol {
  const overrides = readOverrides(requestContext);
  if (overrides?.protocol === "anthropic") return "anthropic";
  if (overrides?.baseUrl) return "openai";
  return envModelProtocol() ?? "openai";
}

export interface ResolvedVisionConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  protocol: ModelProtocol;
}

export async function resolveVisionConfig(
  requestContext?: RequestContext,
): Promise<ResolvedVisionConfig | null> {
  const vision = readOverrides(requestContext)?.vision;
  const apiKey = vision?.apiKey?.trim();
  if (!apiKey) return null;
  const baseUrl = sanitizeBaseUrl(vision?.baseUrl);
  const model = sanitizeModelId(vision?.model);
  if (!baseUrl || !model) return null;
  const checkedUrl = await validateFetchUrl(baseUrl);
  return {
    apiKey,
    baseUrl: checkedUrl.toString().replace(/\/+$/, ""),
    model,
    protocol: vision?.protocol === "anthropic" ? "anthropic" : "openai",
  };
}

/** AI SDK 的 anthropic provider 只在 baseURL 后接 /messages,故 baseURL 需含 /vN;
 *  用户常按 Claude Code 习惯填到 /api/anthropic(不带 /v1),这里补齐。 */
export function anthropicBaseUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(b) ? b : `${b}/v1`;
}

/** 工具内层 streamText 用:按本请求协议 + key + baseURL 构建 provider(openai / anthropic)。 */
export function createDeepseekProvider(
  requestContext?: RequestContext,
  options: UsageTrackedModelOptions = {},
): (modelId: string) => InnerLanguageModel {
  const { apiKey } = resolveDeepseekAuth(requestContext);
  const baseUrl = resolveBaseUrl(requestContext);
  const requestFetch = options.thinking === undefined
    ? undefined
    : async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (typeof init?.body !== "string") return modelFetch(url, init);
        try {
          const body = JSON.parse(init.body) as Record<string, unknown>;
          body.thinking = { type: options.thinking ? "enabled" : "disabled" };
          if (options.thinking) delete body.temperature;
          return modelFetch(url, { ...init, body: JSON.stringify(body) });
        } catch {
          return modelFetch(url, init);
        }
      };
  const wrapModel = (model: InnerLanguageModel, modelId: string) => wrapLanguageModel({
    model,
    middleware: createUsageMiddleware({
      requestContext,
      callSite: options.callSite ?? "unknown",
      modelId,
      keyOrigin: resolveDeepseekAuth(requestContext).origin,
      lane: options.lane,
      attempt: options.attempt,
    }),
  });
  if (resolveProtocol(requestContext) === "anthropic") {
    const provider = createAnthropic({ baseURL: anthropicBaseUrl(baseUrl), apiKey, fetch: modelFetch });
    return (modelId) => wrapModel(provider(modelId), modelId);
  }
  const provider = createOpenAICompatible({
    name: "deepseek",
    baseURL: baseUrl,
    apiKey,
    includeUsage: true,
    // deepseek-v4-flash 拒绝 json_schema；schema 请求降为 json_object + 项目侧解析。
    supportsStructuredOutputs: false,
    fetch: requestFetch ?? modelFetch,
  });
  return (modelId) => wrapModel(provider.chatModel(modelId), modelId);
}

/** 工具内层取模型实例的捷径;默认出口受当前模型档位影响。 */
export function getDeepseekModel(
  requestContext?: RequestContext,
  tier: DeepseekTier = "flash",
  options: UsageTrackedModelOptions = {},
): InnerLanguageModel {
  return createDeepseekProvider(requestContext, options)(resolveModelId(requestContext, tier));
}

export async function getVisionModel(
  requestContext?: RequestContext,
  options: UsageTrackedModelOptions = {},
): Promise<InnerLanguageModel | null> {
  const config = await resolveVisionConfig(requestContext);
  if (!config) return null;
  const wrapModel = (model: InnerLanguageModel) => wrapLanguageModel({
    model,
    middleware: createUsageMiddleware({
      requestContext,
      callSite: options.callSite ?? "unknown",
      modelId: config.model,
      keyOrigin: "vision",
      lane: options.lane,
      attempt: options.attempt,
    }),
  });
  if (config.protocol === "anthropic") {
    return wrapModel(createAnthropic({
      baseURL: anthropicBaseUrl(config.baseUrl),
      apiKey: config.apiKey,
      fetch: modelFetch,
    })(config.model));
  }
  return wrapModel(createOpenAICompatible({
    name: "vision",
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    includeUsage: true,
    fetch: modelFetch,
  }).chatModel(config.model));
}

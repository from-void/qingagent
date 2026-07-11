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

import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { wrapLanguageModel, type LanguageModelV1 } from "ai";
import type { RequestContext } from "@mastra/core/request-context";
import { createHash, randomUUID } from "node:crypto";
import { validateFetchUrl } from "../browser/extractor.js";
import { recordUsageEvent } from "../db/usageRepo.js";
export {
  DEEPSEEK_BASE_URL,
  MODEL_OVERRIDES_CONTEXT_KEY,
  resolveBaseUrl,
  sanitizeBaseUrl,
} from "./modelBaseUrl.js";
import { MODEL_OVERRIDES_CONTEXT_KEY, resolveBaseUrl, sanitizeBaseUrl } from "./modelBaseUrl.js";
import { createUsageMiddleware } from "./usageMiddleware.js";
import { normalizeLlmUsageCounts } from "./usageAccounting.js";
import { nextUsageAttempt } from "./usageAttempt.js";

const BRANCH_SNAPSHOT_GENERATION_CONTEXT_KEY = "branchSnapshotGeneration";
const BRANCH_SNAPSHOT_EPOCH_CONTEXT_KEY = "branchSnapshotEpoch";
const BRANCH_SNAPSHOT_LEASE_CONTEXT_KEY = "branchSnapshotLease";
const MAX_SESSION_SNAPSHOTS = 256;
const SESSION_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

export type BranchMessage = Record<string, unknown> & {
  role: "system" | "user" | "assistant" | "tool";
};

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly streamId: string | null;
  readonly generation: number;
  readonly leaseId: string;
  readonly ordinal: number;
  readonly epoch: number;
  readonly capturedAt: string;
  readonly endpoint: string;
  readonly bodyText: string;
  readonly safeHeaders: Readonly<Record<string, string>>;
  readonly authFingerprint: string;
}

interface SnapshotRegistryEntry {
  activeGeneration: number;
  leaseId: string;
  nextOrdinal: number;
  epoch: number;
  touchedAt: number;
  snapshot: SessionSnapshot | null;
}

const sessionSnapshots = new Map<string, SnapshotRegistryEntry>();

function pruneSessionSnapshots(now = Date.now()): void {
  for (const [sessionId, entry] of sessionSnapshots) {
    if (now - entry.touchedAt > SESSION_SNAPSHOT_TTL_MS) sessionSnapshots.delete(sessionId);
  }
  while (sessionSnapshots.size > MAX_SESSION_SNAPSHOTS) {
    const oldest = sessionSnapshots.keys().next().value as string | undefined;
    if (!oldest) break;
    sessionSnapshots.delete(oldest);
  }
}

/** 每个主链 turn 先领取单调 generation；旧 turn 的迟到 fetch 不得覆盖新快照。 */
export function beginSessionSnapshotTurn(requestContext?: RequestContext): number | null {
  const sessionId = requestContext?.get("sessionId");
  if (typeof sessionId !== "string" || !sessionId) return null;
  pruneSessionSnapshots();
  const current = sessionSnapshots.get(sessionId);
  const generation = (current?.activeGeneration ?? 0) + 1;
  const entry: SnapshotRegistryEntry = {
    activeGeneration: generation,
    // 随机 lease 避免 clear/TTL 后 generation 从 1 重启形成 ABA。
    leaseId: randomUUID(),
    nextOrdinal: 0,
    epoch: current?.epoch ?? 0,
    touchedAt: Date.now(),
    snapshot: current?.snapshot ?? null,
  };
  sessionSnapshots.delete(sessionId);
  sessionSnapshots.set(sessionId, entry);
  requestContext?.set(BRANCH_SNAPSHOT_GENERATION_CONTEXT_KEY, generation);
  requestContext?.set(BRANCH_SNAPSHOT_EPOCH_CONTEXT_KEY, entry.epoch);
  requestContext?.set(BRANCH_SNAPSHOT_LEASE_CONTEXT_KEY, entry.leaseId);
  return generation;
}

export function getSessionSnapshot(
  source?: RequestContext | string | null,
): SessionSnapshot | null {
  const sessionId = typeof source === "string" ? source : source?.get("sessionId");
  if (typeof sessionId !== "string" || !sessionId) return null;
  const entry = sessionSnapshots.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.touchedAt > SESSION_SNAPSHOT_TTL_MS) {
    sessionSnapshots.delete(sessionId);
    return null;
  }
  const snapshot = entry.snapshot;
  // 新主轮已领取代际、但新的 provider fetch 尚未到达时，旧快照不能冒充当前轮。
  // 字符串调用方（如 askMore）也受 lease 约束，避免并发新轮开始后回放过期前缀。
  if (snapshot && (
    entry.activeGeneration !== snapshot.generation ||
    entry.epoch !== snapshot.epoch
  )) return null;
  if (typeof source !== "string" && source && snapshot) {
    const generation = source.get(BRANCH_SNAPSHOT_GENERATION_CONTEXT_KEY);
    const epoch = source.get(BRANCH_SNAPSHOT_EPOCH_CONTEXT_KEY);
    const leaseId = source.get(BRANCH_SNAPSHOT_LEASE_CONTEXT_KEY);
    if (typeof generation === "number" && snapshot.generation !== generation) return null;
    if (typeof epoch === "number" && snapshot.epoch !== epoch) return null;
    if (typeof leaseId === "string" && snapshot.leaseId !== leaseId) return null;
  }
  entry.touchedAt = Date.now();
  sessionSnapshots.delete(sessionId);
  sessionSnapshots.set(sessionId, entry);
  return snapshot;
}

export function clearSessionSnapshot(sessionId: string): void {
  sessionSnapshots.delete(sessionId);
}

/** OM 压缩边界推进 epoch；旧 body 不改写，但不再作为未来主轮的默认分支前缀。 */
export function advanceSessionSnapshotEpoch(sessionId: string): number {
  const entry = sessionSnapshots.get(sessionId);
  if (!entry) return 0;
  entry.epoch += 1;
  entry.snapshot = null;
  entry.touchedAt = Date.now();
  return entry.epoch;
}

function authFingerprint(apiKey: string, endpoint: string, modelId: unknown): string {
  return createHash("sha256")
    .update(`${apiKey}\0${endpoint}\0${String(modelId ?? "")}`)
    .digest("hex");
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const normalized = new Headers(headers);
  normalized.forEach((value, key) => {
    if (key === "authorization" || key === "x-api-key") return;
    out[key] = value;
  });
  return out;
}

function captureSessionSnapshot(
  requestContext: RequestContext | undefined,
  apiKey: string,
  url: RequestInfo | URL,
  init?: RequestInit,
): void {
  const sessionId = requestContext?.get("sessionId");
  const generation = requestContext?.get(BRANCH_SNAPSHOT_GENERATION_CONTEXT_KEY);
  const leaseId = requestContext?.get(BRANCH_SNAPSHOT_LEASE_CONTEXT_KEY);
  if (
    typeof sessionId !== "string" || !sessionId ||
    typeof generation !== "number" || typeof leaseId !== "string"
  ) return;
  if (typeof init?.body !== "string") return;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!Array.isArray(body.messages)) return;
  const entry = sessionSnapshots.get(sessionId);
  if (!entry || entry.activeGeneration !== generation || entry.leaseId !== leaseId) return;
  const endpoint = String(url);
  const ordinal = entry.nextOrdinal + 1;
  entry.nextOrdinal = ordinal;
  entry.touchedAt = Date.now();
  entry.snapshot = Object.freeze({
    sessionId,
    streamId: typeof requestContext?.get("streamId") === "string"
      ? requestContext.get("streamId") as string
      : null,
    generation,
    leaseId,
    ordinal,
    epoch: entry.epoch,
    capturedAt: new Date().toISOString(),
    endpoint,
    bodyText: init.body,
    safeHeaders: Object.freeze(headersToRecord(init.headers)),
    authFingerprint: authFingerprint(apiKey, endpoint, body.model),
  });
}

function createBranchSnapshotFetch(
  requestContext: RequestContext | undefined,
  apiKey: string,
): typeof fetch {
  return async (url, init) => {
    captureSessionSnapshot(requestContext, apiKey, url, init);
    return globalThis.fetch(url, init);
  };
}

/** 主 Agent 的 v2 provider：与 Mastra 1.49 内部使用同版 serializer，只注入快照 fetch。 */
export function createSnapshottingQingagentModel(
  requestContext?: RequestContext,
) {
  const { apiKey } = resolveDeepseekAuth(requestContext);
  // 不强加 includeUsage：实测主链原始 body 没有 stream_options，DeepSeek 仍会在尾帧返回 usage；
  // 这里改变 body 会破坏已经验证过的 provider wire 前缀一致性。
  const provider = createOpenAICompatible({
    name: "deepseek",
    baseURL: resolveBaseUrl(requestContext),
    apiKey,
    fetch: createBranchSnapshotFetch(requestContext, apiKey),
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
  onTextDelta?: (delta: string, accumulated: string) => void | Promise<void>;
  /** 原始响应每次有网络活动即触发；不代表文本已通过 tool/lease 验真。 */
  onActivity?: () => void | Promise<void>;
  /** 实时派发已解析的文本 delta；仅适合允许展示可撤销局部结果的 UI 消费方。 */
  streamTextDeltas?: boolean;
  thinking?: boolean;
  temperature?: number;
  maxTokens?: number;
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
      reason: "stale_snapshot" | "tool_call" | "provider_error" | "invalid_response";
      attempts: number;
      toolCallRetries: number;
      error?: string;
    };

interface RawBranchResponse {
  text: string;
  reasoning: string;
  toolCalled: boolean;
  usage: unknown;
  finishReason: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function extractRawChunk(payload: unknown, state: RawBranchResponse): void {
  const record = asRecord(payload);
  if (!record) return;
  if (record.usage) state.usage = record.usage;
  const choice = Array.isArray(record.choices) ? asRecord(record.choices[0]) : null;
  if (!choice) return;
  if (typeof choice.finish_reason === "string") state.finishReason = choice.finish_reason;
  if (choice.finish_reason === "tool_calls") state.toolCalled = true;
  const delta = asRecord(choice.delta) ?? asRecord(choice.message);
  if (!delta) return;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) state.toolCalled = true;
  if (typeof delta.content === "string") state.text += delta.content;
  if (typeof delta.reasoning_content === "string") state.reasoning += delta.reasoning_content;
}

async function readRawBranchResponse(
  response: Response,
  onTextDelta?: BranchCallInput["onTextDelta"],
  onActivity?: BranchCallInput["onActivity"],
): Promise<RawBranchResponse> {
  const state: RawBranchResponse = {
    text: "",
    reasoning: "",
    toolCalled: false,
    usage: null,
    finishReason: null,
  };
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    await onActivity?.();
    extractRawChunk(await response.json(), state);
    if (state.text && onTextDelta) await onTextDelta(state.text, state.text);
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
    const before = state.text.length;
    extractRawChunk(JSON.parse(data), state);
    const delta = state.text.slice(before);
    if (delta && onTextDelta) await onTextDelta(delta, state.text);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (!done || value) await onActivity?.();
    buffer += decoder.decode(value, { stream: !done });
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
  return `HTTP ${response.status}: ${message}`.slice(0, 200);
}

async function recordBranchUsage(
  input: BranchCallInput,
  usage: unknown,
  attempt: number,
  reason: string | null,
): Promise<void> {
  const normalized = normalizeLlmUsageCounts(usage);
  const hasUsage = !!normalized && Object.values(normalized).some((value) => typeof value === "number");
  const { origin } = resolveDeepseekAuth(input.requestContext);
  await recordUsageEvent({
    sessionId: input.sessionSnapshot.sessionId,
    runId: (input.requestContext?.get("runId") as string | null | undefined) ?? null,
    callSite: input.callSite,
    modelId: resolveModelId(input.requestContext, "flash"),
    keyOrigin: origin,
    lane: input.lane ?? null,
    attempt,
    ...(reason || !hasUsage
      ? { usageState: "missing" as const, reason: reason ?? "provider_usage_missing" }
      : {
          inputTokens: normalized?.inputTokens,
          outputTokens: normalized?.outputTokens,
          cacheHitTokens: normalized?.promptCacheHitTokens,
          cacheMissTokens: normalized?.promptCacheMissTokens,
          cacheCreationTokens: normalized?.promptCacheCreationTokens,
        }),
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
  const ownsCurrentLease = () => {
    const entry = sessionSnapshots.get(input.sessionSnapshot.sessionId);
    return entry?.snapshot === input.sessionSnapshot &&
      entry.activeGeneration === input.sessionSnapshot.generation &&
      entry.epoch === input.sessionSnapshot.epoch &&
      entry.leaseId === input.sessionSnapshot.leaseId;
  };
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
      authFingerprint(apiKey, input.sessionSnapshot.endpoint, baseBody.model)
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
    const body = {
      ...baseBody,
      messages: [...normalizeReplayMessages(baseBody.messages), ...tail],
      stream: true,
      stream_options: { include_usage: true },
      ...(typeof input.maxTokens === "number" ? { max_tokens: input.maxTokens } : {}),
      ...(input.thinking === undefined
        ? {}
        : { thinking: { type: input.thinking ? "enabled" : "disabled" } }),
      ...(!input.thinking && typeof input.temperature === "number"
        ? { temperature: input.temperature }
        : {}),
    };
    if (input.thinking) delete body.temperature;
    try {
      const response = await globalThis.fetch(input.sessionSnapshot.endpoint, {
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
        input.streamTextDeltas ? input.onTextDelta : undefined,
        input.onActivity,
      );
      void recordBranchUsage(input, raw.usage, attempt, null);
      if (!ownsCurrentLease()) {
        return { ok: false, reason: "stale_snapshot", attempts: retry + 1, toolCallRetries: retry };
      }
      if (raw.toolCalled) {
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
      if (!ownsCurrentLease()) {
        return { ok: false, reason: "stale_snapshot", attempts: retry + 1, toolCallRetries: retry };
      }
      if (!input.streamTextDeltas) await input.onTextDelta?.(raw.text, raw.text);
      if (!ownsCurrentLease() || input.abortSignal?.aborted) {
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

export type ApiKeyOrigin = "visitor" | "global-db" | "env" | "vision" | "none";

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
): (modelId: string) => LanguageModelV1 {
  const { apiKey } = resolveDeepseekAuth(requestContext);
  const baseUrl = resolveBaseUrl(requestContext);
  const requestFetch = options.thinking === undefined
    ? undefined
    : async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (typeof init?.body !== "string") return globalThis.fetch(url, init);
        try {
          const body = JSON.parse(init.body) as Record<string, unknown>;
          body.thinking = { type: options.thinking ? "enabled" : "disabled" };
          if (options.thinking) delete body.temperature;
          return globalThis.fetch(url, { ...init, body: JSON.stringify(body) });
        } catch {
          return globalThis.fetch(url, init);
        }
      };
  const wrapModel = (model: LanguageModelV1, modelId: string) => wrapLanguageModel({
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
    const provider = createAnthropic({ baseURL: anthropicBaseUrl(baseUrl), apiKey });
    return (modelId) => wrapModel(provider(modelId), modelId);
  }
  // strict 才会在流式请求中发送 stream_options.include_usage；compatible 默认不发，
  // DeepSeek/OpenAI 兼容网关会因此吞掉最终 usage。
  const provider = createOpenAI({
    baseURL: baseUrl,
    apiKey,
    compatibility: "strict",
    ...(requestFetch ? { fetch: requestFetch } : {}),
  });
  return (modelId) => wrapModel(provider(modelId), modelId);
}

/** 工具内层取模型实例的捷径;默认出口受当前模型档位影响。 */
export function getDeepseekModel(
  requestContext?: RequestContext,
  tier: DeepseekTier = "flash",
  options: UsageTrackedModelOptions = {},
) {
  return createDeepseekProvider(requestContext, options)(resolveModelId(requestContext, tier));
}

export async function getVisionModel(
  requestContext?: RequestContext,
  options: UsageTrackedModelOptions = {},
): Promise<LanguageModelV1 | null> {
  const config = await resolveVisionConfig(requestContext);
  if (!config) return null;
  const wrapModel = (model: LanguageModelV1) => wrapLanguageModel({
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
    return wrapModel(createAnthropic({ baseURL: anthropicBaseUrl(config.baseUrl), apiKey: config.apiKey })(config.model));
  }
  return wrapModel(createOpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    compatibility: "strict",
  })(config.model));
}

import { DEEPSEEK_MODEL_IDS } from "../llm/modelConfig.js";

export interface DeepseekDraftCall {
  system: string;
  user: string;
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  thinking: boolean;
  temperature: number;
  stream: boolean;
  abortSignal?: AbortSignal;
  onContentStart?: (elapsedMs: number) => void;
  onContentDelta?: (delta: string, raw: string) => void;
  maxRetries?: number;
  /** 最大输出 token 数；不传则交给上游默认。 */
  maxTokens?: number;
  /** 自定义 baseURL(缺省官方);形如 https://host/v1。 */
  baseUrl?: string;
  /** 自定义模型名(缺省 deepseek-v4-flash)。 */
  model?: string;
  /** 本请求实际 key(缺省读 env)。 */
  apiKey?: string;
  /** API 协议:openai(默认,/chat/completions)或 anthropic(/v1/messages,智谱 GLM Coding 等)。 */
  protocol?: "openai" | "anthropic";
  /** 每个真实 provider HTTP 请求完成后触发；包括重试、fallback、abort 与异常。 */
  onAttemptComplete?: (attempt: DeepseekDraftAttempt) => void | Promise<void>;
}

export interface DeepseekDraftUsage {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheCreationTokens: number;
}

export interface DeepseekDraftAttempt extends DeepseekDraftUsage {
  attempt: number;
  usageState: "recorded" | "missing";
  reason: string | null;
  protocol: "openai" | "anthropic";
  streaming: boolean;
}

export interface DeepseekDraftResult {
  raw: string;
  contentStartMs: number | null;
  finishReason: string | null;
  usage?: DeepseekDraftUsage;
}

interface DeepseekChatChoice {
  message?: {
    content?: string | null;
  };
  delta?: {
    reasoning_content?: string | null;
    content?: string | null;
  };
  finish_reason?: string | null;
}

interface DeepseekChatResponse {
  choices?: DeepseekChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

class UpstreamHttpError extends Error {
  constructor(
    readonly provider: "openai" | "anthropic",
    readonly status: number,
  ) {
    super(`${provider === "anthropic" ? "Anthropic" : "DeepSeek"} upstream HTTP ${status}`);
    this.name = "UpstreamHttpError";
  }
}

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const DEEPSEEK_DRAFT_MODEL = DEEPSEEK_MODEL_IDS.flash;

const JSON_SECRET_HEADER_RE = /(["'](?:authorization|x-api-key)["']\s*:\s*["'])(?:Bearer\s+)?[^"']+(["'])/gi;
const TEXT_SECRET_HEADER_RE = /\b(authorization|x-api-key)\b(\s*[:=]\s*)(?:Bearer\s+)?[^\s"',;}\]]+/gi;
const SK_TOKEN_RE = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/g;

export function redactSensitiveText(value: string): string {
  return value
    .replace(JSON_SECRET_HEADER_RE, "$1[REDACTED]$2")
    .replace(TEXT_SECRET_HEADER_RE, "$1$2[REDACTED]")
    .replace(SK_TOKEN_RE, "sk-[REDACTED]");
}

function completionsUrl(baseUrl?: string): string {
  return `${(baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    error instanceof Error && error.name === "AbortError"
  );
}

function resolveApiKey(explicit?: string): string {
  const apiKey = explicit?.trim() || process.env.DEEPSEEK_API_KEY || "";
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured");
  return apiKey;
}

function buildRequestBody(input: DeepseekDraftCall): Record<string, unknown> {
  return {
    model: input.model ?? DEEPSEEK_DRAFT_MODEL,
    messages: input.messages ?? [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    thinking: { type: input.thinking ? "enabled" : "disabled" },
    ...(input.thinking ? {} : { temperature: input.temperature }),
    ...(typeof input.maxTokens === "number" && Number.isFinite(input.maxTokens)
      ? { max_tokens: Math.max(1, Math.floor(input.maxTokens)) }
      : {}),
    stream: input.stream,
    ...(input.stream ? { stream_options: { include_usage: true } } : {}),
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function openAiUsage(json: DeepseekChatResponse): DeepseekDraftUsage | undefined {
  const usage = json.usage;
  if (!usage) return undefined;
  const inputTokens = count(usage.prompt_tokens);
  const cacheHitTokens = count(
    usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens,
  );
  return {
    inputTokens,
    outputTokens: count(usage.completion_tokens),
    cacheHitTokens,
    cacheMissTokens: count(usage.prompt_cache_miss_tokens ?? Math.max(0, inputTokens - cacheHitTokens)),
    cacheCreationTokens: 0,
  };
}

async function fetchDeepseek(input: DeepseekDraftCall): Promise<Response> {
  const response = await fetch(completionsUrl(input.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveApiKey(input.apiKey)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(buildRequestBody(input)),
    signal: input.abortSignal,
  });

  if (!response.ok) {
    throw new UpstreamHttpError("openai", response.status);
  }
  return response;
}

async function readNonStreaming(response: Response): Promise<DeepseekDraftResult> {
  const json = await response.json() as DeepseekChatResponse;
  const choice = json.choices?.[0];
  const raw = choice?.message?.content ?? "";
  return {
    raw,
    contentStartMs: raw ? 0 : null,
    finishReason: choice?.finish_reason ?? null,
    usage: openAiUsage(json),
  };
}

function resultFromChatJsonText(
  text: string,
  input: DeepseekDraftCall,
  startedAt: number,
): DeepseekDraftResult {
  const json = JSON.parse(text) as DeepseekChatResponse;
  const choice = json.choices?.[0];
  const raw = choice?.message?.content ?? "";
  let contentStartMs: number | null = null;
  if (raw) {
    contentStartMs = Date.now() - startedAt;
    input.onContentStart?.(contentStartMs);
    input.onContentDelta?.(raw, raw);
  }
  return { raw, contentStartMs, finishReason: choice?.finish_reason ?? null, usage: openAiUsage(json) };
}

async function readStreaming(
  response: Response,
  input: DeepseekDraftCall,
  startedAt: number,
): Promise<DeepseekDraftResult> {
  if (!response.body) throw new Error("DeepSeek streaming response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let received = "";
  let raw = "";
  let contentStartMs: number | null = null;
  let finishReason: string | null = null;
  let sawSseDataLine = false;
  let usage: DeepseekDraftUsage | undefined;

  const handleData = (data: string) => {
    sawSseDataLine = true;
    if (!data || data === "[DONE]") return;
    let json: DeepseekChatResponse;
    try {
      json = JSON.parse(data) as DeepseekChatResponse;
    } catch (error) {
      console.warn("[deepseekDraftClient] 跳过无法解析的 SSE data 行", {
        data: redactSensitiveText(data).slice(0, 500),
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const delta = json.choices?.[0]?.delta;
    usage = openAiUsage(json) ?? usage;
    const choiceFinishReason = json.choices?.[0]?.finish_reason;
    if (typeof choiceFinishReason === "string") finishReason = choiceFinishReason;
    const content = delta?.content;
    if (!content) return;
    if (contentStartMs === null) {
      contentStartMs = Date.now() - startedAt;
      input.onContentStart?.(contentStartMs);
    }
    raw += content;
    input.onContentDelta?.(content, raw);
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    received += chunk;
    buffer += chunk;
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    for (const event of events) {
      for (const line of event.split(/\r?\n/)) {
        if (line.startsWith("data:")) handleData(line.slice(5).trim());
      }
    }
  }

  const tail = buffer.trim();
  if (tail.startsWith("data:")) handleData(tail.slice(5).trim());
  const trimmed = received.trim();
  if (!sawSseDataLine && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    // 自定义 OpenAI 兼容端点有时忽略 stream:true,直接返回普通 JSON。
    // lane 仍按流式调度,这里把完整响应补成一次 delta,避免四路全废。
    return resultFromChatJsonText(trimmed, input, startedAt);
  }
  return { raw, contentStartMs, finishReason, usage };
}

// —— Anthropic 协议(智谱 GLM Coding 等):/v1/messages + x-api-key + content_block_delta SSE ——

function anthropicMessagesUrl(baseUrl?: string): string {
  const b = (baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, "");
  return `${/\/v\d+$/.test(b) ? b : `${b}/v1`}/messages`;
}

interface AnthropicMessageResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string | null;
  usage?: AnthropicUsage;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function anthropicUsage(value: AnthropicUsage | undefined): DeepseekDraftUsage | undefined {
  if (!value) return undefined;
  const inputTokens = count(value.input_tokens);
  const cacheHitTokens = count(value.cache_read_input_tokens);
  return {
    inputTokens,
    outputTokens: count(value.output_tokens),
    cacheHitTokens,
    cacheMissTokens: Math.max(0, inputTokens - cacheHitTokens),
    cacheCreationTokens: count(value.cache_creation_input_tokens),
  };
}

function mergeAnthropicUsage(
  current: DeepseekDraftUsage | undefined,
  next: AnthropicUsage | undefined,
): DeepseekDraftUsage | undefined {
  const normalized = anthropicUsage(next);
  if (!normalized) return current;
  return {
    inputTokens: normalized.inputTokens || current?.inputTokens || 0,
    outputTokens: normalized.outputTokens || current?.outputTokens || 0,
    cacheHitTokens: normalized.cacheHitTokens || current?.cacheHitTokens || 0,
    cacheMissTokens: normalized.inputTokens > 0
      ? normalized.cacheMissTokens
      : current?.cacheMissTokens ?? 0,
    cacheCreationTokens: normalized.cacheCreationTokens || current?.cacheCreationTokens || 0,
  };
}

function buildAnthropicMessages(input: DeepseekDraftCall): {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  if (!input.messages) {
    return { system: input.system, messages: [{ role: "user", content: input.user }] };
  }

  const systemParts: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of input.messages) {
    const content = message.content.trim();
    if (!content) continue;
    if (message.role === "system") {
      systemParts.push(content);
      continue;
    }
    const previous = messages[messages.length - 1];
    if (previous?.role === message.role) {
      previous.content = `${previous.content}\n\n${content}`;
    } else {
      messages.push({ role: message.role, content });
    }
  }

  return {
    system: systemParts.join("\n\n") || input.system,
    messages: messages.length > 0 ? messages : [{ role: "user", content: input.user }],
  };
}

function buildAnthropicBody(input: DeepseekDraftCall): Record<string, unknown> {
  const normalized = buildAnthropicMessages(input);
  return {
    model: input.model ?? DEEPSEEK_DRAFT_MODEL,
    max_tokens: typeof input.maxTokens === "number" && Number.isFinite(input.maxTokens)
      ? Math.max(1, Math.floor(input.maxTokens))
      : 8192,
    system: normalized.system,
    messages: normalized.messages,
    temperature: input.temperature,
    stream: input.stream,
  };
}

async function fetchAnthropic(input: DeepseekDraftCall): Promise<Response> {
  const response = await fetch(anthropicMessagesUrl(input.baseUrl), {
    method: "POST",
    headers: {
      "x-api-key": resolveApiKey(input.apiKey),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(buildAnthropicBody(input)),
    signal: input.abortSignal,
  });
  if (!response.ok) {
    throw new UpstreamHttpError("anthropic", response.status);
  }
  return response;
}

async function readAnthropicNonStreaming(response: Response): Promise<DeepseekDraftResult> {
  const json = (await response.json()) as AnthropicMessageResponse;
  const raw = (json.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  return {
    raw,
    contentStartMs: raw ? 0 : null,
    finishReason: json.stop_reason ?? null,
    usage: anthropicUsage(json.usage),
  };
}

async function readAnthropicStreaming(
  response: Response,
  input: DeepseekDraftCall,
  startedAt: number,
): Promise<DeepseekDraftResult> {
  if (!response.body) throw new Error("Anthropic streaming response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  let contentStartMs: number | null = null;
  let finishReason: string | null = null;
  let usage: DeepseekDraftUsage | undefined;

  const handleData = (data: string) => {
    if (!data || data === "[DONE]") return;
    let json: {
      type?: string;
      delta?: { type?: string; text?: string; stop_reason?: string | null };
      message?: { usage?: AnthropicUsage };
      usage?: AnthropicUsage;
    };
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (json.type === "message_start") {
      usage = mergeAnthropicUsage(usage, json.message?.usage);
      return;
    }
    if (json.type === "message_delta") {
      usage = mergeAnthropicUsage(usage, json.usage);
      if (typeof json.delta?.stop_reason === "string") finishReason = json.delta.stop_reason;
      return;
    }
    if (json.type !== "content_block_delta" || json.delta?.type !== "text_delta") return;
    const content = json.delta.text;
    if (!content) return;
    if (contentStartMs === null) {
      contentStartMs = Date.now() - startedAt;
      input.onContentStart?.(contentStartMs);
    }
    raw += content;
    input.onContentDelta?.(content, raw);
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    for (const event of events) {
      for (const line of event.split(/\r?\n/)) {
        if (line.startsWith("data:")) handleData(line.slice(5).trim());
      }
    }
  }

  const tail = buffer.trim();
  if (tail.startsWith("data:")) handleData(tail.slice(5).trim());
  return { raw, contentStartMs, finishReason, usage };
}

function missingReason(error: unknown, aborted: boolean): string {
  if (aborted || isAbortError(error)) return "aborted";
  if (error instanceof UpstreamHttpError) return `http_${error.status}`;
  return error instanceof Error ? error.name || "request_failed" : "request_failed";
}

export async function callDeepseekDraft(input: DeepseekDraftCall): Promise<DeepseekDraftResult> {
  const maxRetries = input.maxRetries ?? 2;
  const isAnthropic = input.protocol === "anthropic";
  let lastError: unknown;
  let requestAttempt = 0;

  const notifyAttempt = async (attempt: DeepseekDraftAttempt): Promise<void> => {
    try {
      await input.onAttemptComplete?.(attempt);
    } catch (error) {
      console.warn("[deepseekDraftClient] attempt 观测回调失败(不影响生成)", {
        attempt: attempt.attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const runRequest = async (
    protocol: "openai" | "anthropic",
    streaming: boolean,
    execute: () => Promise<DeepseekDraftResult>,
  ): Promise<DeepseekDraftResult> => {
    requestAttempt += 1;
    try {
      const result = await execute();
      const usage = result.usage;
      await notifyAttempt({
        attempt: requestAttempt,
        protocol,
        streaming,
        usageState: usage ? "recorded" : "missing",
        reason: usage ? null : "provider_usage_unavailable",
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheHitTokens: usage?.cacheHitTokens ?? 0,
        cacheMissTokens: usage?.cacheMissTokens ?? 0,
        cacheCreationTokens: usage?.cacheCreationTokens ?? 0,
      });
      return result;
    } catch (error) {
      await notifyAttempt({
        attempt: requestAttempt,
        protocol,
        streaming,
        usageState: "missing",
        reason: missingReason(error, Boolean(input.abortSignal?.aborted)),
        inputTokens: 0,
        outputTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        cacheCreationTokens: 0,
      });
      throw error;
    }
  };

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const startedAt = Date.now();
    try {
      if (isAnthropic) {
        return await runRequest("anthropic", input.stream, async () => {
          const response = await fetchAnthropic(input);
          return input.stream
            ? await readAnthropicStreaming(response, input, startedAt)
            : await readAnthropicNonStreaming(response);
        });
      }
      return await runRequest("openai", input.stream, async () => {
        const response = await fetchDeepseek(input);
        return input.stream
          ? await readStreaming(response, input, startedAt)
          : await readNonStreaming(response);
      });
    } catch (error) {
      if (isAbortError(error) || input.abortSignal?.aborted) throw error;
      if (
        !isAnthropic &&
        input.stream &&
        error instanceof UpstreamHttpError &&
        (error.status === 400 || error.status === 422)
      ) {
        try {
          return await runRequest("openai", false, async () => {
            const response = await fetchDeepseek({ ...input, stream: false });
            return resultFromChatJsonText(await response.text(), input, startedAt);
          });
        } catch (fallbackError) {
          lastError = fallbackError;
          if (attempt >= maxRetries) break;
          continue;
        }
      }
      lastError = error;
      if (attempt >= maxRetries) break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export const deepseekDraftClientInternals = {
  buildAnthropicBody,
  buildRequestBody,
  isAbortError,
  redactSensitiveText,
};

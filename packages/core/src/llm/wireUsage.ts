import { AsyncLocalStorage } from "node:async_hooks";

/** provider 未返回 usage 时，仅用实际发送/收到的文本做本地估算。 */
export interface ModelCallUsageEstimate {
  /** 可复用的快照前缀；仅表示估算缓存命中，不冒充 provider 实测。 */
  cachedInputText?: string;
  /** 本次新增 prompt；按估算缓存未命中计。 */
  uncachedInputText?: string;
  /** 中止前已收到的正文、思考或工具结果 delta。 */
  outputText?: string;
}

export const WIRE_USAGE_IDLE_TIMEOUT_MS = 5 * 60_000;
export const WIRE_USAGE_MAX_FRAME_BYTES = 256 * 1024;
export const WIRE_USAGE_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export type WireUsageCompleteness = "complete" | "partial-input";

export interface WireUsageObservation {
  completeness: WireUsageCompleteness;
  usage: Record<string, unknown>;
}

export interface WireAttempt {
  wireAttemptSeq: number;
  startedAt: number;
  requestEstimate: ModelCallUsageEstimate;
  responseStatus: number | null;
  responseReceivedAt: number | null;
  endedAt: number | null;
  usage: WireUsageObservation | null;
  outputText: string;
  parseStoppedReason: "frame_limit" | "total_limit" | "parse_error" | null;
  transportError: string | null;
}

export interface WireScope {
  wireAttemptSeq: number;
  attempts: WireAttempt[];
  finalized: boolean;
  idleTimeoutMs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  onFinalizeTimeout: (scope: WireScope) => void;
}

export interface CreateWireScopeOptions {
  onFinalizeTimeout: (scope: WireScope) => void;
  idleTimeoutMs?: number;
}

export const wireUsageStorage = new AsyncLocalStorage<WireScope>();

export function createWireScope(options: CreateWireScopeOptions): WireScope {
  return {
    wireAttemptSeq: 0,
    attempts: [],
    finalized: false,
    idleTimeoutMs: options.idleTimeoutMs ?? WIRE_USAGE_IDLE_TIMEOUT_MS,
    idleTimer: null,
    onFinalizeTimeout: options.onFinalizeTimeout,
  };
}

export function claimWireScopeFinalization(scope: WireScope): boolean {
  if (scope.finalized) return false;
  scope.finalized = true;
  clearWireIdleTimer(scope);
  return true;
}

function clearWireIdleTimer(scope: WireScope): void {
  if (scope.idleTimer === null) return;
  clearTimeout(scope.idleTimer);
  scope.idleTimer = null;
}

/** 响应头到达就启动；后续每个响应 chunk 只重置空闲窗口。 */
function armWireIdleTimer(scope: WireScope): void {
  if (scope.finalized) return;
  clearWireIdleTimer(scope);
  scope.idleTimer = setTimeout(() => {
    scope.idleTimer = null;
    if (!scope.finalized) scope.onFinalizeTimeout(scope);
  }, scope.idleTimeoutMs);
  scope.idleTimer.unref?.();
}

/** provider 已交付可消费流时再确认一次计时窗口；真实响应通常已在响应头处提前 arm。 */
export function armWireScopeForStreamDelivery(scope: WireScope): void {
  armWireIdleTimer(scope);
}

function wireErrorName(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return "request_error";
}

function requestBodyText(
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
): string {
  const body = init?.body ?? (
    typeof input === "string" || input instanceof URL ? undefined : input.body
  );
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    );
  }
  return "";
}

/** 估算只使用实际请求体；解析失败时保留原文，不能让坏 JSON 抹掉 H8 的素材。 */
export function extractWireRequestEstimate(
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
): ModelCallUsageEstimate {
  const bodyText = requestBodyText(input, init);
  if (!bodyText) return { uncachedInputText: "" };
  try {
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    const prompt = {
      ...(body.system === undefined ? {} : { system: body.system }),
      ...(body.messages === undefined ? {} : { messages: body.messages }),
      ...(body.tools === undefined ? {} : { tools: body.tools }),
      ...(body.input === undefined ? {} : { input: body.input }),
      ...(body.prompt === undefined ? {} : { prompt: body.prompt }),
    };
    const serialized = JSON.stringify(prompt);
    return { uncachedInputText: serialized === "{}" ? bodyText : serialized };
  } catch {
    return { uncachedInputText: bodyText };
  }
}

export function beginWireAttempt(
  scope: WireScope,
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
): WireAttempt {
  const attempt: WireAttempt = {
    wireAttemptSeq: ++scope.wireAttemptSeq,
    startedAt: Date.now(),
    requestEstimate: extractWireRequestEstimate(input, init),
    responseStatus: null,
    responseReceivedAt: null,
    endedAt: null,
    usage: null,
    outputText: "",
    parseStoppedReason: null,
    transportError: null,
  };
  scope.attempts.push(attempt);
  return attempt;
}

export function markWireAttemptError(attempt: WireAttempt, error: unknown): void {
  attempt.endedAt = Date.now();
  attempt.transportError = wireErrorName(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasInputAndOutput(usage: Record<string, unknown>): boolean {
  const input = finiteNumber(usage.input_tokens) ?? finiteNumber(usage.prompt_tokens) ??
    finiteNumber(usage.inputTokens) ?? finiteNumber(usage.promptTokens);
  const output = finiteNumber(usage.output_tokens) ?? finiteNumber(usage.completion_tokens) ??
    finiteNumber(usage.outputTokens) ?? finiteNumber(usage.completionTokens);
  return input !== undefined && output !== undefined;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    const record = asRecord(part);
    return typeof record?.text === "string" ? record.text : "";
  }).join("");
}

export interface WireParserLimits {
  maxFrameBytes?: number;
  maxTotalBytes?: number;
}

/**
 * 同步、增量、失败闭合的响应解析器。达到任一上限后只停止解析，正文流照常透传。
 */
export class WireUsageParser {
  private readonly decoder = new TextDecoder();
  private readonly maxFrameBytes: number;
  private readonly maxTotalBytes: number;
  private readonly sse: boolean;
  private totalBytes = 0;
  private lineBuffer = "";
  private dataLines: string[] = [];
  private frameBytes = 0;
  private jsonBuffer = "";
  private stopped = false;
  private openAiUsage: Record<string, unknown> | null = null;
  private anthropicInputUsage: Record<string, unknown> | null = null;
  private anthropicOutputTokens: number | undefined;

  constructor(
    private readonly attempt: WireAttempt,
    contentType: string | null,
    limits: WireParserLimits = {},
  ) {
    this.sse = contentType?.toLowerCase().includes("text/event-stream") ?? false;
    this.maxFrameBytes = limits.maxFrameBytes ?? WIRE_USAGE_MAX_FRAME_BYTES;
    this.maxTotalBytes = limits.maxTotalBytes ?? WIRE_USAGE_MAX_TOTAL_BYTES;
  }

  push(chunk: Uint8Array): void {
    if (this.stopped) return;
    if (this.totalBytes + chunk.byteLength > this.maxTotalBytes) {
      this.stop("total_limit");
      return;
    }
    this.totalBytes += chunk.byteLength;
    try {
      const text = this.decoder.decode(chunk, { stream: true });
      if (this.sse) this.pushSseText(text);
      else this.jsonBuffer += text;
    } catch {
      this.stop("parse_error");
    }
  }

  finish(): void {
    if (this.stopped) return;
    try {
      const tail = this.decoder.decode();
      if (this.sse) {
        this.pushSseText(tail);
        if (this.lineBuffer) {
          this.consumeSseLine(this.lineBuffer.replace(/\r$/, ""));
          this.lineBuffer = "";
        }
        this.dispatchSseFrame();
        if (this.openAiUsage && hasInputAndOutput(this.openAiUsage)) {
          this.attempt.usage = { completeness: "complete", usage: this.openAiUsage };
        }
      } else {
        this.jsonBuffer += tail;
        const payload = JSON.parse(this.jsonBuffer) as Record<string, unknown>;
        const usage = asRecord(payload.usage);
        if (usage && hasInputAndOutput(usage)) {
          this.attempt.usage = { completeness: "complete", usage };
        }
        this.captureNonStreamOutput(payload);
      }
    } catch {
      this.stop("parse_error");
    }
  }

  private pushSseText(text: string): void {
    this.lineBuffer += text;
    let newline = this.lineBuffer.indexOf("\n");
    while (newline >= 0 && !this.stopped) {
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, "");
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      this.consumeSseLine(line);
      newline = this.lineBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.lineBuffer, "utf8") > this.maxFrameBytes) {
      this.stop("frame_limit");
    }
  }

  private consumeSseLine(line: string): void {
    if (line === "") {
      this.dispatchSseFrame();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    if (field !== "data") return;
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    this.frameBytes += Buffer.byteLength(value, "utf8");
    if (this.frameBytes > this.maxFrameBytes) {
      this.stop("frame_limit");
      return;
    }
    this.dataLines.push(value);
  }

  private dispatchSseFrame(): void {
    if (this.dataLines.length === 0 || this.stopped) {
      this.dataLines = [];
      this.frameBytes = 0;
      return;
    }
    const data = this.dataLines.join("\n");
    this.dataLines = [];
    this.frameBytes = 0;
    if (data.trim() === "[DONE]") {
      if (this.openAiUsage && hasInputAndOutput(this.openAiUsage)) {
        this.attempt.usage = { completeness: "complete", usage: this.openAiUsage };
      }
      return;
    }
    try {
      this.captureSsePayload(JSON.parse(data) as Record<string, unknown>);
    } catch {
      // 单个坏帧不影响后续有效帧，也不影响主流。
    }
  }

  private captureSsePayload(payload: Record<string, unknown>): void {
    const type = typeof payload.type === "string" ? payload.type : "";
    if (type === "message_start") {
      const usage = asRecord(asRecord(payload.message)?.usage);
      if (usage) {
        this.anthropicInputUsage = {
          ...(finiteNumber(usage.input_tokens) === undefined
            ? {}
            : { input_tokens: finiteNumber(usage.input_tokens) }),
          ...(finiteNumber(usage.cache_read_input_tokens) === undefined
            ? {}
            : { cache_read_input_tokens: finiteNumber(usage.cache_read_input_tokens) }),
          ...(finiteNumber(usage.cache_creation_input_tokens) === undefined
            ? {}
            : { cache_creation_input_tokens: finiteNumber(usage.cache_creation_input_tokens) }),
        };
        if (finiteNumber(this.anthropicInputUsage.input_tokens) !== undefined) {
          this.attempt.usage = {
            completeness: "partial-input",
            usage: this.anthropicInputUsage,
          };
        }
      }
      return;
    }
    if (type === "message_delta") {
      const output = finiteNumber(asRecord(payload.usage)?.output_tokens);
      if (output !== undefined) this.anthropicOutputTokens = output;
      return;
    }
    if (type === "message_stop") {
      if (this.anthropicInputUsage && this.anthropicOutputTokens !== undefined) {
        this.attempt.usage = {
          completeness: "complete",
          usage: {
            ...this.anthropicInputUsage,
            output_tokens: this.anthropicOutputTokens,
          },
        };
      }
      return;
    }

    const usage = asRecord(payload.usage);
    if (usage) this.openAiUsage = usage;
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    for (const choice of choices) {
      const delta = asRecord(asRecord(choice)?.delta);
      if (!delta) continue;
      this.appendOutput(textFromContent(delta.content));
      this.appendOutput(textFromContent(delta.reasoning_content));
      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const toolCall of toolCalls) {
        const args = asRecord(asRecord(toolCall)?.function)?.arguments;
        if (typeof args === "string") this.appendOutput(args);
      }
    }
    if (type === "content_block_start") {
      const block = asRecord(payload.content_block);
      this.appendOutput(textFromContent(block?.text));
      if (block?.content !== undefined) this.appendOutput(JSON.stringify(block.content));
    } else if (type === "content_block_delta") {
      const delta = asRecord(payload.delta);
      this.appendOutput(textFromContent(delta?.text));
      this.appendOutput(textFromContent(delta?.thinking));
      this.appendOutput(textFromContent(delta?.partial_json));
    }
  }

  private captureNonStreamOutput(payload: Record<string, unknown>): void {
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    for (const choice of choices) {
      const message = asRecord(asRecord(choice)?.message);
      this.appendOutput(textFromContent(message?.content));
    }
    this.appendOutput(textFromContent(payload.content));
  }

  private appendOutput(value: string): void {
    if (value) this.attempt.outputText += value;
  }

  private stop(reason: WireAttempt["parseStoppedReason"]): void {
    this.stopped = true;
    this.attempt.parseStoppedReason = reason;
    this.lineBuffer = "";
    this.dataLines = [];
    this.jsonBuffer = "";
  }
}

function responseWithBody(response: Response, body: ReadableStream<Uint8Array>): Response {
  const tapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  for (const key of ["url", "redirected", "type"] as const) {
    try {
      Object.defineProperty(tapped, key, { value: response[key], configurable: true });
    } catch {
      // 极旧运行时不允许覆盖只读属性时，status/headers/body 仍足够供 provider SDK 使用。
    }
  }
  return tapped;
}

/** 响应头到达时即 arm；tap 与消费者共享同一背压链，不建立第二消费分支。 */
export function observeWireResponse(
  scope: WireScope,
  attempt: WireAttempt,
  response: Response,
  limits?: WireParserLimits,
): Response {
  attempt.responseStatus = response.status;
  attempt.responseReceivedAt = Date.now();
  if (!response.body) {
    attempt.endedAt = Date.now();
    return response;
  }
  const parser = new WireUsageParser(attempt, response.headers.get("content-type"), limits);
  armWireIdleTimer(scope);
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      try {
        parser.push(chunk);
      } catch {
        attempt.parseStoppedReason = "parse_error";
      }
      armWireIdleTimer(scope);
      controller.enqueue(chunk);
    },
    flush() {
      try {
        parser.finish();
      } catch {
        attempt.parseStoppedReason = "parse_error";
      }
      attempt.endedAt = Date.now();
      clearWireIdleTimer(scope);
    },
  }));
  return responseWithBody(response, body);
}

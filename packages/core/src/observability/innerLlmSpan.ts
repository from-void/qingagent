import { SpanType } from "@mastra/core/observability";
import type { Span } from "@mastra/core/observability";
import { getObservability } from "./runtime.js";

const PROMPT_SUMMARY_MAX_BYTES = 2048;

export function deriveSessionTraceId(sessionId: string | null | undefined): string | undefined {
  if (!sessionId) return undefined;
  const hex = sessionId.toLowerCase().replace(/[^0-9a-f]/g, "");
  return hex.length === 0 ? undefined : hex.slice(0, 32);
}

export function truncateUtf8(text: string, maxBytes: number): {
  text: string;
  truncated: boolean;
  originalBytes: number;
} {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes };
  }

  let used = 0;
  let end = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (used + bytes > maxBytes) break;
    used += bytes;
    end += char.length;
  }
  return { text: text.slice(0, end), truncated: true, originalBytes };
}

export function buildInnerLlmPromptSummary(system: string, user: string): Record<string, unknown> {
  const combined = `system:\n${system}\n\nuser:\n${user}`;
  const truncated = truncateUtf8(combined, PROMPT_SUMMARY_MAX_BYTES);
  return {
    text: truncated.text,
    truncated: truncated.truncated,
    originalBytes: truncated.originalBytes,
    maxBytes: PROMPT_SUMMARY_MAX_BYTES,
  };
}

export interface InnerLlmSpanStartOptions {
  name: string;
  sessionId?: string | null;
  clientTraceId?: string | null;
  streamId?: string | null;
  runId?: string | null;
  origin?: string | null;
  toolName: string;
  toolCallId?: string | null;
  modelName: string;
  system: string;
  user: string;
  attempt: number;
  maxAttempts: number;
}

export interface InnerLlmSpanController {
  end: (opts: {
    ok: boolean;
    outputText?: string;
    error?: unknown;
    /** 仅允许传入已脱敏的结构化诊断，不得传原始模型输出。 */
    diagnostic?: Record<string, unknown>;
  }) => void;
}

export function startInnerLlmSpan(opts: InnerLlmSpanStartOptions): InnerLlmSpanController {
  const startedAt = new Date().toISOString();
  let span: Span<SpanType.GENERIC> | null = null;
  try {
    const instance = getObservability()?.getDefaultInstance();
    if (instance && opts.sessionId) {
      const traceId = deriveSessionTraceId(opts.sessionId);
      span = instance.startSpan({
        type: SpanType.GENERIC,
        name: opts.name,
        ...(traceId ? { traceId } : {}),
        metadata: {
          eventKind: "inner_llm",
          sessionId: opts.sessionId,
          clientTraceId: opts.clientTraceId ?? null,
          streamId: opts.streamId ?? null,
          runId: opts.runId ?? null,
          origin: opts.origin ?? "manual",
          toolName: opts.toolName,
          toolCallId: opts.toolCallId ?? null,
          modelName: opts.modelName,
          attempt: opts.attempt,
          maxAttempts: opts.maxAttempts,
          startedAt,
        },
        input: {
          prompt: buildInnerLlmPromptSummary(opts.system, opts.user),
        },
      }) as Span<SpanType.GENERIC>;
    }
  } catch (err) {
    console.warn("[observability] startInnerLlmSpan failed (non-fatal)", {
      name: opts.name,
      sessionId: opts.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    end: ({ ok, outputText = "", error, diagnostic }) => {
      const endedAt = new Date().toISOString();
      if (!span) return;
      try {
        span.end({
          metadata: {
            success: ok,
            endedAt,
            outputCharCount: outputText.length,
            error: error ? (error instanceof Error ? error.message : String(error)) : null,
          },
          output: {
            ok,
            outputCharCount: outputText.length,
            attempt: opts.attempt,
            maxAttempts: opts.maxAttempts,
            error: error ? (error instanceof Error ? error.message : String(error)) : null,
            diagnostic: diagnostic ?? null,
          },
        });
      } catch (err) {
        console.warn("[observability] endInnerLlmSpan failed (non-fatal)", {
          name: opts.name,
          sessionId: opts.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

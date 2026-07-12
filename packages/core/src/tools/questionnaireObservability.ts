import { SpanType } from "@mastra/core/observability";
import { deriveSessionTraceId } from "../observability/innerLlmSpan.js";
import { getObservability } from "../observability/runtime.js";

type QuestionnaireToolContext = {
  requestContext?: { get?: (key: string) => unknown };
} | undefined;

export interface QuestionnaireSpanOptions {
  eventKind: string;
  metadata?: Record<string, unknown>;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

/** 问卷工具共用的非阻塞观测事件，统一补齐跨层追踪字段。 */
export function recordQuestionnaireEventSpan(
  context: QuestionnaireToolContext,
  options: QuestionnaireSpanOptions,
): void {
  const requestContext = context?.requestContext;
  const sessionId = requestContext?.get?.("sessionId") as string | undefined;
  if (!sessionId) return;
  try {
    const instance = getObservability()?.getDefaultInstance();
    if (!instance) return;
    const traceId = deriveSessionTraceId(sessionId);
    const span = instance.startSpan({
      type: SpanType.GENERIC,
      name: options.eventKind,
      ...(traceId ? { traceId } : {}),
      metadata: {
        eventKind: options.eventKind,
        sessionId,
        clientTraceId: (requestContext?.get?.("clientTraceId") as string | null | undefined) ?? null,
        streamId: (requestContext?.get?.("streamId") as string | null | undefined) ?? null,
        runId: (requestContext?.get?.("runId") as string | null | undefined) ?? null,
        origin: (requestContext?.get?.("origin") as string | null | undefined) ?? "manual",
        ...options.metadata,
      },
      input: options.input ?? {},
    });
    span.end({ output: options.output ?? { ok: true } });
  } catch (err) {
    console.warn("[questionnaire] record span failed (non-fatal)", {
      eventKind: options.eventKind,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

import { BaseExporter } from "@mastra/observability";
import type { AnyExportedSpan, TracingEvent } from "@mastra/core/observability";
import { SpanType, TracingEventType } from "@mastra/core/observability";
import {
  DEFAULT_DIAG_ERROR_FIELD_BYTES,
  DEFAULT_DIAG_FIELD_BYTES,
  exportedSpanToDiagSpan,
} from "@qingagent/core";
import { appendRollingChunk } from "./rollingFiles.js";

interface JsonlSpanSinkOptions {
  flushIntervalMs: number;
  maxBufferLines: number;
  maxDays: number;
  maxBytes: number;
  fieldMaxBytes: number;
  errorFieldMaxBytes: number;
  now: () => Date;
  traceTtlMs: number;
}

const DEFAULT_OPTIONS: JsonlSpanSinkOptions = {
  flushIntervalMs: 1000,
  maxBufferLines: 50,
  maxDays: 7,
  maxBytes: 100 * 1024 * 1024,
  fieldMaxBytes: DEFAULT_DIAG_FIELD_BYTES,
  errorFieldMaxBytes: DEFAULT_DIAG_ERROR_FIELD_BYTES,
  now: () => new Date(),
  traceTtlMs: 30 * 60 * 1000,
};

export class JsonlSpanSink extends BaseExporter {
  name = "jsonl-span-sink";

  private readonly opts: JsonlSpanSinkOptions;
  private readonly seqByTraceNameType = new Map<string, number>();
  private readonly traceSeenAt = new Map<string, number>();
  private readonly keyBySpanId = new Map<string, { traceId: string; key: string; seq: number; seenAt: number }>();
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCleanupAt = 0;

  constructor(private readonly logDir: string, opts: Partial<JsonlSpanSinkOptions> = {}) {
    super();
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  protected async _exportTracingEvent(event: TracingEvent): Promise<void> {
    try {
      const span = event.exportedSpan;
      if (span.type === SpanType.MODEL_CHUNK) return;
      const nowMs = this.opts.now().getTime();
      this.trackTrace(span.traceId, nowMs);
      const spanKey = this.ensureSpanKey(span, nowMs);
      this.cleanupOldTraceState(nowMs);

      if (event.type === TracingEventType.SPAN_STARTED && !span.isEvent) {
        return;
      }
      if (event.type !== TracingEventType.SPAN_ENDED && !(span.isEvent && event.type === TracingEventType.SPAN_STARTED)) {
        return;
      }

      const parentKey = span.parentSpanId ? this.keyBySpanId.get(span.parentSpanId)?.key ?? null : null;
      const diagSpan = exportedSpanToDiagSpan(span, {
        seq: spanKey.seq,
        parentKey,
        fieldMaxBytes: this.opts.fieldMaxBytes,
        errorFieldMaxBytes: this.opts.errorFieldMaxBytes,
      });
      this.keyBySpanId.set(span.id, { ...spanKey, key: diagSpan.key, seenAt: nowMs });
      this.enqueue(`${JSON.stringify(diagSpan)}\n`);
    } catch {
      // exporter 是旁路诊断能力，任何错误都不能回流到 agent 主链路。
    }
  }

  override async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;
    const chunk = this.buffer.join("");
    this.buffer = [];
    try {
      await appendRollingChunk(this.logDir, "spans", chunk, {
        extension: "jsonl",
        maxDays: this.opts.maxDays,
        maxBytes: this.opts.maxBytes,
        now: this.opts.now,
      });
    } catch {
      // 写失败静默丢弃当前批次。
    }
  }

  override async shutdown(): Promise<void> {
    await this.flush();
  }

  private enqueue(line: string): void {
    this.buffer.push(line);
    if (this.buffer.length >= this.opts.maxBufferLines) {
      void this.flush().catch(() => undefined);
      return;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      void this.flush().catch(() => undefined);
    }, this.opts.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private nextSeq(traceId: string, name: string, spanType: string): number {
    const key = `${traceId}::${name}::${spanType}`;
    const next = (this.seqByTraceNameType.get(key) ?? 0) + 1;
    this.seqByTraceNameType.set(key, next);
    return next;
  }

  private ensureSpanKey(
    span: AnyExportedSpan,
    nowMs: number,
  ): { traceId: string; key: string; seq: number; seenAt: number } {
    const existing = this.keyBySpanId.get(span.id);
    if (existing) {
      existing.seenAt = nowMs;
      return existing;
    }
    const seq = this.nextSeq(span.traceId, span.name, String(span.type));
    const key = `${span.traceId.slice(0, 8)}::${span.name}::${String(span.type)}::${seq}`;
    const value = { traceId: span.traceId, key, seq, seenAt: nowMs };
    this.keyBySpanId.set(span.id, value);
    return value;
  }

  private trackTrace(traceId: string, nowMs: number): void {
    this.traceSeenAt.set(traceId, nowMs);
  }

  private cleanupOldTraceState(nowMs: number): void {
    if (nowMs - this.lastCleanupAt < 5 * 60 * 1000) return;
    this.lastCleanupAt = nowMs;
    const expiredTraceIds = new Set<string>();
    for (const [traceId, seenAt] of this.traceSeenAt) {
      if (nowMs - seenAt > this.opts.traceTtlMs) {
        expiredTraceIds.add(traceId);
        this.traceSeenAt.delete(traceId);
      }
    }
    if (expiredTraceIds.size === 0) return;
    for (const key of this.seqByTraceNameType.keys()) {
      const traceId = key.slice(0, key.indexOf("::"));
      if (expiredTraceIds.has(traceId)) this.seqByTraceNameType.delete(key);
    }
    for (const [spanId, value] of this.keyBySpanId) {
      if (expiredTraceIds.has(value.traceId) || nowMs - value.seenAt > this.opts.traceTtlMs) {
        this.keyBySpanId.delete(spanId);
      }
    }
  }
}

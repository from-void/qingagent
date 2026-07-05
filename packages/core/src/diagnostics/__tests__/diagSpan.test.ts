import { describe, expect, it } from "vitest";
import type { AnyExportedSpan } from "@mastra/core/observability";
import { SpanType } from "@mastra/core/observability";
import {
  classifyDiagLayer,
  exportedSpanToDiagSpan,
  statusFromError,
  truncateField,
} from "../diagSpan.js";

describe("diagnostics diagSpan", () => {
  it("按 spanType 与 eventKind 归类层级", () => {
    expect(classifyDiagLayer({ name: "run", spanType: SpanType.AGENT_RUN })).toBe("agent");
    expect(classifyDiagLayer({ name: "model", spanType: SpanType.MODEL_GENERATION })).toBe("model");
    expect(classifyDiagLayer({ name: "step", spanType: SpanType.MODEL_STEP })).toBe("model");
    expect(classifyDiagLayer({ name: "inference", spanType: SpanType.MODEL_INFERENCE })).toBe("model");
    expect(classifyDiagLayer({ name: "tool", spanType: SpanType.TOOL_CALL })).toBe("tool");
    expect(classifyDiagLayer({ name: "mcp", spanType: SpanType.MCP_TOOL_CALL })).toBe("tool");
    expect(classifyDiagLayer({ name: "client_event", spanType: SpanType.GENERIC, meta: { eventKind: "client_event" } })).toBe("client");
    expect(classifyDiagLayer({ name: "command", spanType: SpanType.GENERIC, meta: { eventKind: "command" } })).toBe("command");
    expect(classifyDiagLayer({ name: "db_write", spanType: SpanType.GENERIC, meta: { eventKind: "db_write" } })).toBe("db");
    expect(classifyDiagLayer({ name: "unknown", spanType: SpanType.GENERIC })).toBe("other");
  });

  it("truncateField 处理超大 input、循环引用和尾部代理对字符", () => {
    const dirty: Record<string, unknown> = {
      text: "甲".repeat(20),
      emoji: "ok😀",
    };
    dirty.self = dirty;

    const field = truncateField(dirty, 35);

    expect(field.bytes).toBeGreaterThan(35);
    expect(field.truncated).toBe(true);
    expect(field.summary).toContain("\"text\"");
    expect(field.summary).not.toContain("\uFFFD");
  });

  it("truncateField 处理二进制、BigInt、函数与 Symbol，不抛", () => {
    const field = truncateField({
      buf: new Uint8Array([1, 2, 3]),
      big: 42n,
      fn: function namedFn() {
        return null;
      },
      sym: Symbol("s"),
    }, 1024);

    expect(field.truncated).toBe(false);
    expect(field.summary).toContain("42n");
    expect(field.summary).toContain("[Function namedFn]");
    expect(field.summary).toContain("Symbol(s)");
  });

  it("exportedSpanToDiagSpan 对 error span 使用更大字段预算", () => {
    const span = makeSpan({
      input: { text: "x".repeat(5000) },
      errorInfo: { message: "boom" },
    });

    const diag = exportedSpanToDiagSpan(span, {
      seq: 7,
      fieldMaxBytes: 128,
      errorFieldMaxBytes: 6000,
    });

    expect(diag.key).toBe("abcdef12::command::generic::7");
    expect(diag.status).toBe("error");
    expect(diag.input?.bytes).toBeGreaterThan(5000);
    expect(diag.input?.truncated).toBe(false);
  });

  it("缺 endTime 的 event span 保留 endedAt/durMs 为 null，缺 metadata 不抛", () => {
    const span = makeSpan({
      endTime: undefined,
      metadata: undefined,
      isEvent: true,
    });

    const diag = exportedSpanToDiagSpan(span, { seq: 1 });

    expect(diag.endedAt).toBeNull();
    expect(diag.durMs).toBeNull();
    expect(diag.meta).toEqual({});
    expect(diag.sessionId).toBeNull();
    expect(diag.clientTraceId).toBeNull();
  });

  it("从 metadata/requestContext 提取 sessionId/clientTraceId，输出附带 usage", () => {
    const span = makeSpan({
      type: SpanType.MODEL_GENERATION,
      metadata: { sessionId: "sess-meta" },
      requestContext: { clientTraceId: "trace-ctx" },
      attributes: { usage: { inputTokens: 10, outputTokens: 20 } },
      output: { ok: true },
    });

    const diag = exportedSpanToDiagSpan(span, { seq: 2, parentKey: "parent-key" });

    expect(diag.parentKey).toBe("parent-key");
    expect(diag.layer).toBe("model");
    expect(diag.sessionId).toBe("sess-meta");
    expect(diag.clientTraceId).toBe("trace-ctx");
    expect(diag.output?.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("statusFromError 优先 error，并能识别 abort/timeout 标记", () => {
    expect(statusFromError({ message: "failed" }, { status: "timeout" })).toBe("error");
    expect(statusFromError(null, { status: "timeout" })).toBe("timeout");
    expect(statusFromError(undefined, { reason: "AbortError" })).toBe("abort");
    expect(statusFromError(undefined, {})).toBe("ok");
  });

  it("model_chunk 和 heartbeat 类 span 标记为 noise", () => {
    expect(exportedSpanToDiagSpan(makeSpan({ type: SpanType.MODEL_CHUNK }), { seq: 1 }).noise).toBe(true);
    expect(exportedSpanToDiagSpan(makeSpan({ name: "tool-heartbeat" }), { seq: 1 }).noise).toBe(true);
  });
});

function makeSpan(overrides: Partial<AnyExportedSpan> = {}): AnyExportedSpan {
  return {
    id: "span-1",
    traceId: "abcdef1234567890",
    name: "command",
    type: SpanType.GENERIC,
    startTime: new Date("2026-07-04T00:00:00.000Z"),
    endTime: new Date("2026-07-04T00:00:01.234Z"),
    metadata: {
      eventKind: "command",
      sessionId: "sess-1",
      clientTraceId: "client-1",
    },
    input: { ok: true },
    output: { done: true },
    isRootSpan: false,
    isEvent: false,
    ...overrides,
  } as AnyExportedSpan;
}

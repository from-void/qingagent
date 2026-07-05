import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AnyExportedSpan, TracingEvent } from "@mastra/core/observability";
import { SpanType, TracingEventType } from "@mastra/core/observability";
import { JsonlSpanSink } from "./jsonlSpanSink.js";

test("JsonlSpanSink 丢弃 model_chunk", async () => {
  const dir = await tempDir();
  try {
    const sink = new JsonlSpanSink(dir, testOpts());
    await sink.exportTracingEvent(event(makeSpan({ type: SpanType.MODEL_CHUNK })));
    await sink.flush();

    assert.deepEqual(await safeReaddir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JsonlSpanSink 字段截断并写入当天 spans 文件", async () => {
  const dir = await tempDir();
  try {
    const sink = new JsonlSpanSink(dir, testOpts({ fieldMaxBytes: 64 }));
    await sink.exportTracingEvent(event(makeSpan({ input: { text: "甲".repeat(100) } })));
    await sink.flush();

    const files = await readdir(dir);
    assert.deepEqual(files, ["spans-2026-07-04.jsonl"]);
    const line = JSON.parse(await readFile(path.join(dir, files[0]!), "utf8"));
    assert.equal(line.input.truncated, true);
    assert.equal(line.input.bytes > 64, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JsonlSpanSink 按总量预算删除最旧整只文件", async () => {
  const dir = await tempDir();
  try {
    await writeFile(path.join(dir, "spans-2026-07-01.jsonl"), "x".repeat(5000));
    await writeFile(path.join(dir, "spans-2026-07-02.jsonl"), "y".repeat(20));
    const sink = new JsonlSpanSink(dir, testOpts({ maxBytes: 1000 }));
    await sink.exportTracingEvent(event(makeSpan({ output: { ok: true } })));
    await sink.flush();

    const files = (await readdir(dir)).sort();
    assert.equal(files.includes("spans-2026-07-01.jsonl"), false);
    assert.equal(files.includes("spans-2026-07-02.jsonl"), true);
    assert.equal(files.includes("spans-2026-07-04.jsonl"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JsonlSpanSink 写失败静默", async () => {
  const parent = await tempDir();
  const blocked = path.join(parent, "blocked");
  try {
    await writeFile(blocked, "not-a-directory");
    const sink = new JsonlSpanSink(path.join(blocked, "logs"), testOpts());
    await assert.doesNotReject(async () => {
      await sink.exportTracingEvent(event(makeSpan()));
      await sink.flush();
    });
  } finally {
    await chmod(parent, 0o700).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
});

test("JsonlSpanSink event span 在 started 事件落盘，普通 started 不落盘", async () => {
  const dir = await tempDir();
  try {
    const sink = new JsonlSpanSink(dir, testOpts());
    await sink.exportTracingEvent({
      type: TracingEventType.SPAN_STARTED,
      exportedSpan: makeSpan({ isEvent: false }),
    });
    await sink.exportTracingEvent({
      type: TracingEventType.SPAN_STARTED,
      exportedSpan: makeSpan({ id: "event-1", isEvent: true, endTime: undefined }),
    });
    await sink.flush();

    const files = await readdir(dir);
    assert.deepEqual(files, ["spans-2026-07-04.jsonl"]);
    const line = JSON.parse(await readFile(path.join(dir, files[0]!), "utf8"));
    assert.equal(line.endedAt, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JsonlSpanSink 普通 started 预分配 parentKey 但不落盘", async () => {
  const dir = await tempDir();
  try {
    const sink = new JsonlSpanSink(dir, testOpts());
    await sink.exportTracingEvent({
      type: TracingEventType.SPAN_STARTED,
      exportedSpan: makeSpan({ id: "parent", name: "agent", type: SpanType.AGENT_RUN }),
    });
    await sink.exportTracingEvent(event(makeSpan({ id: "child", parentSpanId: "parent" })));
    await sink.flush();

    const files = await readdir(dir);
    assert.deepEqual(files, ["spans-2026-07-04.jsonl"]);
    const line = JSON.parse(await readFile(path.join(dir, files[0]!), "utf8"));
    assert.equal(line.parentKey, "abcdef12::agent::agent_run::1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function testOpts(overrides: Partial<{
  flushIntervalMs: number;
  maxBufferLines: number;
  maxDays: number;
  maxBytes: number;
  fieldMaxBytes: number;
  now: () => Date;
}> = {}) {
  return {
    flushIntervalMs: 10_000,
    maxBufferLines: 100,
    maxDays: 7,
    maxBytes: 1024 * 1024,
    now: () => new Date("2026-07-04T12:00:00.000Z"),
    ...overrides,
  };
}

function event(span: AnyExportedSpan): TracingEvent {
  return {
    type: TracingEventType.SPAN_ENDED,
    exportedSpan: span,
  };
}

function makeSpan(overrides: Partial<AnyExportedSpan> = {}): AnyExportedSpan {
  return {
    id: "span-1",
    traceId: "abcdef1234567890",
    name: "command",
    type: SpanType.GENERIC,
    startTime: new Date("2026-07-04T00:00:00.000Z"),
    endTime: new Date("2026-07-04T00:00:01.000Z"),
    metadata: { eventKind: "command", sessionId: "sess-1", clientTraceId: "client-1" },
    input: { ok: true },
    output: { done: true },
    isRootSpan: false,
    isEvent: false,
    ...overrides,
  } as AnyExportedSpan;
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "qingagent-jsonl-span-"));
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

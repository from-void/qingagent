import { describe, expect, it } from "vitest";
import {
  buildAgentTracingMetadata,
  buildLlmRequestSpanInput,
  buildLlmSpanMetadata,
  buildLlmStepResponseSpanEnd,
  buildLlmSuspendedResponseSpanEnd,
  buildSettleResultSpanMetadata,
} from "../agent-run/agentSpans.js";
import {
  buildToolIoEndMetadata,
  summarizeToolInputForSpan,
  summarizeToolOutputForSpan,
} from "../agent-run/toolIoSpans.js";
import {
  getToolIoMaxBytes,
  summarizeToolValue,
} from "../agent-run/redaction.js";

describe("llm step span helpers", () => {
  it("parses step-start request.body messages/input and truncates large strings", () => {
    const long = "x".repeat(64 * 1024 + 10);
    const input = buildLlmRequestSpanInput(JSON.stringify({
      messages: [{ role: "user", content: long }],
      input: [{ role: "system", content: "rules" }],
      ignored: "not copied",
    }));

    expect(input).toHaveProperty("messages");
    expect(input).toHaveProperty("input");
    expect(input).not.toHaveProperty("ignored");
    const message = (input.messages as Array<{ content: string }>)[0]!;
    expect(message.content.length).toBe(64 * 1024 + "…[truncated]".length);
    expect(message.content.endsWith("…[truncated]")).toBe(true);
  });

  it("keeps invalid request.body as a truncated body field", () => {
    const input = buildLlmRequestSpanInput("not-json");
    expect(input).toEqual({ body: "not-json" });
  });

  it("builds per-step llm_response output and attributes.usage", () => {
    const end = buildLlmStepResponseSpanEnd({
      stepResult: { reason: "tool-calls" },
      output: {
        text: "hello",
        toolCalls: [{ toolName: "readMaterial", toolCallId: "tc-1", args: { id: "m1" } }],
        usage: { inputTokens: 12, outputTokens: 3 },
      },
    });

    expect(end.attributes).toEqual({ usage: { inputTokens: 12, outputTokens: 3 } });
    expect(end.output).toMatchObject({
      text: "hello",
      textLength: 5,
      finishReason: "tool-calls",
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    expect(end.output.toolCalls).toEqual([
      { toolName: "readMaterial", toolCallId: "tc-1", args: { id: "m1" } },
    ]);
  });

  it("builds suspended-step llm_response with modelEndedAt and suspended marker", () => {
    const end = buildLlmSuspendedResponseSpanEnd({
      toolName: "askUser",
      toolCallId: "tc-ask-1",
      modelEndedAt: "2026-06-10T08:13:59.000Z",
    });

    expect(end.metadata).toEqual({
      suspended: true,
      modelEndedAt: "2026-06-10T08:13:59.000Z",
    });
    expect(end.output).toMatchObject({
      finishReason: "suspended",
      suspendedToolName: "askUser",
      suspendedToolCallId: "tc-ask-1",
      textLength: 0,
    });
  });

  it("omits modelEndedAt from suspended-step metadata when unknown", () => {
    const end = buildLlmSuspendedResponseSpanEnd({
      toolName: "writeDraft",
      toolCallId: "tc-wd-1",
      modelEndedAt: null,
    });

    expect(end.metadata).toEqual({ suspended: true });
    expect(end.output).toMatchObject({ finishReason: "suspended" });
  });

  it("normalizes legacy prompt/completion usage names to input/output tokens", () => {
    const end = buildLlmStepResponseSpanEnd({
      output: {
        usage: { promptTokens: 4, completionTokens: 7 },
      },
    });

    expect(end.attributes.usage).toMatchObject({ inputTokens: 4, outputTokens: 7 });
  });

  it("extracts deepseek prompt-cache usage tokens and hit rate", () => {
    const end = buildLlmStepResponseSpanEnd({
      output: {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          providerMetadata: {
            deepseek: {
              usage: {
                prompt_cache_hit_tokens: 80,
                prompt_cache_miss_tokens: 20,
              },
            },
          },
        },
      },
    });

    expect(end.attributes.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      promptCacheHitTokens: 80,
      promptCacheMissTokens: 20,
      promptCacheTotalTokens: 100,
      promptCacheHitRate: 0.8,
    });
  });

  it("normalizes camelCase prompt-cache usage tokens", () => {
    const end = buildLlmStepResponseSpanEnd({
      output: {
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          promptCacheHitTokens: 3,
          promptCacheMissTokens: 7,
        },
      },
    });

    expect(end.attributes.usage).toMatchObject({
      promptCacheHitTokens: 3,
      promptCacheMissTokens: 7,
      promptCacheTotalTokens: 10,
      promptCacheHitRate: 0.3,
    });
  });

  it("builds step metadata with origin and scope", () => {
    expect(
      buildLlmSpanMetadata({
        sessionId: "session-1",
        clientTraceId: "trace-client",
        streamId: "stream-1",
        runId: "run-1",
        origin: "agent",
        stepIndex: 2,
        messageId: "message-1",
        eventKind: "llm_request",
        scope: "step",
      }),
    ).toEqual({
      sessionId: "session-1",
      clientTraceId: "trace-client",
      streamId: "stream-1",
      runId: "run-1",
      origin: "agent",
      stepIndex: 2,
      messageId: "message-1",
      eventKind: "llm_request",
      scope: "step",
    });
  });

  it("builds agent tracing metadata with origin", () => {
    expect(
      buildAgentTracingMetadata(
        { sessionId: "session-1", clientTraceId: "ct-1", origin: "e2e" },
        "stream-1",
        "run-1",
      ),
    ).toEqual({
      sessionId: "session-1",
      clientTraceId: "ct-1",
      streamId: "stream-1",
      runId: "run-1",
      origin: "e2e",
      serverReanchorEnabled: false,
    });
  });

  it("uses configurable tool IO byte limit and marks truncated payloads", () => {
    const previous = process.env.QINGAGENT_OBS_TOOL_IO_MAX_BYTES;
    process.env.QINGAGENT_OBS_TOOL_IO_MAX_BYTES = "12";
    try {
      expect(getToolIoMaxBytes()).toBe(12);
      expect(summarizeToolValue("x".repeat(20))).toEqual({
        value: "x".repeat(12),
        truncated: true,
        originalBytes: 20,
        maxBytes: 12,
      });

      const objectSummary = summarizeToolValue({ text: "x".repeat(20) });
      expect(objectSummary).toMatchObject({
        truncated: true,
        originalBytes: Buffer.byteLength(JSON.stringify({ text: "x".repeat(20) }), "utf8"),
        maxBytes: 12,
        encoding: "json",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.QINGAGENT_OBS_TOOL_IO_MAX_BYTES;
      } else {
        process.env.QINGAGENT_OBS_TOOL_IO_MAX_BYTES = previous;
      }
    }
  });

  it("defaults tool IO limit to 50KB", () => {
    const previous = process.env.QINGAGENT_OBS_TOOL_IO_MAX_BYTES;
    delete process.env.QINGAGENT_OBS_TOOL_IO_MAX_BYTES;
    try {
      expect(getToolIoMaxBytes()).toBe(51200);
    } finally {
      if (previous !== undefined) process.env.QINGAGENT_OBS_TOOL_IO_MAX_BYTES = previous;
    }
  });

  it("builds settle_result metadata for candidate diff", () => {
    expect(
      buildSettleResultSpanMetadata(
        { sessionId: "s1", clientTraceId: "ct1", origin: "agent" },
        {
          branch: "candidateDiff",
          hunkCount: 3,
          docWritten: false,
          finalVersion: 7,
          sourceStreamId: "stream-1",
          runId: "run-1",
        },
      ),
    ).toEqual({
      eventKind: "settle_result",
      sessionId: "s1",
      clientTraceId: "ct1",
      streamId: "stream-1",
      runId: "run-1",
      origin: "agent",
      branch: "candidateDiff",
      hunkCount: 3,
      docWritten: false,
      finalVersion: 7,
      sourceStreamId: "stream-1",
    });
  });

  it("marks suppressed askUser tool results in tool_call metadata", () => {
    expect(
      buildToolIoEndMetadata(true, {
        suppressed: true,
        reason: "askUserAlreadyCompleted",
      }),
    ).toEqual({
      status: "done",
      suppressed: true,
      suppressReason: "askUserAlreadyCompleted",
    });
  });

  it("parseFile span 只记录脱敏输入摘要，不记录宿主路径或 base64", () => {
    const input = summarizeToolInputForSpan("parseFile", {
      fileId: "11111111-1111-4111-8111-111111111111",
      filePath: "C:\\Users\\alice\\AppData\\Roaming\\qingagent\\uploads\\secret.txt",
      content: "U0VDUkVUX0JBU0U2NA==",
      filename: "secret.txt",
    });
    const serialized = JSON.stringify(input);

    expect(input).toMatchObject({
      inputMode: "fileId",
      hasFileId: true,
      hasFilePath: true,
      hasContent: true,
      filenameExtension: ".txt",
    });
    expect(serialized).not.toContain("C:\\\\Users");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("U0VDUkVUX0JBU0U2NA");
    expect(serialized).not.toContain("secret.txt");
  });

  it("parseFile span 只记录结果统计，不记录正文或原始错误", () => {
    const output = summarizeToolOutputForSpan("parseFile", {
      ok: false,
      error: "secure_fd_path_unavailable: C:\\Users\\alice\\secret.txt",
      errorCode: "FILE_ACCESS_DENIED",
      failureKind: "error",
      text: "[Error] INTERNAL_SECRET_BODY",
      metadata: { pages: null, wordCount: 0, title: null },
    });
    const serialized = JSON.stringify(output);

    expect(output).toEqual({
      ok: false,
      failureKind: "error",
      errorCode: "FILE_ACCESS_DENIED",
      textLength: 28,
      wordCount: 0,
      pages: null,
    });
    expect(serialized).not.toContain("secure_fd_path_unavailable");
    expect(serialized).not.toContain("C:\\\\Users");
    expect(serialized).not.toContain("INTERNAL_SECRET_BODY");
  });
});

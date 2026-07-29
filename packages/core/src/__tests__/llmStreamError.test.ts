import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import type { BridgeFrame, LegacySection, ToolCallSpec } from "@qingagent/contract-ts";
import { deleteDocumentFamily, documentDraftRepo } from "@qingagent/db";
import { legacySectionsToPm, pmToLegacySections } from "@qingagent/pm-schema";

// 回归:上游 LLM 调用最终失败(网络/超时/服务异常,重试耗尽)时,Mastra 把错误作为
// type:"error" 的 chunk(deferredErrorChunk)推上来。零产出瞬态错误由 runAgentTurn
// 回合级重试;一旦已产生可见副作用或重试耗尽,仍必须如实报成可重试失败。

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    getMemory: () => null,
  },
  getObservability: () => null,
}));

vi.mock("../agents/qingagent.js", () => ({
  getQingagentSkills: vi.fn(async () => ({
    maybeRefresh: vi.fn(async () => {}),
    has: vi.fn(async () => false),
  })),
  qingagentAgent: { stream: vi.fn(), resumeStream: vi.fn() },
}));

async function* streamOf(...chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk;
}

async function* neverStream(): AsyncGenerator<unknown> {
  await new Promise(() => undefined);
}

async function* delayedReasoningThenHang(delayMs: number): AsyncGenerator<unknown> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  yield { type: "reasoning-delta", payload: { text: "仍在思考" } };
  await new Promise(() => undefined);
}

async function* heartbeatThenDelayedText(delayMs: number): AsyncGenerator<unknown> {
  yield {
    type: "tool-output",
    payload: {
      toolCallId: "heartbeat-before-first-chunk",
      output: { type: "tool-heartbeat", tool: "writeDraft", seq: 1 },
    },
  };
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  yield { type: "text-delta", payload: { text: "首个真实内容" } };
}

async function* metadataThenDelayedText(delayMs: number): AsyncGenerator<unknown> {
  yield { type: "start", payload: {} };
  yield { type: "step-start", payload: {} };
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  yield { type: "text-delta", payload: { text: "首个真实内容" } };
}

async function* postToolSegmentThenDelayedText(delayMs: number): AsyncGenerator<unknown> {
  yield { type: "text-delta", payload: { text: "前一模型段" } };
  yield {
    type: "tool-call",
    payload: { toolCallId: "post-tool-1", toolName: "slowTool", args: {} },
  };
  yield {
    type: "tool-result",
    payload: {
      toolCallId: "post-tool-1",
      toolName: "slowTool",
      args: {},
      result: { ok: true },
    },
  };
  yield { type: "step-finish", payload: { finishReason: "tool-calls" } };
  yield { type: "step-start", payload: {} };
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  yield { type: "text-delta", payload: { text: "工具后的模型收尾" } };
}

async function* postToolSegmentThenHang(): AsyncGenerator<unknown> {
  yield { type: "text-delta", payload: { text: "前一模型段" } };
  yield {
    type: "tool-call",
    payload: { toolCallId: "post-tool-dead-1", toolName: "slowTool", args: {} },
  };
  yield {
    type: "tool-result",
    payload: {
      toolCallId: "post-tool-dead-1",
      toolName: "slowTool",
      args: {},
      result: { ok: true },
    },
  };
  yield { type: "step-finish", payload: { finishReason: "tool-calls" } };
  await new Promise(() => undefined);
}

async function* textThenHang(): AsyncGenerator<unknown> {
  yield { type: "text-delta", payload: { text: "已经开始输出" } };
  await new Promise(() => undefined);
}

async function collectFrames(
  gen: AsyncGenerator<BridgeFrame, unknown>,
): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

async function collectFramesAndReturn<TReturn>(
  gen: AsyncGenerator<BridgeFrame, TReturn>,
): Promise<{ frames: BridgeFrame[]; result: TReturn }> {
  const frames: BridgeFrame[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { frames, result: next.value };
    frames.push(next.value);
  }
}

// Mastra 上游错误 chunk 形态(deferredErrorChunk)。
function errorChunk(
  message: string,
  options: { name?: string; statusCode?: number } = {},
) {
  const error = new Error(message) as Error & { statusCode?: number };
  if (options.name) error.name = options.name;
  if (options.statusCode !== undefined) error.statusCode = options.statusCode;
  return { type: "error", from: "AGENT", payload: { error } };
}

function idleTimeoutChunk() {
  return {
    type: "error",
    payload: {
      idleTimeout: true,
      error: new Error("agent stream idle timeout"),
    },
  };
}

function tripwireChunk(reason: string, processorId = "prompt-injection-detector") {
  return { type: "tripwire", payload: { reason, processorId } };
}

function draftingFailures(frames: BridgeFrame[]) {
  return frames.filter(
    (f) => f.kind === "stream" && f.data.kind === "draftingFailed",
  );
}

function textBodies(frames: BridgeFrame[]): string[] {
  return frames.flatMap((f) =>
    f.kind === "chatMessageAppended" && f.data.part.kind === "text"
      ? [f.data.part.data.body]
      : [],
  );
}

function findToolCallSpec(
  chatHistory: Array<{ parts: Array<{ kind: string; data: unknown }> }>,
  id: string,
): ToolCallSpec | null {
  for (const message of chatHistory) {
    for (const part of message.parts) {
      if (part.kind === "toolCall" && (part.data as ToolCallSpec).id === id) {
        return part.data as ToolCallSpec;
      }
    }
  }
  return null;
}

describe("LLM stream error chunk → 如实报错(可重试)", () => {
  const originalOmSidecar = process.env.QINGAGENT_OM_SIDECAR;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    // 本文件验证 Mastra memory 的回合级重试去重；OM 默认开启时主链不走 memory，
    // 因此显式关闭 sidecar，保留该路径的定向覆盖。
    process.env.QINGAGENT_OM_SIDECAR = "0";
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalOmSidecar === undefined) delete process.env.QINGAGENT_OM_SIDECAR;
    else process.env.QINGAGENT_OM_SIDECAR = originalOmSidecar;
  });

  // 全量测试并发跑时本用例偶发超 5s(R4-B 验收抖动),放宽到 15s。
  it("零产出瞬态 error chunk: processAgentStream 不直接弹红条,把 outcome 交给 caller 重试", { timeout: 15_000 }, async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("err-1");

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(streamOf(errorChunk("other side closed")), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-err-1",
        runId: "run-err-1",
      }),
    );

    expect(frames).toHaveLength(0);
    expect(result.producedVisibleFrame).toBe(false);
    expect(result.sawToolCall).toBe(false);
    expect(result.transientErrorChunk).toBeTruthy();
    expect(draftingFailures(frames)).toHaveLength(0);
    expect(textBodies(frames)).toEqual([]);
  });

  it.each(["", " \n\t", "\u200b", "\u2060", " \u200b\n\u2060\t"])(
    "首个有效 token 前的空白 delta(%j)不取消瞬态错误重试资格",
    async (blankText) => {
      const { createSession, processAgentStream } = await import("../bridge/index.js");
      const state = createSession("err-blank-delta");

      const { result } = await collectFramesAndReturn(
        processAgentStream(
          streamOf(
            { type: "text-delta", payload: { text: blankText } },
            errorChunk("read ECONNRESET"),
          ),
          {
            state,
            agentMessageId: "agent-msg",
            streamId: "stream-err-blank",
            runId: "run-err-blank",
          },
        ),
      );

      expect(result.producedVisibleFrame).toBe(false);
      expect(result.transientErrorChunk).toBeTruthy();
    },
  );

  it.each(["中文", "👨‍👩‍👧‍👦"])(
    "CJK/emoji 正文(%s)仍会取得可见产出资格",
    async (visibleText) => {
      const { createSession, processAgentStream } = await import("../bridge/index.js");
      const { result } = await collectFramesAndReturn(
        processAgentStream(
          streamOf({ type: "text-delta", payload: { text: visibleText } }),
          {
            state: createSession("visible-unicode-delta"),
            agentMessageId: "agent-msg",
            streamId: "stream-visible-unicode",
            runId: "run-visible-unicode",
          },
        ),
      );

      expect(result.producedVisibleFrame).toBe(true);
    },
  );

  it("guardrail tripwire abort 必须发前端可见失败帧,不能静默", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("guardrail-tripwire");

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(streamOf(tripwireChunk("检测到提示词注入")), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-tripwire",
        runId: "run-tripwire",
      }),
    );

    const failed = draftingFailures(frames);
    expect(failed).toHaveLength(1);
    const f0 = failed[0];
    if (f0?.kind !== "stream" || f0.data.kind !== "draftingFailed") {
      throw new Error("expected draftingFailed frame");
    }
    expect(f0.data.data.retriable).toBe(false);
    expect(f0.data.data.reason).toContain("prompt-injection-detector");
    expect(textBodies(frames).some((body) => body.includes("安全护栏"))).toBe(true);
    expect(state.messages.at(-1)?.content).toContain("安全护栏");
    expect(result.terminalOutcome.kind).toBe("error");
  });

  it.each([
    ["ordinary error", errorChunk("Unauthorized", { statusCode: 401 })],
    ["tripwire", tripwireChunk("检测到提示词注入")],
  ])("runAgentTurn 的 %s 只以 stream end:error 收口，不再失败后 end:done", async (_label, terminalChunk) => {
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const { qingagentAgent } = await import("../agents/qingagent.js");
    vi.mocked(qingagentAgent.stream).mockResolvedValueOnce({
      runId: `run-terminal-${_label}`,
      fullStream: streamOf(terminalChunk),
    } as never);

    const frames = await collectFrames(
      runAgentTurn(createSession(`terminal-${_label}`), "开始"),
    );
    const ends = frames.filter(
      (frame) => frame.kind === "stream" && frame.data.kind === "end",
    );
    expect(draftingFailures(frames)).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]?.kind === "stream" && ends[0].data.kind === "end"
      ? ends[0].data.data.reason.kind
      : null).toBe("error");
    expect(frames.some(
      (frame) =>
        frame.kind === "stream" &&
        frame.data.kind === "end" &&
        frame.data.data.reason.kind === "done",
    )).toBe(false);
  });

  it("错误发生前已有 writeDraft 候选时先结算正文资产，再以 error outcome 返回", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const sessionId = "terminal-error-settles-draft";
    const state = createSession(sessionId);
    const generatedSections: LegacySection[] = [{
      kind: "p",
      data: { text: "错误前已经完成的候选正文" },
    }];
    const generatedDoc = legacySectionsToPm(generatedSections as never);
    state.docDraftCandidateDoc = generatedDoc;
    state.docDraftCandidateSections =
      pmToLegacySections(generatedDoc) as unknown as LegacySection[];

    try {
      const args = { title: "测试", outline: "大纲" };
      const { frames, result } = await collectFramesAndReturn(
        processAgentStream(
          streamOf(
            {
              type: "tool-call",
              payload: {
                toolName: "writeDraft",
                toolCallId: "wd-before-error",
                args,
              },
            },
            {
              type: "tool-result",
              payload: {
                toolName: "writeDraft",
                toolCallId: "wd-before-error",
                args,
                result: { ok: true, blockCount: 1, wordCount: 13 },
              },
            },
            errorChunk("upstream failed", { statusCode: 500 }),
          ),
          {
            state,
            agentMessageId: "agent-before-error",
            streamId: "stream-before-error",
            runId: "run-before-error",
          },
        ),
      );

      expect(result.terminalOutcome.kind).toBe("error");
      expect(result.finalDocument?.version).toBe(1);
      expect(frames.some(
        (frame) =>
          frame.kind === "docGenerationEvent" &&
          frame.data.kind === "generation_finished",
      )).toBe(true);
      expect(state.docVersion).toBe(1);
      expect(state.doc).toEqual(generatedDoc);
    } finally {
      await deleteDocumentFamily(sessionId);
    }
  }, 10_000);

  it("runAgentTurn 在 caller 层重试零产出瞬态错误,第二次成功且不重复写 memory", async () => {
    vi.useFakeTimers();
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const { qingagentAgent } = await import("../agents/qingagent.js");
    const streamMock = vi.mocked(qingagentAgent.stream);
    const state = createSession("err-retry-ok");

    streamMock
      .mockResolvedValueOnce({
        runId: "run-retry-0",
        fullStream: streamOf(
          { type: "text-delta", payload: { text: "\u200b\u2060" } },
          errorChunk("read ECONNRESET"),
        ),
      } as never)
      .mockResolvedValueOnce({
        runId: "run-retry-1",
        fullStream: streamOf({ type: "text-delta", payload: { text: "第二次成功" } }),
      } as never);

    const framesPromise = collectFrames(runAgentTurn(state, "你好"));
    await vi.waitFor(() => expect(streamMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(401);
    const frames = await framesPromise;

    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(draftingFailures(frames)).toHaveLength(0);
    expect(textBodies(frames).some((b) => b.includes("第二次成功"))).toBe(true);
    expect(textBodies(frames).some((b) => b.includes("连接失败"))).toBe(false);
    const streamCalls = streamMock.mock.calls as unknown as Array<
      [unknown, {
        memory?: unknown;
        abortSignal?: unknown;
        modelSettings?: { maxOutputTokens?: number };
      }]
    >;
    const firstOptions = streamCalls[0]?.[1];
    const secondOptions = streamCalls[1]?.[1];
    if (!firstOptions || !secondOptions) {
      throw new Error("expected stream options for both attempts");
    }
    expect(firstOptions.memory).toBeTruthy();
    expect(secondOptions.memory).toBeUndefined();
    expect(firstOptions.abortSignal).toBe(secondOptions.abortSignal);
    expect(firstOptions.modelSettings?.maxOutputTokens).toBe(65_536);
    expect(secondOptions.modelSettings?.maxOutputTokens).toBe(65_536);
  });

  it("idle-timeout 零产出只自动重试 1 次，并为已 abort 的尝试更换 signal", async () => {
    vi.useFakeTimers();
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const { qingagentAgent } = await import("../agents/qingagent.js");
    const streamMock = vi.mocked(qingagentAgent.stream);
    const state = createSession("idle-retry-once");

    streamMock
      .mockResolvedValueOnce({ runId: "run-idle-retry-0", fullStream: neverStream() } as never)
      .mockResolvedValueOnce({ runId: "run-idle-retry-1", fullStream: neverStream() } as never);

    const framesPromise = collectFrames(runAgentTurn(
      state,
      "请写稿",
      [],
      [],
      [],
      null,
      undefined,
      undefined,
      undefined,
      { idleTimeoutMs: 10, firstChunkTimeoutMs: 20 },
    ));
    await vi.waitFor(() => expect(streamMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(401);
    await vi.waitFor(() => expect(streamMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(20);
    const frames = await framesPromise;

    expect(streamMock).toHaveBeenCalledTimes(2);
    const calls = streamMock.mock.calls as unknown as Array<
      [unknown, { abortSignal?: AbortSignal }]
    >;
    expect(calls[0]?.[1].abortSignal).not.toBe(calls[1]?.[1].abortSignal);
    expect(draftingFailures(frames)).toHaveLength(1);
    expect(textBodies(frames).filter((body) => body.includes("长时间无响应"))).toHaveLength(1);
  });

  it("idle-timeout 已有部分正文时不自动重试", async () => {
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const { qingagentAgent } = await import("../agents/qingagent.js");
    const streamMock = vi.mocked(qingagentAgent.stream);
    streamMock.mockResolvedValueOnce({
      runId: "run-idle-partial",
      fullStream: streamOf(
        { type: "text-delta", payload: { text: "已生成一部分" } },
        idleTimeoutChunk(),
      ),
    } as never);

    const frames = await collectFrames(runAgentTurn(createSession("idle-partial-no-retry"), "请写稿"));

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(textBodies(frames)).toContain("已生成一部分");
    expect(draftingFailures(frames)).toHaveLength(1);
  });

  it("idle-timeout 已执行副作用工具时不自动重试", async () => {
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const { qingagentAgent } = await import("../agents/qingagent.js");
    const streamMock = vi.mocked(qingagentAgent.stream);
    streamMock.mockResolvedValueOnce({
      runId: "run-idle-side-effect",
      fullStream: streamOf(
        {
          type: "tool-call",
          payload: {
            toolName: "parseFile",
            toolCallId: "tc-idle-side-effect",
            args: {},
          },
        },
        idleTimeoutChunk(),
      ),
    } as never);

    const frames = await collectFrames(runAgentTurn(
      createSession("idle-side-effect-no-retry"),
      "请解析文件",
    ));

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(draftingFailures(frames)).toHaveLength(1);
  });

  it("runAgentTurn 退避中取消后不再发起下一次 stream", async () => {
    vi.useFakeTimers();
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const { qingagentAgent } = await import("../agents/qingagent.js");
    const streamMock = vi.mocked(qingagentAgent.stream);
    const state = createSession("err-retry-aborted-during-backoff");

    streamMock.mockResolvedValueOnce({
      runId: "run-retry-aborted-0",
      fullStream: streamOf(errorChunk("read ECONNRESET")),
    } as never);

    const framesPromise = collectFrames(runAgentTurn(state, "你好"));
    await vi.waitFor(() => expect(streamMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(state._abortController).not.toBeNull());
    state._abortController?.abort("user_abort");
    const frames = await framesPromise;

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(draftingFailures(frames)).toHaveLength(0);
  });

  it("runAgentTurn 重试耗尽后只产出一次可见连接失败", async () => {
    vi.useFakeTimers();
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const { qingagentAgent } = await import("../agents/qingagent.js");
    const streamMock = vi.mocked(qingagentAgent.stream);
    const state = createSession("err-retry-exhausted");

    streamMock
      .mockResolvedValueOnce({
        runId: "run-retry-0",
        fullStream: streamOf(errorChunk("other side closed")),
      } as never)
      .mockResolvedValueOnce({
        runId: "run-retry-1",
        fullStream: streamOf(errorChunk("fetch failed")),
      } as never)
      .mockResolvedValueOnce({
        runId: "run-retry-2",
        fullStream: streamOf(errorChunk("terminated")),
      } as never);

    const framesPromise = collectFrames(runAgentTurn(state, "你好"));
    await vi.waitFor(() => expect(streamMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(401);
    await vi.waitFor(() => expect(streamMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(801);
    const frames = await framesPromise;

    expect(streamMock).toHaveBeenCalledTimes(3);
    const failed = draftingFailures(frames);
    expect(failed).toHaveLength(1);
    const f0 = failed[0];
    if (f0?.kind === "stream" && f0.data.kind === "draftingFailed") {
      expect(f0.data.data.retriable).toBe(true);
      expect(f0.data.data.reason).toContain("连接失败");
    } else {
      throw new Error("expected draftingFailed frame");
    }
    const bodies = textBodies(frames);
    expect(bodies.filter((b) => b.includes("连接失败"))).toHaveLength(1);
  });

  it("持续网络错误跨框架与回合层的 provider 调用总次数上界为 15", async () => {
    vi.useFakeTimers();
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const { qingagentAgent } = await import("../agents/qingagent.js");
    const {
      wrapToolCallRepairingModel,
    } = await import("../llm/repairingModel.js");
    const providerError = Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
    const providerDoStream = vi.fn(async (_options?: unknown) => {
      throw providerError;
    });
    const repairingModel = wrapToolCallRepairingModel({
      specificationVersion: "v3" as const,
      provider: "test",
      modelId: "persistent-network-error",
      supportedUrls: {},
      doGenerate: providerDoStream,
      doStream: providerDoStream,
    });
    const streamMock = vi.mocked(qingagentAgent.stream);
    streamMock.mockImplementation((async (...args: any[]) => {
      const options = args[1];
      const frameworkAttempts = Number(options.modelSettings.maxRetries) + 1;
      for (let attempt = 0; attempt < frameworkAttempts; attempt += 1) {
        await repairingModel.doStream({} as never).catch(() => undefined);
      }
      return {
        runId: `run-network-upper-${streamMock.mock.calls.length}`,
        fullStream: streamOf(errorChunk("fetch failed")),
      } as never;
    }) as never);

    const framesPromise = collectFrames(runAgentTurn(createSession("network-retry-upper"), "你好"));
    await vi.waitFor(() => expect(streamMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(401);
    await vi.waitFor(() => expect(streamMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(801);
    await framesPromise;

    // Mastra maxRetries=4 => 每回合最多 5 次；TURN_RETRY_LIMIT=2 => 最多 3 回合。
    const expectedUpperBound = 5 * 3;
    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(providerDoStream).toHaveBeenCalledTimes(expectedUpperBound);
    expect(providerDoStream.mock.calls.length).toBeLessThanOrEqual(expectedUpperBound);
  });

  it.each([401, 403])("模型鉴权失败 %s 标记为不可重试并提示检查密钥", async (statusCode) => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession(`err-auth-${statusCode}`);

    const frames = await collectFrames(
      processAgentStream(streamOf(errorChunk("Unauthorized", { statusCode })), {
        state,
        agentMessageId: "agent-msg",
        streamId: `stream-auth-${statusCode}`,
        runId: `run-auth-${statusCode}`,
      }),
    );

    const failed = draftingFailures(frames);
    expect(failed).toHaveLength(1);
    const f0 = failed[0];
    if (f0?.kind !== "stream" || f0.data.kind !== "draftingFailed") {
      throw new Error("expected draftingFailed frame");
    }
    expect(f0.data.data.retriable).toBe(false);
    expect(f0.data.data.reason).toContain("模型密钥");
    expect(textBodies(frames).some((body) => body.includes("模型密钥"))).toBe(true);
  });

  it("模型余额/配额不足 402 标记为不可重试并附带检查余额动作", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("err-quota-402");

    const frames = await collectFrames(
      processAgentStream(streamOf(errorChunk("Payment required", { statusCode: 402 })), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-quota-402",
        runId: "run-quota-402",
      }),
    );

    const failed = draftingFailures(frames);
    expect(failed).toHaveLength(1);
    const f0 = failed[0];
    if (f0?.kind !== "stream" || f0.data.kind !== "draftingFailed") {
      throw new Error("expected draftingFailed frame");
    }
    expect(f0.data.data.retriable).toBe(false);
    expect(f0.data.data.statusCode).toBe(402);
    expect(f0.data.data.category).toBe("quota");
    expect(f0.data.data.action).toBe("check_balance");
    expect(f0.data.data.reason).toContain("余额");
    expect(textBodies(frames).some((body) => body.includes("余额"))).toBe(true);
  });

  it.each([429, 500])("模型服务状态码 %s 标记为可重试", async (statusCode) => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession(`err-retriable-${statusCode}`);

    const frames = await collectFrames(
      processAgentStream(streamOf(errorChunk("upstream failed", { statusCode })), {
        state,
        agentMessageId: "agent-msg",
        streamId: `stream-retriable-${statusCode}`,
        runId: `run-retriable-${statusCode}`,
      }),
    );

    const failed = draftingFailures(frames);
    expect(failed).toHaveLength(1);
    const f0 = failed[0];
    if (f0?.kind !== "stream" || f0.data.kind !== "draftingFailed") {
      throw new Error("expected draftingFailed frame");
    }
    expect(f0.data.data.retriable).toBe(true);
    expect(f0.data.data.reason).toContain("重试");
  });

  it("已看到工具调用后遇到瞬态 error chunk:不重试,直接给可见失败", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("err-tool-call");

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          { type: "tool-call", payload: { toolName: "parseFile", toolCallId: "tc-1", args: {} } },
          errorChunk("other side closed"),
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-tool-call",
          runId: "run-tool-call",
        },
      ),
    );

    expect(draftingFailures(frames)).toHaveLength(1);
    expect(textBodies(frames).some((b) => b.includes("连接失败"))).toBe(true);
  });

  it("p04 回归:askUser 工具活动不阻断瞬态重试资格(sawSideEffectToolCall 仍为 false)", async () => {
    // 问卷恢复流会重放 askUser 的 tool-call/result chunk;此前 sawToolCall 一刀切
    // 挡掉重试,问卷确认后的瞬断只能让用户手动重试。新语义:askUser 不算副作用。
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("err-askuser-transient");

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(
        streamOf(
          { type: "tool-call", payload: { toolName: "askUser", toolCallId: "tc-ask", args: {} } },
          {
            type: "tool-result",
            payload: { toolName: "askUser", toolCallId: "tc-ask", args: {}, result: { suppressed: false } },
          },
          errorChunk("read ECONNRESET"),
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-askuser-transient",
          runId: "run-askuser-transient",
        },
      ),
    );

    // 瞬断被标记为可重试(transientErrorChunk 透出),且不在本层弹可见失败。
    expect(result.transientErrorChunk).toBeDefined();
    expect(result.sawToolCall).toBe(true);
    expect(result.sawSideEffectToolCall).toBe(false);
    expect(draftingFailures(frames)).toHaveLength(0);
  });

  it("N2 回归:askuser-progress 已发问卷帧后瞬断不重跑整轮", async () => {
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const { qingagentAgent } = await import("../agents/qingagent.js");
    const streamMock = vi.mocked(qingagentAgent.stream);
    streamMock.mockResolvedValueOnce({
      runId: "run-askuser-progress",
      fullStream: streamOf(
        {
          type: "tool-output",
          payload: {
            toolCallId: "ask-progress",
            output: {
              type: "askuser-progress",
              questions: [
                {
                  id: "question-1",
                  label: "请选择",
                  kind: "single",
                  options: [{ value: "yes", label: "是", description: null, preview: null }],
                  placeholder: null,
                },
              ],
            },
          },
        },
        errorChunk("read ECONNRESET"),
      ),
    } as never);

    const frames = await collectFrames(runAgentTurn(createSession("err-askuser-progress"), "开始"));

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(frames.some((frame) => frame.kind === "toolCallUpdated")).toBe(true);
  });

  it("abort/cancel error chunk 不按瞬态重试,仍直接报错", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("err-abort");

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(
        streamOf(errorChunk("The operation was aborted", { name: "AbortError" })),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-abort",
          runId: "run-abort",
        },
      ),
    );

    expect(result.transientErrorChunk).toBeUndefined();
    expect(draftingFailures(frames)).toHaveLength(1);
    expect(textBodies(frames).some((b) => b.includes("连接失败"))).toBe(true);
  });

  it("空流(无 error chunk)仍走原'空轮兜底',文案与连接失败区分开", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("err-2");

    const frames = await collectFrames(
      processAgentStream(streamOf(), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-err-2",
        runId: "run-err-2",
      }),
    );

    // 空轮也产 draftingFailed,但文案是"没有返回任何内容",不是"连接失败"——
    // 证明 error 分支是独立的、不会误触发、文案专属。
    const failed = draftingFailures(frames);
    expect(failed).toHaveLength(1);
    const failedReason =
      failed[0]?.kind === "stream" && failed[0].data.kind === "draftingFailed"
        ? failed[0].data.data.reason
        : "";
    expect(failedReason).toContain("没有返回任何内容");
    const bodies = textBodies(frames);
    expect(bodies.some((b) => b.includes("没有返回任何内容"))).toBe(true);
    expect(bodies.some((b) => b.includes("连接失败"))).toBe(false);
  });

  it("用户主动 abort 后的零内容轮不产 emptyNotice 气泡或 draftingFailed 帧", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("err-empty-aborted");
    const abortController = new AbortController();
    abortController.abort();

    const frames = await collectFrames(
      processAgentStream(streamOf(), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-empty-aborted",
        runId: "run-empty-aborted",
        abortController,
      }),
    );

    expect(draftingFailures(frames)).toHaveLength(0);
    expect(textBodies(frames).some((b) => b.includes("没有返回任何内容"))).toBe(false);
    expect(JSON.stringify(state.messages)).not.toContain("没有返回任何内容");
  });

  it("用户主动 abort 后即使上游流未结束也不把 idle timeout 报成失败", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("err-aborted-then-idle-timeout");
    const abortController = new AbortController();
    abortController.abort();

    const framesPromise = collectFrames(
      processAgentStream(neverStream(), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-aborted-then-idle-timeout",
        runId: "run-aborted-then-idle-timeout",
        idleTimeoutMs: 1,
        abortController,
      }),
    );

    const frames = await framesPromise;
    const bodies = textBodies(frames);

    expect(draftingFailures(frames)).toHaveLength(0);
    expect(bodies.some((b) => b.includes("长时间无响应"))).toBe(false);
    expect(bodies.some((b) => b.includes("没有返回任何内容"))).toBe(false);
  });

  it("用户主动 abort 后不写入已排队的正文和工具 chunk", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("err-tool-aborted");
    const abortController = new AbortController();
    abortController.abort();

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          { type: "text-delta", payload: { text: "中断前正文" } },
          {
            type: "tool-call",
            payload: {
              toolName: "parseFile",
              toolCallId: "tc-abort-tool",
              args: { filename: "a.txt" },
            },
          },
          { type: "step-finish", payload: { finishReason: "tool-calls" } },
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-tool-aborted",
          runId: "run-tool-aborted",
          abortController,
        },
      ),
    );

    const bodies = textBodies(frames);
    expect(bodies).not.toContain("中断前正文");
    expect(bodies.some((b) => b.includes("步数上限"))).toBe(false);
    expect(bodies.some((b) => b.includes("继续"))).toBe(false);
    expect(draftingFailures(frames)).toHaveLength(0);
    expect(findToolCallSpec(state.chatHistory, "tc-abort-tool")).toBeNull();
  });

  it("planDraft 执行中用户取消不产生 rejected 或失败卡", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("planning-abort-during-questionnaire");
    const abortController = new AbortController();
    async function* planDraftThenAbort(): AsyncGenerator<unknown> {
      yield {
        type: "tool-call",
        payload: {
          toolName: "planDraft",
          toolCallId: "plan-user-stop",
          args: {
            id: "direction",
            rationale: "确认方向",
            topic: "项目总结",
          },
        },
      };
      abortController.abort("user_abort");
      yield errorChunk("用户取消", { name: "AbortError" });
    }

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(planDraftThenAbort(), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-planning-cancelled",
        runId: "run-planning-cancelled",
        abortController,
      }),
    );

    expect(result.streamWasUserAborted).toBe(true);
    expect(draftingFailures(frames)).toHaveLength(0);
    expect(frames.some((frame) =>
      frame.kind === "toolCallUpdated" &&
      frame.data.toolCallId === "plan-user-stop" &&
      frame.data.spec.status.kind === "failed"
    )).toBe(false);
    expect(findToolCallSpec(state.chatHistory, "plan-user-stop")?.status.kind).not.toBe("failed");
    expect(JSON.stringify(frames)).not.toContain("写作方向问卷生成失败");
  });

  it("规划首步后用户 abort 会终止同一 agent turn，不再消费下一步 planDraft 问卷", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("planning-abort-before-questionnaire");
    const abortController = new AbortController();
    async function* planningSteps(): AsyncGenerator<unknown> {
      yield { type: "reasoning-delta", payload: { text: "正在判断是否需要问卷" } };
      abortController.abort("user_abort");
      yield {
        type: "tool-call",
        payload: {
          toolName: "planDraft",
          toolCallId: "plan-after-user-stop",
          args: { questions: [{ id: "topic", label: "想写什么？" }] },
        },
      };
    }

    const { frames, result } = await collectFramesAndReturn(
      processAgentStream(planningSteps(), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-planning-aborted",
        runId: "run-planning-aborted",
        abortController,
      }),
    );

    expect(result.streamWasUserAborted).toBe(true);
    expect(findToolCallSpec(state.chatHistory, "plan-after-user-stop")).toBeNull();
    expect(
      frames.some(
        (frame) =>
          frame.kind === "toolCallUpdated" &&
          frame.data.toolCallId === "plan-after-user-stop",
      ),
    ).toBe(false);
    expect(draftingFailures(frames)).toHaveLength(0);
  });

  it("内部 idle timeout 仍保留工具调用后的长时间无响应收口提示", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("err-tool-idle-timeout");
    const abortController = new AbortController();

    const frames = await collectFrames(
      processAgentStream(
        streamOf(
          { type: "text-delta", payload: { text: "已完成一部分" } },
          {
            type: "tool-call",
            payload: {
              toolName: "parseFile",
              toolCallId: "tc-idle-tool",
              args: { filename: "a.txt" },
            },
          },
          { type: "step-finish", payload: { finishReason: "tool-calls" } },
          idleTimeoutChunk(),
        ),
        {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-tool-idle-timeout",
          runId: "run-tool-idle-timeout",
          abortController,
        },
      ),
    );

    const bodies = textBodies(frames);
    expect(draftingFailures(frames)).toHaveLength(1);
    expect(bodies).toContain("已完成一部分");
    expect(bodies.some((b) => b.includes("长时间无响应"))).toBe(true);
    expect(bodies.some((b) => b.includes("没有返回任何内容"))).toBe(false);
  });

  it("首个非心跳 chunk 在宽限内到达时不按常规 idle 提前超时", async () => {
    vi.useFakeTimers();
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("first-chunk-within-grace");
    let done = false;

    const framesPromise = collectFrames(
      processAgentStream(heartbeatThenDelayedText(15), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-first-chunk-within-grace",
        runId: "run-first-chunk-within-grace",
        idleTimeoutMs: 10,
        firstChunkTimeoutMs: 20,
      }),
    ).then((frames) => {
      done = true;
      return frames;
    });

    await vi.advanceTimersByTimeAsync(11);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(5);
    const frames = await framesPromise;
    expect(draftingFailures(frames)).toHaveLength(0);
    expect(textBodies(frames)).toContain("首个真实内容");
  });

  it("start 与 step-start 元数据不关闭段首内容宽限", async () => {
    vi.useFakeTimers();
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    let done = false;
    const framesPromise = collectFrames(
      processAgentStream(metadataThenDelayedText(15), {
        state: createSession("metadata-keeps-segment-grace"),
        agentMessageId: "agent-msg",
        streamId: "stream-metadata-keeps-segment-grace",
        runId: "run-metadata-keeps-segment-grace",
        idleTimeoutMs: 10,
        firstChunkTimeoutMs: 20,
      }),
    ).then((frames) => {
      done = true;
      return frames;
    });

    await vi.advanceTimersByTimeAsync(11);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(5);
    const frames = await framesPromise;
    expect(draftingFailures(frames)).toHaveLength(0);
    expect(textBodies(frames)).toContain("首个真实内容");
  });

  it("tool-result 后重新进入段首宽限，慢于常规 idle 的模型收尾仍可到达", async () => {
    vi.useFakeTimers();
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    let done = false;
    const framesPromise = collectFrames(
      processAgentStream(postToolSegmentThenDelayedText(15), {
        state: createSession("post-tool-segment-grace"),
        agentMessageId: "agent-msg",
        streamId: "stream-post-tool-segment-grace",
        runId: "run-post-tool-segment-grace",
        idleTimeoutMs: 10,
        firstChunkTimeoutMs: 20,
      }),
    ).then((frames) => {
      done = true;
      return frames;
    });

    await vi.advanceTimersByTimeAsync(11);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(5);
    const frames = await framesPromise;
    expect(draftingFailures(frames)).toHaveLength(0);
    expect(textBodies(frames)).toEqual(expect.arrayContaining([
      "前一模型段",
      "工具后的模型收尾",
    ]));
  });

  it("tool-result 后真正死流只获得一次段首宽限，超过后仍会失败收口", async () => {
    vi.useFakeTimers();
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    let done = false;
    const framesPromise = collectFrames(
      processAgentStream(postToolSegmentThenHang(), {
        state: createSession("post-tool-dead-stream"),
        agentMessageId: "agent-msg",
        streamId: "stream-post-tool-dead-stream",
        runId: "run-post-tool-dead-stream",
        idleTimeoutMs: 10,
        firstChunkTimeoutMs: 20,
      }),
    ).then((frames) => {
      done = true;
      return frames;
    });

    await vi.advanceTimersByTimeAsync(19);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const frames = await framesPromise;
    expect(draftingFailures(frames)).toHaveLength(1);
    expect(textBodies(frames)).toContain("前一模型段");
  });

  it("无任何 chunk 时超过首 chunk 宽限才自动失败并解锁为可重试", async () => {
    vi.useFakeTimers();
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("err-idle");
    let done = false;

    const framesPromise = collectFrames(
      processAgentStream(neverStream(), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-idle",
        runId: "run-idle",
        idleTimeoutMs: 10,
        firstChunkTimeoutMs: 20,
      }),
    ).then((frames) => {
      done = true;
      return frames;
    });

    await vi.advanceTimersByTimeAsync(19);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    const frames = await framesPromise;

    expect(draftingFailures(frames)).toHaveLength(1);
    expect(textBodies(frames).some((body) => body.includes("长时间无响应"))).toBe(true);
  });

  it("默认 180s 首帧宽限被 processAgentStream 主链路实际接线", async () => {
    vi.useFakeTimers();
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const {
      AGENT_FIRST_CHUNK_TIMEOUT_MS,
      AGENT_IDLE_TIMEOUT_MS,
    } = await import("../agent-run/agentLimits.js");
    expect(AGENT_FIRST_CHUNK_TIMEOUT_MS).toBe(180_000);
    expect(AGENT_IDLE_TIMEOUT_MS).toBe(90_000);
    let done = false;

    const resultPromise = collectFramesAndReturn(
      processAgentStream(neverStream(), {
        state: createSession("default-first-chunk-wiring"),
        agentMessageId: "agent-msg",
        streamId: "stream-default-first-chunk-wiring",
        runId: "run-default-first-chunk-wiring",
        deferRetryableIdleTimeout: true,
      }),
    ).then((result) => {
      done = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(AGENT_IDLE_TIMEOUT_MS + 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(
      AGENT_FIRST_CHUNK_TIMEOUT_MS - AGENT_IDLE_TIMEOUT_MS - 2,
    );
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const { frames, result } = await resultPromise;

    expect(frames).toEqual([]);
    expect(result.retryableIdleTimeoutChunk).toBeDefined();
  });

  it("首个真实 chunk 到达后中途停顿仍按常规 idle 超时", async () => {
    vi.useFakeTimers();
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const state = createSession("idle-after-first-chunk");
    let done = false;

    const framesPromise = collectFrames(
      processAgentStream(textThenHang(), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-idle-after-first-chunk",
        runId: "run-idle-after-first-chunk",
        idleTimeoutMs: 10,
        firstChunkTimeoutMs: 20,
      }),
    ).then((frames) => {
      done = true;
      return frames;
    });

    await vi.advanceTimersByTimeAsync(9);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    const frames = await framesPromise;
    expect(draftingFailures(frames)).toHaveLength(1);
    expect(textBodies(frames)).toContain("已经开始输出");
  });

  it("reasoning-delta 会刷新 idle 计时器,避免慢推理被按初始阈值误杀", async () => {
    vi.useFakeTimers();
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const framesPromise = collectFrames(
      processAgentStream(delayedReasoningThenHang(8), {
        state: createSession("err-reasoning"),
        agentMessageId: "agent-msg",
        streamId: "stream-reasoning",
        runId: "run-reasoning",
        idleTimeoutMs: 10,
        firstChunkTimeoutMs: 20,
      }),
    );

    await vi.advanceTimersByTimeAsync(19);
    const frames = await framesPromise;
    expect(draftingFailures(frames)).toHaveLength(1);
    expect(frames.some((frame) =>
      frame.kind === "chatMessageAppended" && frame.data.part.kind === "thinking"
    )).toBe(true);
  });

  it("writeDraft 候选提交后遇 abort 仍清理草稿，继续生成不复用旧基底", async () => {
    const {
      commitPatches,
      createSession,
      processAgentStream,
      replaceDraftCandidateDoc,
      settleDraftCandidate,
    } = await import("../bridge/index.js");
    const { IDLE_TIMEOUT_ABORT_REASON } = await import("../agent-run/streamErrors.js");
    const sessionId = "idle-after-draft-checkpoint";
    await deleteDocumentFamily(sessionId);
    const state = createSession(sessionId);
    const abortController = new AbortController();
    const requestContext = new RequestContext([
      ["abortSignal", abortController.signal],
    ] as never);
    const sections: LegacySection[] = [{ kind: "p", data: { text: "已生成的候选正文" } }];
    const candidate = legacySectionsToPm(sections as never);
    state.docDraftCandidateDoc = candidate;
    state.docDraftCandidateSections = pmToLegacySections(candidate) as unknown as LegacySection[];
    const clearSpy = vi.spyOn(documentDraftRepo, "clear");

    async function* writeDraftThenTimeout(): AsyncGenerator<unknown> {
      const args = { title: "测试", outline: "大纲" };
      yield {
        type: "tool-call",
        payload: { toolName: "writeDraft", toolCallId: "wd-timeout", args },
      };
      yield {
        type: "tool-result",
        payload: {
          toolName: "writeDraft",
          toolCallId: "wd-timeout",
          args,
          result: { ok: true, blockCount: 1, wordCount: 8 },
        },
      };
      yield { type: "step-finish", payload: { finishReason: "tool-calls" } };
      yield idleTimeoutChunk();
      abortController.abort(IDLE_TIMEOUT_ABORT_REASON);
    }

    try {
      const frames = await collectFrames(
        processAgentStream(writeDraftThenTimeout(), {
          state,
          agentMessageId: "agent-msg",
          streamId: "stream-idle-after-draft-checkpoint",
          runId: "run-idle-after-draft-checkpoint",
          requestContext,
          abortController,
        }),
      );
      const bodies = textBodies(frames);
      const checkpoint = await documentDraftRepo.load(state.docId);

      expect(state.docVersion).toBe(1);
      expect(frames.some((frame) =>
        frame.kind === "documentSnapshotWritten" ||
        (frame.kind === "docGenerationEvent" && frame.data.kind === "generation_finished")
      )).toBe(true);
      expect(state.docDraftBaseDoc).toBeNull();
      expect(state.docDraftBaseVersion).toBeNull();
      expect(state.docDraftCandidateDoc).toBeNull();
      expect(checkpoint).toBeNull();
      expect(state.docState).toEqual({ kind: "editing" });
      expect(clearSpy).toHaveBeenCalledWith(state.docId);
      expect(bodies.some((body) => body.includes("已保留本轮生成的部分草稿"))).toBe(true);
      expect(bodies.some((body) => body.includes("未产出可用草稿"))).toBe(false);

      const continuedSections: LegacySection[] = [{ kind: "p", data: { text: "继续后生成的新正文" } }];
      const continuedCandidate = legacySectionsToPm(continuedSections as never);
      replaceDraftCandidateDoc(state, continuedCandidate);
      expect(state.docDraftBaseVersion).toBe(1);

      const continued = await collectFramesAndReturn(settleDraftCandidate({
        state,
        agentMessageId: "agent-msg-continued",
        streamId: "stream-idle-after-draft-continued",
        runId: "run-idle-after-draft-continued",
        wholeDocument: true,
      }));
      expect(continued.result.hunkCount).toBeGreaterThan(0);
      expect(continued.result.docWritten).toBe(false);
      expect(state.docState).toEqual({ kind: "pendingReview" });

      const commitFrames = await collectFrames(commitPatches(state, [...state.suggestions.keys()]));
      expect(state.docVersion).toBe(2);
      expect(state.doc).toEqual(continuedCandidate);
      expect(draftingFailures(continued.frames)).toHaveLength(0);
      expect(commitFrames.some((frame) => frame.kind === "docCommitted")).toBe(true);
    } finally {
      clearSpy.mockRestore();
      await deleteDocumentFamily(sessionId);
    }
  });

  it("writeDraft 零候选便 idle 超时时仍 clear 并明确提示未产出可用草稿", async () => {
    const { createSession, processAgentStream } = await import("../bridge/index.js");
    const { IDLE_TIMEOUT_ABORT_REASON } = await import("../agent-run/streamErrors.js");
    const state = createSession("idle-without-draft-candidate");
    const abortController = new AbortController();

    async function* writeDraftThenTimeout(): AsyncGenerator<unknown> {
      yield {
        type: "tool-call",
        payload: {
          toolName: "writeDraft",
          toolCallId: "wd-no-candidate",
          args: { title: "测试", outline: "大纲" },
        },
      };
      yield { type: "step-finish", payload: { finishReason: "tool-calls" } };
      yield idleTimeoutChunk();
      abortController.abort(IDLE_TIMEOUT_ABORT_REASON);
    }

    const frames = await collectFrames(
      processAgentStream(writeDraftThenTimeout(), {
        state,
        agentMessageId: "agent-msg",
        streamId: "stream-idle-without-draft-candidate",
        runId: "run-idle-without-draft-candidate",
        abortController,
      }),
    );
    const bodies = textBodies(frames);

    expect(state.docVersion).toBe(0);
    expect(state.docDraftCandidateDoc).toBeNull();
    expect(frames.some((frame) =>
      frame.kind === "documentSnapshotWritten" ||
      (frame.kind === "docGenerationEvent" && frame.data.kind === "generation_finished")
    )).toBe(false);
    expect(bodies.some((body) => body.includes("未产出可用草稿"))).toBe(true);
    expect(bodies.some((body) => body.includes("已保留本轮生成的部分草稿"))).toBe(false);
  });
});

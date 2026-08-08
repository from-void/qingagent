import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallSpec, BridgeFrame } from "@qingagent/contract-ts";
import { legacySectionsToPm } from "@qingagent/pm-schema";

// resetModules 只重置 bridge 会话状态；真实 core 保持文件级单例，避免每个用例
// 重跑整套模块初始化并重复注册进程 listeners。
const actualCore = await vi.importActual<typeof import("@qingagent/core")>("@qingagent/core");

const mockState = vi.hoisted(() => ({
  ...(() => {
    const events: Array<Record<string, unknown>> = [];
    const readAskStatus = (session: any): string | null => {
      for (const message of session.chatHistory ?? []) {
        for (const part of message.parts ?? []) {
          if (part.kind === "toolCall" && part.data?.name === "askUser") {
            return part.data.status.kind;
          }
        }
      }
      return null;
    };
    return {
      events,
      resumeStream: vi.fn(),
      listSuspendedRuns: vi.fn(async () => ({ runs: [] })),
      declineToolCall: vi.fn(),
      buildCapabilityTools: vi.fn(async () => ({})),
      ensureWorkingMemorySnapshot: vi.fn(async () => "# 用户长期记忆\n- 喜欢短句"),
      prepareOmContextForTurn: vi.fn(async (session: any) => ({
        messagesForModel: session?.messages ?? [],
        tailObservationPrompt: "[长期观察]\n- 早期事实: 用户关注结构。",
        compressed: false,
        fullTokenEstimate: 0,
        projectedTokenEstimate: 0,
        removedMessageIds: [],
        observations: "- 早期事实: 用户关注结构。",
      })),
      persistSessionMetadata: vi.fn(async (session: any, label?: string) => {
        events.push({
          kind: "persist",
          label: label ?? null,
          streamId: session.streamId,
          runId: session.runId,
          toolCallId: session.toolCallId,
          owner: session._suspensionOwner ?? null,
          askStatus: readAskStatus(session),
        });
      }),
      loadSessionFromThread: vi.fn(),
      runAgentTurn: vi.fn(async function* (session: any, userText: string) {
        events.push({
          kind: "runAgentTurn",
          runId: session.runId,
          toolCallId: session.toolCallId,
          owner: session._suspensionOwner ?? null,
          askStatus: readAskStatus(session),
          prompt: userText,
        });
        yield {
          kind: "stream",
          data: { kind: "start", data: { streamId: "fresh-stream" } },
        } satisfies BridgeFrame;
      }),
      scheduleOmSidecarAfterTurn: vi.fn((session: any, _requestContext: unknown, options: any) => {
        events.push({
          kind: "omSidecar",
          turnCounter: session.turnCounter,
          turnIndex: options?.turnIndex,
          turnStartMessageIndex: options?.turnStartMessageIndex,
        });
      }),
    };
  })(),
}));

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) {
    frames.push(frame);
  }
  return frames;
}

async function* streamOf(...chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk;
}

async function* neverStream(): AsyncGenerator<unknown> {
  await new Promise(() => undefined);
}

function showQrCall(toolCallId: string): unknown {
  return {
    type: "tool-call",
    payload: {
      toolName: "show_qr",
      toolCallId,
      args: {
        content: "https://accounts.feishu.cn/device?user_code=ABCD-EFGH",
        title: "扫码授权飞书",
        code: "ABCD-EFGH",
        note: "用飞书 App 扫码,或 [点此在浏览器授权](https://accounts.feishu.cn/device?user_code=ABCD-EFGH),授权完点下方按钮",
        expiresInSec: 600,
        refreshQuery: "飞书授权二维码过期了,请帮我重新生成",
        confirmQuery: "我已完成飞书扫码授权,请继续收尾",
      },
    },
  };
}

function writeDraftStreamingStart(toolCallId: string): unknown {
  return {
    type: "tool-call-input-streaming-start",
    payload: {
      toolName: "writeDraft",
      toolCallId,
    },
  };
}

function transientErrorChunk(message: string): unknown {
  return {
    type: "error",
    payload: {
      error: new Error(message),
    },
  };
}

function askUserToolCall(
  id: string,
  name: "askUser" | "planDraft" | "askUserQuestion" = "askUser",
): ToolCallSpec {
  return {
    id,
    name,
    render: { kind: "rightForm" },
    status: { kind: "running", data: { progressPct: null, etaSec: null } },
    body: {
      kind: "askUser",
      data: {
        id,
        mode: { kind: "fullpage" },
        purpose: { kind: "initialBrief" },
        source: null,
        rationale: null,
        questions: [
          {
            id: "q-one",
            label: "需要确认什么？",
            kind: { kind: "text" },
            options: [],
            placeholder: null,
          },
        ],
      },
    },
    result: null,
  };
}

async function loadBridge() {
  vi.resetModules();

  vi.doMock("@qingagent/core", () => {
    return {
      ...actualCore,
      buildCapabilityTools: mockState.buildCapabilityTools,
      createSessionThread: vi.fn(async () => undefined),
      persistSessionMetadata: mockState.persistSessionMetadata,
      schedulePersist: mockState.persistSessionMetadata,
      loadSessionFromThread: mockState.loadSessionFromThread.mockImplementation(
        actualCore.loadSessionFromThread,
      ),
      ensureWorkingMemorySnapshot: mockState.ensureWorkingMemorySnapshot,
      prepareOmContextForTurn: mockState.prepareOmContextForTurn,
      runAgentTurn: mockState.runAgentTurn,
      scheduleOmSidecarAfterTurn: mockState.scheduleOmSidecarAfterTurn,
      qingagentAgent: {
        ...actualCore.qingagentAgent,
        resumeStream: mockState.resumeStream,
        listSuspendedRuns: mockState.listSuspendedRuns,
        declineToolCall: mockState.declineToolCall,
      },
    };
  });

  return await import("../gateway/bridgeHandler");
}

async function createCachedSession(
  bridge: typeof import("../gateway/bridgeHandler"),
): Promise<NonNullable<ReturnType<typeof bridge.getSession>>> {
  const frames = await collectFrames(
    bridge.handleCommand({
      kind: "startSession",
      data: { mode: { kind: "new", data: { template: null } } },
    }),
  );
  const meta = frames.find((frame) => frame.kind === "sessionMeta");
  if (meta?.kind !== "sessionMeta") throw new Error("missing sessionMeta");
  const session = bridge.getSession(meta.data.sessionId);
  if (!session) throw new Error("missing session");
  return session;
}

function seedSuspendedAskUserSession(
  session: NonNullable<ReturnType<typeof import("../gateway/bridgeHandler").getSession>>,
  runId: string,
  streamId = `restored:${runId}`,
  toolName: "askUser" | "planDraft" | "askUserQuestion" = "askUser",
): void {
  session.docState = { kind: "empty" };
  session.chatHistory = [
    {
      id: "msg-user",
      role: { kind: "user" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text", data: { body: "帮我写一篇文章" } }],
      chips: null,
    },
    {
      id: "msg-ask",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "toolCall", data: askUserToolCall("ask-1", toolName) }],
      chips: null,
    },
  ];
  session.runId = runId;
  session.toolCallId = "ask-1";
  session._suspensionOwner = {
    streamId,
    runId,
    toolCallId: "ask-1",
    toolName,
  };
}

describe("handleResume askUser fresh-turn fallback", () => {
  const originalSidecar = process.env.QINGAGENT_OM_SIDECAR;

  beforeEach(() => {
    process.env.QINGAGENT_OM_SIDECAR = "1";
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mockState.events.length = 0;
    mockState.resumeStream.mockReset();
    mockState.listSuspendedRuns.mockReset();
    mockState.listSuspendedRuns.mockResolvedValue({ runs: [] });
    mockState.declineToolCall.mockReset();
    mockState.buildCapabilityTools.mockReset();
    mockState.buildCapabilityTools.mockResolvedValue({});
    mockState.ensureWorkingMemorySnapshot.mockClear();
    mockState.prepareOmContextForTurn.mockClear();
    mockState.persistSessionMetadata.mockClear();
    mockState.loadSessionFromThread.mockReset();
    mockState.runAgentTurn.mockClear();
    mockState.scheduleOmSidecarAfterTurn.mockClear();
  });

  afterEach(() => {
    if (originalSidecar === undefined) delete process.env.QINGAGENT_OM_SIDECAR;
    else process.env.QINGAGENT_OM_SIDECAR = originalSidecar;
  });

  it("consumes the askUser suspension and persists idle before starting a fresh turn", async () => {
    const bridge = await loadBridge();
    const { AGENT_MAX_STEPS, buildAskUserAnswerUserMessage } = await import("@qingagent/core");
    const session = await createCachedSession(bridge);
    session.docState = { kind: "empty" };
    session.chatHistory = [
      {
        id: "msg-user",
        role: { kind: "user" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", data: { body: "帮我写一篇文章" } }],
        chips: null,
      },
      {
        id: "msg-ask",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "toolCall", data: askUserToolCall("ask-1") }],
        chips: null,
      },
    ];
    session.runId = "run-missing";
    session.toolCallId = "ask-1";
    session._suspensionOwner = {
      streamId: "restored:run-missing",
      runId: "run-missing",
      toolCallId: "ask-1",
      toolName: "askUser",
    };

    const answers = {
      "q-one": { chosen: [], freeText: "答案A" },
    };
    const expectedAnswerMessage = buildAskUserAnswerUserMessage({
      toolCallId: "ask-1",
      spec: askUserToolCall("ask-1"),
      answers,
    });

    mockState.resumeStream.mockImplementation(async (_resumeData: unknown, options: any) => {
      mockState.events.push({
        kind: "resumeStream",
        messages: options?.requestContext?.get("messages"),
      });
      throw new Error("AGENT_RESUME_NO_SNAPSHOT_FOUND");
    });

    vi.useFakeTimers();
    try {
      const framesPromise = collectFrames(
        bridge.handleCommand({
          kind: "resumeAskUser",
          data: {
            sessionId: session.sessionId,
            toolCallId: "ask-1",
            answers,
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(3_000);
      const frames = await framesPromise;

      expect(mockState.resumeStream).toHaveBeenCalledTimes(6);
      const resumeOptions = mockState.resumeStream.mock.calls[0]?.[1];
      expect(resumeOptions?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(resumeOptions).toMatchObject({
        maxSteps: AGENT_MAX_STEPS,
        modelSettings: { maxRetries: 4 },
      });
      expect(session.runId).toBeNull();
      expect(session.toolCallId).toBeNull();
      expect(session._suspensionOwner).toBeNull();

      const toolUpdateIndex = frames.findIndex(
        (frame) =>
          frame.kind === "toolCallUpdated" &&
          frame.data.toolCallId === "ask-1",
      );
      const idleIndex = frames.findIndex(
        (frame) =>
          frame.kind === "docStateChanged" &&
          frame.data.state.kind === "empty",
      );
      const freshTurnIndex = frames.findIndex(
        (frame) =>
          frame.kind === "stream" &&
          frame.data.kind === "start" &&
          frame.data.data.streamId === "fresh-stream",
      );

      expect(toolUpdateIndex).toBeGreaterThanOrEqual(0);
      expect(idleIndex).toBeGreaterThan(toolUpdateIndex);
      expect(freshTurnIndex).toBeGreaterThan(idleIndex);
      expect(frames[toolUpdateIndex]).toMatchObject({
        kind: "toolCallUpdated",
        data: {
          spec: { status: { kind: "failed" } },
        },
      });
      expect(
        frames.some(
          (frame) =>
            frame.kind === "stream" &&
            frame.data.kind === "draftingFailed",
        ),
      ).toBe(false);

      const eventKinds = mockState.events.map((event) => event.kind);
      const firstPersistIndex = eventKinds.indexOf("persist");
      const runIndex = eventKinds.indexOf("runAgentTurn");
      expect(firstPersistIndex).toBeGreaterThanOrEqual(0);
      expect(runIndex).toBeGreaterThan(firstPersistIndex);
      expect(mockState.events[runIndex]).toMatchObject({
        kind: "runAgentTurn",
        runId: null,
        toolCallId: null,
        owner: null,
        askStatus: "failed",
      });
      expect(String(mockState.events[runIndex]?.prompt)).toContain("需要确认什么");
      expect(String(mockState.events[runIndex]?.prompt)).toContain("答案A");

      const firstResumeIndex = eventKinds.indexOf("resumeStream");
      expect(firstResumeIndex).toBeGreaterThan(firstPersistIndex);
      expect(session.messages.filter((message) =>
        typeof message.content === "string" &&
        message.content.startsWith("[askUserAnswers:ask-1]")
      )).toHaveLength(1);
      expect(session.messages.at(-1)).toEqual(expectedAnswerMessage);
      expect(mockState.events[firstResumeIndex]).toMatchObject({
        kind: "resumeStream",
      });
      const resumeMessages = mockState.events[firstResumeIndex]?.messages as Array<unknown>;
      expect(resumeMessages.at(0)).toEqual(expectedAnswerMessage);
      expect(JSON.stringify(resumeMessages.at(-1))).toContain("[长期观察]");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumeStream 首帧宽限超时后复用同一取消控制器并只转 fresh turn 一次", async () => {
    let persistedSessionId: string | null = null;
    vi.useFakeTimers();
    try {
      const bridge = await loadBridge();
      const session = await createCachedSession(bridge);
      // loadBridge 会 mock server 入口的 createSessionThread，但 processAgentStream
      // 来自 actualCore，内部仍走真实 schedulePersist。为这个看门狗集成用例补齐
      // 生产环境必有的 thread，避免 stream_end 写入失败后的退避停在 fake timer 中。
      await actualCore.createSessionThread(session.sessionId, session.title);
      persistedSessionId = session.sessionId;
      seedSuspendedAskUserSession(session, "run-watchdog-shared-abort");
      const observed: { controller: AbortController | null } = { controller: null };

      mockState.resumeStream.mockImplementation(async (_resumeData: unknown, options: any) => {
        observed.controller = session._abortController;
        expect(options.abortSignal).toBe(observed.controller?.signal);
        return {
          runId: "run-watchdog-shared-abort-resumed",
          fullStream: neverStream(),
        };
      });

      const framesPromise = collectFrames(bridge.handleCommand({
        kind: "resumeAskUser",
        data: {
          sessionId: session.sessionId,
          toolCallId: "ask-1",
          answers: { "q-one": { chosen: [], freeText: "继续" } },
        },
      }));
      await vi.waitFor(() => expect(mockState.resumeStream).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(90_001);
      expect(observed.controller?.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(90_000);
      const frames = await framesPromise;

      expect(observed.controller?.signal.aborted).toBe(true);
      expect(mockState.runAgentTurn).toHaveBeenCalledTimes(1);
      const runAgentTurnCalls = mockState.runAgentTurn.mock.calls as unknown as Array<
        unknown[]
      >;
      expect(runAgentTurnCalls[0]?.[9]).toEqual({
        idleTimeoutRetryLimit: 0,
      });
      expect(frames.some(
        (frame) => frame.kind === "stream" && frame.data.kind === "draftingFailed",
      )).toBe(false);
    } finally {
      vi.useRealTimers();
      if (persistedSessionId) {
        await actualCore.deleteSessionThread(persistedSessionId);
      }
    }
  });

  it("idle timeout 后收到用户停止时不再启动 fresh retry", async () => {
    let persistedSessionId: string | null = null;
    let cancelCompletion: Promise<unknown> | null = null;
    vi.useFakeTimers();
    try {
      const bridge = await loadBridge();
      const session = await createCachedSession(bridge);
      await actualCore.createSessionThread(session.sessionId, session.title);
      persistedSessionId = session.sessionId;
      seedSuspendedAskUserSession(session, "run-watchdog-user-cancel");
      mockState.resumeStream.mockResolvedValue({
        runId: "run-watchdog-user-cancel-resumed",
        fullStream: neverStream(),
      });
      mockState.persistSessionMetadata.mockImplementation(async (_target: any, label?: string) => {
        if (label !== "handleResume:finally" || cancelCompletion) return;
        cancelCompletion = bridge.sessionManager.submit(session.sessionId, {
          command: {
            kind: "cancelStream",
            data: { sessionId: session.sessionId },
          },
        });
        await vi.waitFor(() => expect(session._userCancelGeneration).toBe(1));
      });

      const resumeCompletion = bridge.sessionManager.submit(session.sessionId, {
        command: {
          kind: "resumeAskUser",
          data: {
            sessionId: session.sessionId,
            toolCallId: "ask-1",
            answers: { "q-one": { chosen: [], freeText: "继续" } },
          },
        },
      });
      await vi.waitFor(() => expect(mockState.resumeStream).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(180_001);
      await resumeCompletion;
      await cancelCompletion;

      expect(session._userCancelGeneration).toBe(1);
      expect(mockState.runAgentTurn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      if (persistedSessionId) {
        await actualCore.deleteSessionThread(persistedSessionId);
      }
    }
  });

  it("恢复中工具收到停止信号后立即退出且不再写进度", async () => {
    let persistedSessionId: string | null = null;
    let underlyingStarted = false;
    let releaseUnderlying!: () => void;
    let resolveUnderlyingSettled!: () => void;
    const underlyingGate = new Promise<void>((resolve) => {
      releaseUnderlying = resolve;
    });
    const underlyingSettled = new Promise<void>((resolve) => {
      resolveUnderlyingSettled = resolve;
    });
    const staleController = new AbortController();
    const writer = { write: vi.fn(async () => undefined) };
    const observed: {
      signal: AbortSignal | null;
      wrapperError: unknown;
    } = {
      signal: null,
      wrapperError: null,
    };
    const execute = vi.fn(async (_input: unknown, context: any) => {
      underlyingStarted = true;
      observed.signal = context.abortSignal;
      try {
        await context.writer.write({ type: "research-progress", phase: "fetching" });
        await underlyingGate;
        await context.writer.write({ type: "research-progress", phase: "done" });
        return { ok: true };
      } finally {
        resolveUnderlyingSettled();
      }
    });

    try {
      mockState.buildCapabilityTools.mockResolvedValue({
        abortProbe: { id: "abortProbe", execute },
      });
      const bridge = await loadBridge();
      const session = await createCachedSession(bridge);
      await actualCore.createSessionThread(session.sessionId, session.title);
      persistedSessionId = session.sessionId;
      seedSuspendedAskUserSession(session, "run-tool-abort");

      mockState.resumeStream.mockImplementation(async (_resumeData: unknown, options: any) => {
        const probe = options.toolsets.capabilityTools.abortProbe;
        return {
          runId: "run-tool-abort-resumed",
          fullStream: (async function* () {
            try {
              await probe.execute({}, {
                abortSignal: staleController.signal,
                writer,
              });
            } catch (error) {
              observed.wrapperError = error;
            }
          })(),
        };
      });

      const resumeFramesPromise = collectFrames(bridge.handleCommand({
        kind: "resumeAskUser",
        data: {
          sessionId: session.sessionId,
          toolCallId: "ask-1",
          answers: { "q-one": { chosen: [], freeText: "继续" } },
        },
      }));
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));

      const activeStreamId = session.streamId;
      const activeController = session._abortController;
      expect(activeStreamId).not.toBeNull();
      expect(observed.signal).toBe(activeController?.signal);
      expect(observed.signal).not.toBe(staleController.signal);

      const cancelFramesPromise = collectFrames(bridge.handleCommand({
        kind: "cancelStream",
        data: { streamId: activeStreamId! },
      }));
      const [resumeFrames, cancelFrames] = await Promise.all([
        resumeFramesPromise,
        cancelFramesPromise,
      ]);

      expect(observed.signal?.aborted).toBe(true);
      expect(observed.wrapperError).toMatchObject({ name: "AbortError" });
      expect(session.streamId).toBeNull();
      expect(session._abortController).toBeNull();
      expect(session._activeTurnPromise).toBeNull();
      expect(resumeFrames.some(
        (frame) => frame.kind === "stream" && frame.data.kind === "draftingFailed",
      )).toBe(false);
      expect(cancelFrames.some(
        (frame) =>
          frame.kind === "stream" &&
          frame.data.kind === "end" &&
          frame.data.data.streamId === activeStreamId &&
          frame.data.data.reason.kind === "cancelled",
      )).toBe(true);

      releaseUnderlying();
      await underlyingSettled;
      expect(writer.write).toHaveBeenCalledTimes(1);
    } finally {
      releaseUnderlying?.();
      if (underlyingStarted) await underlyingSettled;
      if (persistedSessionId) {
        await actualCore.deleteSessionThread(persistedSessionId);
      }
    }
  });

  it("快照退避中取消后不再调用 resumeStream", async () => {
    vi.useFakeTimers();
    try {
      const bridge = await loadBridge();
      const session = await createCachedSession(bridge);
      seedSuspendedAskUserSession(session, "run-cancel-backoff");
      mockState.resumeStream.mockRejectedValue(new Error("AGENT_RESUME_NO_SNAPSHOT_FOUND"));

      const framesPromise = collectFrames(bridge.handleCommand({
        kind: "resumeAskUser",
        data: {
          sessionId: session.sessionId,
          toolCallId: "ask-1",
          answers: { "q-one": { chosen: [], freeText: "继续" } },
        },
      }));
      await vi.waitFor(() => expect(mockState.resumeStream).toHaveBeenCalledTimes(1));
      session._abortController?.abort("user_abort");
      const frames = await framesPromise;

      expect(mockState.resumeStream).toHaveBeenCalledTimes(1);
      expect(mockState.runAgentTurn).not.toHaveBeenCalled();
      expect(frames.some(
        (frame) => frame.kind === "stream" && frame.data.kind === "draftingFailed",
      )).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("取消后不启动 fresh-turn fallback", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    seedSuspendedAskUserSession(session, "run-cancel-fresh-fallback");
    mockState.resumeStream.mockResolvedValue({
      runId: "run-cancel-fresh-fallback-resumed",
      fullStream: streamOf(transientErrorChunk("other side closed")),
    });
    mockState.persistSessionMetadata.mockImplementation(async (target: any, label?: string) => {
      if (label === "handleResume:finally") {
        target._abortController?.abort("user_abort");
      }
    });

    await collectFrames(bridge.handleCommand({
      kind: "resumeAskUser",
      data: {
        sessionId: session.sessionId,
        toolCallId: "ask-1",
        answers: { "q-one": { chosen: [], freeText: "继续" } },
      },
    }));

    expect(mockState.resumeStream).toHaveBeenCalledTimes(1);
    expect(mockState.runAgentTurn).not.toHaveBeenCalled();
  });

  it("does not start a fresh turn when resume emits a show_qr card before a transient error", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    session.docState = { kind: "empty" };
    session.chatHistory = [
      {
        id: "msg-user",
        role: { kind: "user" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", data: { body: "帮我写一篇文章" } }],
        chips: null,
      },
      {
        id: "msg-ask",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "toolCall", data: askUserToolCall("ask-1") }],
        chips: null,
      },
    ];
    session.runId = "run-with-qr";
    session.toolCallId = "ask-1";
    session._suspensionOwner = {
      streamId: "restored:run-with-qr",
      runId: "run-with-qr",
      toolCallId: "ask-1",
      toolName: "askUser",
    };

    mockState.resumeStream.mockResolvedValue({
      runId: "run-with-qr-resumed",
      fullStream: streamOf(
        showQrCall("qr-auth"),
        transientErrorChunk("other side closed"),
      ),
    });

    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "resumeAskUser",
        data: {
          sessionId: session.sessionId,
          toolCallId: "ask-1",
          answers: {
            "q-one": { chosen: [], freeText: "答案A" },
          },
        },
      }),
    );

    expect(mockState.resumeStream).toHaveBeenCalledTimes(1);
    expect(mockState.runAgentTurn).not.toHaveBeenCalled();
    expect(
      frames.some(
        (frame) =>
          frame.kind === "stream" &&
          frame.data.kind === "start" &&
          frame.data.data.streamId === "fresh-stream",
      ),
    ).toBe(false);
    expect(
      frames.some(
        (frame) =>
          frame.kind === "chatMessageAppended" &&
          frame.data.part.kind === "toolCall" &&
          frame.data.part.data.id === "qr-auth" &&
          frame.data.part.data.body.kind === "qrCard",
      ),
    ).toBe(true);
    expect(mockState.scheduleOmSidecarAfterTurn).toHaveBeenCalledTimes(1);
    expect(mockState.scheduleOmSidecarAfterTurn.mock.calls[0]?.[2]).toEqual({
      turnIndex: null,
      turnStartMessageIndex: null,
    });
    expect(mockState.events.at(-1)).toMatchObject({
      kind: "omSidecar",
      turnCounter: 0,
      turnIndex: null,
      turnStartMessageIndex: null,
    });
  });

  it("resumeAskUser 续写 writeDraft 参数生成前先投影 agentBusy,右侧保持锁定发光", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    seedSuspendedAskUserSession(session, "run-resume-busy");
    session.doc = legacySectionsToPm([{ kind: "p", data: { text: "已有正文" } }] as never);
    session.docState = { kind: "editing" };

    mockState.resumeStream.mockResolvedValue({
      runId: "run-resume-busy-resumed",
      fullStream: streamOf(writeDraftStreamingStart("wd-param-1")),
    });

    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "resumeAskUser",
        data: {
          sessionId: session.sessionId,
          toolCallId: "ask-1",
          answers: {
            "q-one": { chosen: [], freeText: "继续写" },
          },
        },
      }),
    );

    const askDoneIndex = frames.findIndex(
      (frame) =>
        frame.kind === "toolCallUpdated" &&
        frame.data.toolCallId === "ask-1" &&
        frame.data.spec.status.kind === "done",
    );
    const busyIndex = frames.findIndex(
      (frame) =>
        frame.kind === "docStateChanged" &&
        frame.data.state.kind === "editing" &&
        frame.data.activeOverlay === null &&
        frame.data.agentBusy === true,
    );
    const writeDraftPlaceholderIndex = frames.findIndex(
      (frame) =>
        frame.kind === "chatMessageAppended" &&
        frame.data.part.kind === "toolCall" &&
        frame.data.part.data.id === "wd-param-1" &&
        frame.data.part.data.name === "writeDraft" &&
        frame.data.part.data.body.kind === "generic" &&
        frame.data.part.data.body.data.argsJson === "",
    );

    expect(askDoneIndex).toBeGreaterThanOrEqual(0);
    expect(busyIndex).toBeGreaterThan(askDoneIndex);
    expect(writeDraftPlaceholderIndex).toBeGreaterThan(busyIndex);
  });

  it("旧终态 askUser 提交不会覆盖当前活跃问卷的 suspension 所有权", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    const staleSpec: ToolCallSpec = {
      ...askUserToolCall("ask-inline-stale"),
      status: { kind: "done" },
      result: {
        kind: "askUserAnswers",
        data: { "q-format": { chosen: ["v1"], freeText: null } },
      },
      body: {
        kind: "askUser",
        data: {
          id: "ask-inline-stale",
          mode: { kind: "overlay" },
          purpose: { kind: "quickClarification" },
          source: null,
          rationale: null,
          questions: [
            {
              id: "q-format",
              label: "想怎么调整结构？",
              kind: { kind: "single" },
              options: [
                { value: "v1", label: "保持原结构", description: null, preview: null },
                { value: "v2", label: "改成落地步骤", description: null, preview: null },
              ],
              placeholder: null,
            },
          ],
        },
      },
    };
    if (staleSpec.body.kind !== "askUser") throw new Error("expected askUser body");
    const activeSpec: ToolCallSpec = {
      ...staleSpec,
      id: "ask-inline-active",
      status: { kind: "running", data: { progressPct: null, etaSec: null } },
      result: null,
      body: {
        kind: "askUser",
        data: {
          ...staleSpec.body.data,
          id: "ask-inline-active",
        },
      },
    };
    session.docState = { kind: "editing" };
    session.chatHistory = [
      {
        id: "msg-ask-stale",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "toolCall", data: staleSpec }],
        chips: null,
      },
      {
        id: "msg-ask-active",
        role: { kind: "agent" },
        ts: "2026-01-01T00:01:00.000Z",
        parts: [{ kind: "toolCall", data: activeSpec }],
        chips: null,
      },
    ];
    session.runId = "run-inline-active";
    session.toolCallId = "ask-inline-active";
    session._suspensionOwner = {
      streamId: "restored:run-inline-active",
      runId: "run-inline-active",
      toolCallId: "ask-inline-active",
      toolName: "askUser",
    };

    await expect(collectFrames(
      bridge.handleCommand({
        kind: "resumeAskUser",
        data: {
          sessionId: session.sessionId,
          toolCallId: "ask-inline-stale",
          answers: {
            "q-format": { chosen: ["v2"], freeText: null },
          },
        },
      }),
    )).rejects.toThrow("没有待恢复的操作");

    expect(mockState.resumeStream).not.toHaveBeenCalled();
    expect(session.runId).toBe("run-inline-active");
    expect(session.toolCallId).toBe("ask-inline-active");
    expect(session._suspensionOwner).toEqual({
      streamId: "restored:run-inline-active",
      runId: "run-inline-active",
      toolCallId: "ask-inline-active",
      toolName: "askUser",
    });
    expect(session.chatHistory[0]?.parts[0]).toMatchObject({
      kind: "toolCall",
      data: { id: "ask-inline-stale", status: { kind: "done" } },
    });
    expect(session.chatHistory[1]?.parts[0]).toMatchObject({
      kind: "toolCall",
      data: { id: "ask-inline-active", status: { kind: "running" } },
    });
  });

  it("缺失 toolCallId 的延迟提交不能接管当前活跃问卷", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    seedSuspendedAskUserSession(session, "run-delayed-missing-owner");

    await expect(collectFrames(
      bridge.handleCommand({
        kind: "resumeAskUser",
        data: {
          sessionId: session.sessionId,
          answers: {
            "q-one": { chosen: [], freeText: "迟到答案" },
          },
        },
      } as never),
    )).rejects.toThrow("没有待恢复的操作");

    expect(mockState.resumeStream).not.toHaveBeenCalled();
    expect(session.runId).toBe("run-delayed-missing-owner");
    expect(session.toolCallId).toBe("ask-1");
    expect(session._suspensionOwner?.toolCallId).toBe("ask-1");
  });

  it("冷恢复 askUser 提交把命令里的 toolCallId 传给持久层恢复,避免 stale meta id 丢 runId", async () => {
    const bridge = await loadBridge();
    const { createSession } = await import("@qingagent/core");
    const session = createSession("cold-inline-session");
    const spec = askUserToolCall("ask-inline-real");
    session.docState = { kind: "editing" };
    session.chatHistory = [
      {
        id: "msg-ask-real",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "toolCall", data: spec }],
        chips: null,
      },
    ];
    session.runId = "run-cold";
    session.toolCallId = "ask-inline-real";
    session._suspensionOwner = {
      streamId: "restored:run-cold",
      runId: "run-cold",
      toolCallId: "ask-inline-real",
      toolName: "askUser",
    };
    mockState.loadSessionFromThread.mockResolvedValueOnce(session);
    mockState.resumeStream.mockResolvedValue({
      runId: "run-cold-resumed",
      fullStream: streamOf({ type: "finish", payload: {} }),
    });

    await collectFrames(
      bridge.handleCommand({
        kind: "resumeAskUser",
        data: {
          sessionId: "cold-inline-session",
          toolCallId: "ask-inline-real",
          answers: { "q-one": { chosen: [], freeText: "答案A" } },
        },
      }),
    );

    expect(mockState.loadSessionFromThread).toHaveBeenCalledWith("cold-inline-session", {
      preferredAskUserToolCallId: "ask-inline-real",
    });
    expect(mockState.resumeStream.mock.calls[0]?.[1]).toMatchObject({
      runId: "run-cold",
      toolCallId: "ask-inline-real",
    });
  });

  it("startSession(existing) 冷恢复会安全终结 resuming 确认并回放结果未知提示", async () => {
    const bridge = await loadBridge();
    const { createSession } = await import("@qingagent/core");
    const session = createSession("cold-resuming-confirm");
    const toolCallId = "tool-resuming-before-crash";
    session.threadId = session.sessionId;
    session.chatHistory = [{
      id: "msg-resuming-confirm",
      role: { kind: "agent" },
      ts: "2026-07-27T00:00:00.000Z",
      parts: [{
        kind: "toolCall",
        data: {
          id: toolCallId,
          name: "mastra_workspace_execute_command",
          render: { kind: "chatInline" },
          status: { kind: "running", data: { progressPct: null, etaSec: null } },
          body: { kind: "generic", data: { argsJson: "" } },
          result: null,
        },
      }],
      chips: null,
    }];
    session.pendingConfirms.set(toolCallId, {
      confirmId: "confirm-resuming-before-crash",
      runId: "run-resuming-before-crash",
      toolCallId,
      toolName: "mastra_workspace_execute_command",
      commandDigest: "digest",
      spec: {
        id: "confirm-resuming-before-crash",
        kind: "command",
        title: "执行命令",
        say: "将执行一条命令",
        footHint: "仅本次执行",
        primaryLabel: "执行",
        secondaryLabel: "取消",
      },
      requestedAt: "2026-07-27T00:00:00.000Z",
      expiresAt: "2099-07-27T00:00:00.000Z",
      status: "resuming",
      decisionId: "decision-before-crash",
    });
    mockState.loadSessionFromThread.mockResolvedValueOnce(session);

    const frames = await collectFrames(bridge.handleCommand({
      kind: "startSession",
      data: { mode: { kind: "existing", data: { id: session.sessionId } } },
    }));

    expect(mockState.listSuspendedRuns).toHaveBeenCalledWith({
      threadId: session.sessionId,
      resourceId: session.resourceId,
    });
    expect(session.pendingConfirms.has(toolCallId)).toBe(false);
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "confirmResolved",
      data: expect.objectContaining({
        toolCallId,
        resolution: "failed",
        message: expect.stringContaining("为避免重复操作"),
      }),
    }));
    expect(session.chatHistory[0]?.parts[0]).toMatchObject({
      kind: "toolCall",
      data: { status: { kind: "failed" } },
    });
  });

  it("askUser resume 不推进 OM turnCounter，答案由 sidecar fallback 并回挂起轮次", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    seedSuspendedAskUserSession(session, "run-om-resume-turn");
    session.turnCounter = 4;

    mockState.resumeStream.mockImplementation(async () => ({
      runId: "run-om-resume-turn-resumed",
      fullStream: streamOf({ type: "finish", payload: {} }),
    }));

    await collectFrames(
      bridge.handleCommand({
        kind: "resumeAskUser",
        data: {
          sessionId: session.sessionId,
          toolCallId: "ask-1",
          answers: {
            "q-one": { chosen: [], freeText: "继续" },
          },
        },
      }),
    );

    expect(session.turnCounter).toBe(4);
    expect(mockState.scheduleOmSidecarAfterTurn.mock.calls[0]?.[2]).toEqual({
      turnIndex: null,
      turnStartMessageIndex: null,
    });
  });

  it("askUserQuestion resume 不写 _askUserCompleted", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    seedSuspendedAskUserSession(
      session,
      "run-direct-resume",
      "restored:run-direct-resume",
      "askUserQuestion",
    );
    mockState.resumeStream.mockImplementation(async () => {
      return {
        runId: "run-direct-resumed",
        fullStream: streamOf({ type: "finish", payload: {} }),
      };
    });

    await collectFrames(bridge.handleCommand({
      kind: "resumeAskUser",
      data: {
        sessionId: session.sessionId,
        toolCallId: "ask-1",
        answers: { "q-one": { chosen: [], freeText: "直接回答" } },
      },
    }));

    expect(session._askUserCompleted).not.toBe(true);
  });

  it("resumeStream 续跑保留 updateWorkingMemory 会话工具", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    seedSuspendedAskUserSession(session, "run-wm-tool");

    mockState.resumeStream.mockImplementation(async (_resumeData: unknown, options: any) => {
      expect(options?.toolsets?.sessionScoped?.updateWorkingMemory).toBeTruthy();
      expect(typeof options.toolsets.sessionScoped.updateWorkingMemory.execute).toBe("function");
      return {
        runId: "run-wm-tool-resumed",
        fullStream: streamOf({ type: "finish", payload: {} }),
      };
    });

    await collectFrames(
      bridge.handleCommand({
        kind: "resumeAskUser",
        data: {
          sessionId: session.sessionId,
          toolCallId: "ask-1",
          answers: {
            "q-one": { chosen: [], freeText: "请记住我喜欢短句" },
          },
        },
      }),
    );

    expect(mockState.resumeStream).toHaveBeenCalledTimes(1);
  });

  it("resumeStream 续跑注入 todo、WM、OM wrapper 上下文", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    seedSuspendedAskUserSession(session, "run-wrapper-context");
    session.todos = [{ content: "补充提纲", status: "pending" }];

    mockState.resumeStream.mockImplementation(async (_resumeData: unknown, options: any) => {
      const requestContext = options?.requestContext;
      const todoSource = requestContext?.get("todoAwarenessContent");
      const toolMessages = requestContext?.get("messages");
      expect(options?.memory).toBeUndefined();
      expect(typeof todoSource).toBe("function");
      expect(todoSource()).toContain("[任务清单状态]");
      expect(requestContext?.get("qingagentWorkingMemorySnapshot")).toContain("喜欢短句");
      expect(requestContext?.get("qingagentOmObservationsPrompt")).toContain("[长期观察]");
      expect(toolMessages).not.toBe(session.messages);
      expect(JSON.stringify(toolMessages)).toContain("[长期观察]");
      return {
        runId: "run-wrapper-context-resumed",
        fullStream: streamOf({ type: "finish", payload: {} }),
      };
    });

    await collectFrames(
      bridge.handleCommand({
        kind: "resumeAskUser",
        data: {
          sessionId: session.sessionId,
          toolCallId: "ask-1",
          answers: {
            "q-one": { chosen: [], freeText: "继续" },
          },
        },
      }),
    );

    expect(mockState.ensureWorkingMemorySnapshot).toHaveBeenCalledWith(session);
    expect(mockState.prepareOmContextForTurn).toHaveBeenCalledWith(session, undefined, {
      allowCompressionActivation: false,
    });
    expect(mockState.resumeStream).toHaveBeenCalledTimes(1);
  });

  it("压缩态 resumeStream 不启用主 Mastra memory，避免投影快照污染主 Memory", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    seedSuspendedAskUserSession(session, "run-compressed-resume");
    const projectedMessages = [
      { role: "system", content: "[长期观察]\n- 早期事实已投影。" },
      { role: "user", content: "继续" },
    ];
    mockState.prepareOmContextForTurn.mockResolvedValueOnce({
      messagesForModel: projectedMessages,
      tailObservationPrompt: null,
      compressed: true,
      fullTokenEstimate: 200000,
      projectedTokenEstimate: 20000,
      removedMessageIds: ["old-1"],
      observations: "- 早期事实已投影。",
    } as any);

    mockState.resumeStream.mockImplementation(async (_resumeData: unknown, options: any) => {
      expect(options?.memory).toBeUndefined();
      expect(options?.requestContext?.get("messages")).toBe(projectedMessages);
      expect(options?.requestContext?.get("messages")).not.toBe(session.messages);
      return {
        runId: "run-compressed-resume-resumed",
        fullStream: streamOf({ type: "finish", payload: {} }),
      };
    });

    await collectFrames(
      bridge.handleCommand({
        kind: "resumeAskUser",
        data: {
          sessionId: session.sessionId,
          toolCallId: "ask-1",
          answers: {
            "q-one": { chosen: [], freeText: "继续" },
          },
        },
      }),
    );

    expect(mockState.resumeStream).toHaveBeenCalledTimes(1);
  });

  it("e2e-loop-0704 R13 回归:resumeStream 收到的答案带题面/选中项 label(模型读得懂,不再重弹同类问卷)", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    session.docState = { kind: "empty" };
    // 单选题带选项:用户提交的 chosen 是 "v2" 这类选项 value,对模型不透明。
    const spec: ToolCallSpec = {
      ...askUserToolCall("ask-1"),
      body: {
        kind: "askUser",
        data: {
          id: "ask-1",
          mode: { kind: "overlay" },
          purpose: { kind: "quickClarification" },
          source: null,
          rationale: null,
          questions: [
            {
              id: "q-format",
              label: "你希望改成什么格式？",
              kind: { kind: "single" },
              options: [
                { value: "v1", label: "保持一行式", description: null, preview: null },
                { value: "v2", label: "改用表格形式", description: null, preview: null },
              ],
              placeholder: null,
            },
            {
              id: "q-note",
              label: "补充说明",
              kind: { kind: "text" },
              options: [],
              placeholder: null,
            },
          ],
        },
      },
    };
    session.chatHistory = [
      {
        id: "msg-ask",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "toolCall", data: spec }],
        chips: null,
      },
    ];
    session.runId = "run-labels";
    session.toolCallId = "ask-1";
    session._suspensionOwner = {
      streamId: "restored:run-labels",
      runId: "run-labels",
      toolCallId: "ask-1",
      toolName: "askUser",
    };

    mockState.resumeStream.mockResolvedValue({
      runId: "run-labels-resumed",
      fullStream: streamOf({ type: "finish", payload: {} }),
    });

    await collectFrames(
      bridge.handleCommand({
        kind: "resumeAskUser",
        data: {
          sessionId: session.sessionId,
          toolCallId: "ask-1",
          answers: {
            "q-format": { chosen: ["v2"], freeText: null },
            "q-note": { chosen: [], freeText: "暂不需要应用这版修改" },
          },
        },
      }),
    );

    expect(mockState.resumeStream).toHaveBeenCalledTimes(1);
    const resumeDataSeenByModel = mockState.resumeStream.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    // 核心断言:模型在 resume tool-result 里看到的是带 label 的答案,而不是裸 "v2"。
    expect(resumeDataSeenByModel["q-format"]).toEqual({
      chosen: ["v2"],
      freeText: null,
      questionLabel: "你希望改成什么格式？",
      chosenLabels: ["改用表格形式"],
    });
    expect(resumeDataSeenByModel["q-note"]).toEqual({
      chosen: [],
      freeText: "暂不需要应用这版修改",
      questionLabel: "补充说明",
    });
  });

  it("snapshot fallback cleanup does not clear a streamId already owned by a newer turn", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    seedSuspendedAskUserSession(session, "run-owner-catch");

    mockState.resumeStream.mockImplementation(async () => {
      session.streamId = "new-owner-stream";
      throw new Error("AGENT_RESUME_NO_SNAPSHOT_FOUND");
    });

    vi.useFakeTimers();
    try {
      const framesPromise = collectFrames(
        bridge.handleCommand({
          kind: "resumeAskUser",
          data: {
            sessionId: session.sessionId,
            toolCallId: "ask-1",
            answers: {
              "q-one": { chosen: [], freeText: "答案A" },
            },
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(3_000);
      await framesPromise;

      expect(mockState.resumeStream).toHaveBeenCalledTimes(6);
      const fallbackPersist = mockState.events.find(
        (event) =>
          event.kind === "persist" &&
          event.label === "resume_failed:fresh_turn_fallback",
      );
      expect(fallbackPersist).toMatchObject({
        streamId: "new-owner-stream",
      });
      expect(session.streamId).toBe("new-owner-stream");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resume 异常只向客户端发送统一错误码，原始细节脱敏后写服务端日志", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    seedSuspendedAskUserSession(session, "run-private-error");
    mockState.resumeStream.mockRejectedValue(
      new Error("Authorization: Bearer sk-live-resume-secret x-api-key=private-resume-key"),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const frames = await collectFrames(bridge.handleCommand({
        kind: "resumeAskUser",
        data: {
          sessionId: session.sessionId,
          toolCallId: "ask-1",
          answers: { "q-one": { chosen: [], freeText: "继续" } },
        },
      }));
      const failed = frames.find(
        (frame) => frame.kind === "stream" && frame.data.kind === "draftingFailed",
      );

      expect(failed).toMatchObject({
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: {
            reason: "恢复生成失败，请重试（错误码：TURN_RESUME_FAILED）",
            retriable: true,
          },
        },
      });
      expect(JSON.stringify(failed)).not.toContain("sk-live-resume-secret");
      expect(JSON.stringify(failed)).not.toContain("private-resume-key");
      const logged = JSON.stringify(consoleError.mock.calls);
      expect(logged).toContain("TURN_RESUME_FAILED");
      expect(logged).not.toContain("sk-live-resume-secret");
      expect(logged).not.toContain("private-resume-key");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("old resume finally does not clear a streamId already owned by a newer turn", async () => {
    const bridge = await loadBridge();
    const session = await createCachedSession(bridge);
    seedSuspendedAskUserSession(session, "run-owner-finally");

    mockState.resumeStream.mockImplementation(async () => {
      throw new Error("resume failed");
    });

    const gen = bridge.handleCommand({
      kind: "resumeAskUser",
      data: {
        sessionId: session.sessionId,
        toolCallId: "ask-1",
        answers: {
          "q-one": { chosen: [], freeText: "答案A" },
        },
      },
    });

    let oldStreamId: string | null = null;
    let sawFailure = false;
    let newerAbortController: AbortController | null = null;
    let newerActiveTurnPromise: Promise<void> | null = null;

    for (;;) {
      const next = await gen.next();
      if (next.done) throw new Error("expected resume failure frames before completion");
      const frame = next.value;
      if (frame.kind === "stream" && frame.data.kind === "start") {
        oldStreamId = frame.data.data.streamId;
      }
      if (frame.kind === "stream" && frame.data.kind === "draftingFailed") {
        sawFailure = true;
      }
      if (sawFailure && frame.kind === "docStateChanged") {
        newerAbortController = new AbortController();
        newerActiveTurnPromise = Promise.resolve();
        session.streamId = "new-owner-stream";
        session._abortController = newerAbortController;
        session._activeTurnPromise = newerActiveTurnPromise;
        break;
      }
    }

    const rest = await collectFrames(gen);

    expect(oldStreamId).toBeTruthy();
    expect(rest).toContainEqual({
      kind: "stream",
      data: { kind: "end", data: { streamId: oldStreamId, reason: { kind: "done" } } },
    });
    expect(session.streamId).toBe("new-owner-stream");
    expect(session._abortController).toBe(newerAbortController);
    expect(session._activeTurnPromise).toBe(newerActiveTurnPromise);
  });
});

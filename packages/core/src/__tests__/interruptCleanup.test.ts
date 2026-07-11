import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallSpec, BridgeFrame } from "@qingagent/contract-ts";
import { legacySectionsToPm } from "@qingagent/pm-schema";
import { qingagentAgent } from "../agents/qingagent.js";

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
  qingagentAgent: {
    stream: vi.fn(),
    resumeStream: vi.fn(),
  },
}));

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) {
    frames.push(frame);
  }
  return frames;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function seedDoc(state: import("../bridge/index.js").SessionState): void {
  state.legacySections = [{ kind: "p", data: { text: "正文" } }];
  state.doc = legacySectionsToPm(state.legacySections as never);
}

function writeDraftToolCall(
  id: string,
  status: ToolCallSpec["status"],
): ToolCallSpec {
  return {
    id,
    name: "writeDraft",
    render: { kind: "chatInline" },
    status,
    body: { kind: "generic", data: { argsJson: "{\"title\":\"中断前草稿\"}" } },
    result: null,
  };
}

function runningWriteDraft(id: string): ToolCallSpec {
  return writeDraftToolCall(id, {
    kind: "running",
    data: { progressPct: 40, etaSec: null },
  });
}

function setSingleToolCall(
  state: import("../bridge/index.js").SessionState,
  spec: ToolCallSpec,
): void {
  state.chatHistory = [
    {
      id: "agent-msg",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "toolCall", data: spec }],
      chips: null,
    },
  ];
}

function firstToolStatus(
  state: import("../bridge/index.js").SessionState,
): ToolCallSpec["status"]["kind"] | null {
  const part = state.chatHistory[0]?.parts[0];
  return part?.kind === "toolCall" ? part.data.status.kind : null;
}

function findToolCallSpec(
  state: import("../bridge/index.js").SessionState,
  id: string,
): ToolCallSpec | null {
  for (const message of state.chatHistory) {
    for (const part of message.parts) {
      if (part.kind === "toolCall" && part.data.id === id) {
        return part.data;
      }
    }
  }
  return null;
}

function qingagentStreamMock(): {
  mockImplementationOnce: (impl: (...args: unknown[]) => Promise<unknown>) => void;
  mockReset: () => void;
} {
  return qingagentAgent.stream as unknown as {
    mockImplementationOnce: (impl: (...args: unknown[]) => Promise<unknown>) => void;
    mockReset: () => void;
  };
}

beforeEach(() => {
  qingagentStreamMock().mockReset();
});

describe("abortAndCleanupTurn", () => {
  it("aborts, waits for the active turn finally, terminalizes in-flight tools, and projects idle", async () => {
    const { abortAndCleanupTurn, createSession } = await import("../bridge/index.js");
    const state = createSession("abort-cleanup");
    const controller = new AbortController();
    const events: string[] = [];
    let resolveTurn!: () => void;

    state.streamId = "old-stream";
    state._abortController = controller;
    state._activeTurnPromise = new Promise<void>((resolve) => {
      resolveTurn = () => {
        events.push("old-finally");
        state.streamId = null;
        resolve();
      };
    });
    state.docDraftBaseSections = [{ kind: "p", data: { text: "base" } }];
    state.docDraftBaseVersion = 3;
    state.docDraftCandidateSections = [{ kind: "p", data: { text: "partial" } }];
    state.patchValidationResults.set("gen-1", { ok: false, applied: false });
    state._lastEmittedWireKind = "drafting";
    state.chatHistory = [
      {
        id: "agent-msg",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "toolCall", data: runningWriteDraft("draft-1") }],
        chips: null,
      },
    ];

    const framesPromise = collectFrames(abortAndCleanupTurn(state));
    await flushMicrotasks();

    expect(controller.signal.aborted).toBe(true);
    expect(state.chatHistory[0]?.parts[0]?.kind).toBe("toolCall");
    const beforeResolve = state.chatHistory[0]?.parts[0];
    expect(beforeResolve?.kind === "toolCall" ? beforeResolve.data.status.kind : null).toBe(
      "running",
    );
    expect(state.docDraftCandidateSections).not.toBeNull();

    resolveTurn();
    const frames = await framesPromise;

    expect(events).toEqual(["old-finally"]);
    expect(state.streamId).toBeNull();
    expect(state._abortController).toBeNull();
    expect(state._activeTurnPromise).toBeNull();
    expect(state.docDraftBaseSections).toBeNull();
    expect(state.docDraftBaseVersion).toBeNull();
    expect(state.docDraftCandidateSections).toBeNull();
    expect(state.patchValidationResults.size).toBe(0);

    const toolFrame = frames.find((frame) => frame.kind === "toolCallUpdated");
    expect(toolFrame).toMatchObject({
      kind: "toolCallUpdated",
      data: {
        toolCallId: "draft-1",
        spec: {
          status: {
            kind: "failed",
            data: { retriable: false, reason: "本轮生成已中断" },
          },
        },
      },
    });
    expect(frames).toContainEqual({
      kind: "docStateChanged",
      data: { state: { kind: "empty" }, activeOverlay: null, agentBusy: false },
    });
    expect(frames.at(-1)).toEqual({
      kind: "stream",
      data: {
        kind: "end",
        data: { streamId: "old-stream", reason: { kind: "cancelled" } },
      },
    });
  });

  it("R2-22 active turn 不 resolve 时也会超时孤儿化并投影 idle", async () => {
    const { abortAndCleanupTurn, createSession } = await import("../bridge/index.js");
    const state = createSession("abort-cleanup-timeout");
    const controller = new AbortController();

    state.streamId = "hung-stream";
    state._abortController = controller;
    state._activeTurnPromise = new Promise<void>(() => undefined);
    state.docDraftBaseSections = [{ kind: "p", data: { text: "base" } }];
    state.docDraftCandidateSections = [{ kind: "p", data: { text: "partial" } }];

    const frames = await collectFrames(abortAndCleanupTurn(state, { activeTurnTimeoutMs: 1 }));

    expect(controller.signal.aborted).toBe(true);
    expect(state.streamId).toBeNull();
    expect(state._abortController).toBeNull();
    expect(state._activeTurnPromise).toBeNull();
    expect(frames).toContainEqual({
      kind: "docStateChanged",
      data: { state: { kind: "empty" }, activeOverlay: null, agentBusy: false },
    });
    expect(frames.at(-1)).toEqual({
      kind: "stream",
      data: {
        kind: "end",
        data: { streamId: "hung-stream", reason: { kind: "cancelled" } },
      },
    });
  });

  it("真实 runAgentTurn 中止路径不会先把 running 工具卡补成 done", async () => {
    const { abortAndCleanupTurn, createSession, runAgentTurn } = await import("../bridge/index.js");
    const state = createSession("abort-run-agent-tool");
    let toolCallProcessed!: () => void;
    const toolCallSeen = new Promise<void>((resolve) => {
      toolCallProcessed = resolve;
    });

    qingagentStreamMock().mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[1] as { abortSignal?: AbortSignal };
      const abortSignal = options.abortSignal;
      async function* fullStream(): AsyncGenerator<unknown> {
        yield { type: "text-delta", payload: { text: "中断前正文" } };
        yield {
          type: "tool-call",
          payload: {
            toolName: "parseFile",
            toolCallId: "tc-real-abort",
            args: { filename: "a.txt" },
          },
        };
        toolCallProcessed();
        if (!abortSignal?.aborted) {
          await new Promise<void>((resolve) =>
            abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
      }
      return {
        runId: "run-real-abort",
        fullStream: fullStream(),
      } as unknown as Awaited<ReturnType<typeof qingagentAgent.stream>>;
    });

    const turnFramesPromise = collectFrames(runAgentTurn(state, "解析这个文件"));
    await toolCallSeen;
    expect(findToolCallSpec(state, "tc-real-abort")?.status.kind).toBe("running");

    const cleanupFramesPromise = collectFrames(
      abortAndCleanupTurn(state, { emitStreamEnd: false }),
    );
    const [turnFrames, cleanupFrames] = await Promise.all([
      turnFramesPromise,
      cleanupFramesPromise,
    ]);

    expect(
      turnFrames.some(
        (frame) =>
          frame.kind === "toolCallUpdated" &&
          frame.data.toolCallId === "tc-real-abort" &&
          frame.data.spec.status.kind === "done",
      ),
    ).toBe(false);
    expect(cleanupFrames).toContainEqual({
      kind: "toolCallUpdated",
      data: {
        messageId: expect.any(String),
        toolCallId: "tc-real-abort",
        spec: expect.objectContaining({
          status: {
            kind: "failed",
            data: { retriable: false, reason: "本轮生成已中断" },
          },
        }),
      },
    });
    expect(findToolCallSpec(state, "tc-real-abort")?.status).toEqual({
      kind: "failed",
      data: { retriable: false, reason: "本轮生成已中断" },
    });
  });

  it("真实 runAgentTurn 中止后 fullStream 抛 AbortError 时仍不发失败帧也不补 done", async () => {
    const { abortAndCleanupTurn, createSession, runAgentTurn } = await import("../bridge/index.js");
    const state = createSession("abort-run-agent-tool-reject");
    let toolCallProcessed!: () => void;
    const toolCallSeen = new Promise<void>((resolve) => {
      toolCallProcessed = resolve;
    });

    qingagentStreamMock().mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[1] as { abortSignal?: AbortSignal };
      const abortSignal = options.abortSignal;
      async function* fullStream(): AsyncGenerator<unknown> {
        yield { type: "text-delta", payload: { text: "中断前正文" } };
        yield {
          type: "tool-call",
          payload: {
            toolName: "parseFile",
            toolCallId: "tc-real-abort-reject",
            args: { filename: "a.txt" },
          },
        };
        toolCallProcessed();
        if (!abortSignal?.aborted) {
          await new Promise<void>((resolve) =>
            abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }
      return {
        runId: "run-real-abort-reject",
        fullStream: fullStream(),
      } as unknown as Awaited<ReturnType<typeof qingagentAgent.stream>>;
    });

    const turnFramesPromise = collectFrames(runAgentTurn(state, "解析这个文件"));
    await toolCallSeen;
    expect(findToolCallSpec(state, "tc-real-abort-reject")?.status.kind).toBe("running");

    const cleanupFramesPromise = collectFrames(
      abortAndCleanupTurn(state, { emitStreamEnd: false }),
    );
    const [turnFrames, cleanupFrames] = await Promise.all([
      turnFramesPromise,
      cleanupFramesPromise,
    ]);

    expect(
      turnFrames.some((frame) => frame.kind === "stream" && frame.data.kind === "draftingFailed"),
    ).toBe(false);
    expect(
      turnFrames.some(
        (frame) =>
          frame.kind === "toolCallUpdated" &&
          frame.data.toolCallId === "tc-real-abort-reject" &&
          frame.data.spec.status.kind === "done",
      ),
    ).toBe(false);
    expect(cleanupFrames).toContainEqual({
      kind: "toolCallUpdated",
      data: {
        messageId: expect.any(String),
        toolCallId: "tc-real-abort-reject",
        spec: expect.objectContaining({
          status: {
            kind: "failed",
            data: { retriable: false, reason: "本轮生成已中断" },
          },
        }),
      },
    });
    expect(findToolCallSpec(state, "tc-real-abort-reject")?.status).toEqual({
      kind: "failed",
      data: { retriable: false, reason: "本轮生成已中断" },
    });
  });
});

describe("finalizeLingeringRunningToolCalls", () => {
  it("finalizes orphan running writeDraft without active suspension", async () => {
    const {
      createSession,
      deriveActiveOverlay,
      deriveAgentBusy,
      deriveContentState,
      deriveEditorState,
      finalizeLingeringRunningToolCalls,
    } = await import("../bridge/index.js");
    const state = createSession("finalize-orphan-write-draft");
    seedDoc(state);
    setSingleToolCall(state, runningWriteDraft("draft-running"));

    expect(deriveActiveOverlay(state)).toBeNull();

    const updates = finalizeLingeringRunningToolCalls(state);

    expect(updates).toMatchObject([
      {
        messageId: "agent-msg",
        toolCallId: "draft-running",
        spec: { status: { kind: "done" } },
      },
    ]);
    expect(firstToolStatus(state)).toBe("done");
    expect(deriveActiveOverlay(state)).toBeNull();
    expect(deriveEditorState(
      deriveContentState(state),
      deriveAgentBusy(state),
      deriveActiveOverlay(state),
    )).not.toBe("locked");
  });

  it("finalizes orphan running writeDraft while preserving active askUser suspension", async () => {
    const {
      createSession,
      deriveActiveOverlay,
      finalizeLingeringRunningToolCalls,
      recordSuspension,
    } = await import("../bridge/index.js");
    const state = createSession("finalize-ask-user-with-running-draft");
    state.chatHistory = [
      {
        id: "agent-msg",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        chips: null,
        parts: [
          {
            kind: "toolCall",
            data: {
              id: "ask-1",
              name: "askUser",
              render: { kind: "rightForm" },
              status: { kind: "pending" },
              body: { kind: "generic", data: { argsJson: "{}" } },
              result: null,
            },
          },
          { kind: "toolCall", data: runningWriteDraft("draft-orphan") },
        ],
      },
    ];
    recordSuspension(state, {
      streamId: "stream-1",
      runId: "run-1",
      toolCallId: "ask-1",
      toolName: "askUser",
    });

    const updates = finalizeLingeringRunningToolCalls(state);

    expect(updates).toMatchObject([
      {
        messageId: "agent-msg",
        toolCallId: "draft-orphan",
        spec: { status: { kind: "done" } },
      },
    ]);
    expect(deriveActiveOverlay(state)).toBe("askUser");
    const parts = state.chatHistory[0]?.parts ?? [];
    expect(parts[0]?.kind === "toolCall" ? parts[0].data.status.kind : null).toBe("pending");
    expect(parts[1]?.kind === "toolCall" ? parts[1].data.status.kind : null).toBe("done");
  });

  it("keeps finalizing running tool calls to done", async () => {
    const { createSession, finalizeLingeringRunningToolCalls } = await import(
      "../bridge/index.js"
    );
    const state = createSession("finalize-running");
    setSingleToolCall(state, runningWriteDraft("draft-running"));

    const updates = finalizeLingeringRunningToolCalls(state);

    expect(updates).toMatchObject([
      {
        messageId: "agent-msg",
        toolCallId: "draft-running",
        spec: { status: { kind: "done" } },
      },
    ]);
    expect(firstToolStatus(state)).toBe("done");
  });
});

describe("流式参数占位的自然收尾", () => {
  it("wechat_auth_start 只有 streaming-start 后 EOF 时，在 streamEnd 前下发 failed 终态", async () => {
    const { createSession, runAgentTurn } = await import("../bridge/index.js");
    const state = createSession("wechat-auth-streaming-placeholder-eof");

    qingagentStreamMock().mockImplementationOnce(async () => {
      async function* fullStream(): AsyncGenerator<unknown> {
        yield {
          type: "tool-call-input-streaming-start",
          payload: { toolName: "wechat_auth_start", toolCallId: "wechat-auth-orphan" },
        };
      }
      return {
        runId: "run-wechat-auth-orphan",
        fullStream: fullStream(),
      } as unknown as Awaited<ReturnType<typeof qingagentAgent.stream>>;
    });

    const frames = await collectFrames(runAgentTurn(state, "帮我扫码登录微信后台"));
    const terminalIndex = frames.findIndex(
      (frame) =>
        frame.kind === "toolCallUpdated" &&
        frame.data.toolCallId === "wechat-auth-orphan" &&
        frame.data.spec.status.kind === "failed",
    );
    const streamEndIndex = frames.findIndex(
      (frame) => frame.kind === "stream" && frame.data.kind === "end",
    );

    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    expect(streamEndIndex).toBeGreaterThan(terminalIndex);
    expect(findToolCallSpec(state, "wechat-auth-orphan")).toMatchObject({
      status: {
        kind: "failed",
        data: { retriable: true, reason: "本轮未产出结果" },
      },
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";

const mockState = vi.hoisted(() => {
  const events: string[] = [];
  const abortAndCleanupTurn = vi.fn(async function* (session: any): AsyncGenerator<BridgeFrame> {
    events.push("cleanup-start");
    session._abortController?.abort();
    if (session._activeTurnPromise) {
      await session._activeTurnPromise;
    }
    events.push("cleanup-after-await");
    session.streamId = null;
    session._abortController = null;
    session._activeTurnPromise = null;
    yield {
      kind: "docStateChanged",
      data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
    };
  });
  const runAgentTurn = vi.fn(async function* (
    session: any,
    userText: string,
  ): AsyncGenerator<BridgeFrame> {
    events.push(`runAgentTurn:${userText}:stream=${session.streamId ?? "null"}`);
    yield {
      kind: "stream",
      data: { kind: "start", data: { streamId: "new-stream" } },
    };
  });
  return { events, abortAndCleanupTurn, runAgentTurn };
});

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

async function loadBridge() {
  vi.resetModules();
  vi.doMock("@qingagent/core", async () => {
    const actual = await vi.importActual<typeof import("@qingagent/core")>("@qingagent/core");
    return {
      ...actual,
      abortAndCleanupTurn: mockState.abortAndCleanupTurn,
      createSessionThread: vi.fn(async () => undefined),
      persistSessionMetadata: vi.fn(async () => undefined),
      schedulePersist: vi.fn(async () => undefined),
      runAgentTurn: mockState.runAgentTurn,
    };
  });

  return await import("../gateway/bridgeHandler");
}

async function createSession(
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

function sendMessage(sessionId: string, text = "改成 2000 字"): Command {
  return {
    kind: "sendMessage",
    data: {
      sessionId,
      text,
      mentions: [],
      skills: [],
      chips: [],
      fileIds: [],
    },
  };
}

function askUserToolCall(
  id: string,
  status: ToolCallSpec["status"] = { kind: "pending" },
): ToolCallSpec {
  return {
    id,
    name: "askUser",
    render: { kind: "rightForm" },
    status,
    body: {
      kind: "askUser",
      data: {
        id: "brief",
        mode: { kind: "fullpage" },
        purpose: { kind: "initialBrief" },
        source: null,
        rationale: null,
        questions: [],
      },
    },
    result: null,
  };
}

function attachAskUserToolCall(session: { chatHistory: any[] }, spec: ToolCallSpec): void {
  session.chatHistory.push({
    id: `agent-${spec.id}`,
    role: { kind: "agent" },
    ts: new Date().toISOString(),
    parts: [{ kind: "toolCall", data: spec }],
    chips: null,
  });
}

describe("handleCommand interrupt-and-resteer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockState.events.length = 0;
    mockState.abortAndCleanupTurn.mockClear();
    mockState.runAgentTurn.mockClear();
  });

  it("awaits the old active turn cleanup before starting the new sendMessage turn", async () => {
    const bridge = await loadBridge();
    const session = await createSession(bridge);
    const controller = new AbortController();
    let resolveOldTurn!: () => void;
    session.streamId = "old-stream";
    session._abortController = controller;
    session._activeTurnPromise = new Promise<void>((resolve) => {
      resolveOldTurn = () => {
        mockState.events.push("old-finally");
        session.streamId = null;
        resolve();
      };
    });

    const framesPromise = collectFrames(bridge.handleCommand(sendMessage(session.sessionId)));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(controller.signal.aborted).toBe(true);
    expect(mockState.abortAndCleanupTurn).toHaveBeenCalledTimes(1);
    expect(mockState.runAgentTurn).not.toHaveBeenCalled();
    expect(mockState.events).toEqual(["cleanup-start"]);

    resolveOldTurn();
    const frames = await framesPromise;

    expect(frames.map((frame) => frame.kind)).toEqual(["docStateChanged", "stream"]);
    expect(mockState.events).toEqual([
      "cleanup-start",
      "old-finally",
      "cleanup-after-await",
      "runAgentTurn:改成 2000 字:stream=null",
    ]);
    expect(mockState.runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it("dispatches cancelStream to abortAndCleanupTurn for the matching stream", async () => {
    const bridge = await loadBridge();
    const session = await createSession(bridge);
    const controller = new AbortController();
    session.streamId = "stream-cancel";
    session._abortController = controller;
    session._activeTurnPromise = Promise.resolve();

    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "cancelStream",
        data: { streamId: "stream-cancel" },
      }),
    );

    expect(controller.signal.aborted).toBe(true);
    expect(mockState.abortAndCleanupTurn).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([{
      kind: "docStateChanged",
      data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
    }]);
  });

  it("keeps askUser suspension semantics and does not interrupt", async () => {
    const bridge = await loadBridge();
    const session = await createSession(bridge);
    attachAskUserToolCall(session, askUserToolCall("ask-1"));
    session.runId = "run-ask";
    session.toolCallId = "ask-1";
    session._suspensionOwner = {
      streamId: "old-stream",
      runId: "run-ask",
      toolCallId: "ask-1",
      toolName: "askUser",
    };

    const frames = await collectFrames(bridge.handleCommand(sendMessage(session.sessionId)));

    expect(mockState.abortAndCleanupTurn).not.toHaveBeenCalled();
    expect(mockState.runAgentTurn).not.toHaveBeenCalled();
    expect(frames).toEqual([
      {
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: {
            streamId: "blocked",
            reason: "请先完成问卷",
            retriable: false,
          },
        },
      },
    ]);
  });

  it.each([
    ["terminal", askUserToolCall("ask-1", { kind: "failed", data: { retriable: false, reason: "上一轮已失败" } })],
    ["absent", null],
  ])("clears stale %s suspension and starts the new sendMessage turn", async (_label, spec) => {
    const bridge = await loadBridge();
    const session = await createSession(bridge);
    if (spec) attachAskUserToolCall(session, spec);
    session.runId = "run-ask";
    session.toolCallId = "ask-1";
    session._suspensionOwner = {
      streamId: "old-stream",
      runId: "run-ask",
      toolCallId: "ask-1",
      toolName: "askUser",
    };

    const frames = await collectFrames(bridge.handleCommand(sendMessage(session.sessionId, "继续写")));

    expect(session.runId).toBeNull();
    expect(session.toolCallId).toBeNull();
    expect(session._suspensionOwner).toBeNull();
    expect(mockState.runAgentTurn).toHaveBeenCalledTimes(1);
    expect(frames).not.toContainEqual({
      kind: "stream",
      data: {
        kind: "draftingFailed",
        data: {
          streamId: "blocked",
          reason: "请先完成问卷",
          retriable: false,
        },
      },
    });
    expect(frames.some((frame) => frame.kind === "stream")).toBe(true);
  });
});

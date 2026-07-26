import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";

const mockState = vi.hoisted(() => {
  const events: string[] = [];
  const controls: unknown[] = [];
  const abortAndCleanupTurn = vi.fn(async function* (
    session: any,
    options: { reason?: string } = {},
  ): AsyncGenerator<BridgeFrame> {
    events.push("cleanup-start");
    session._abortController?.abort();
    if (session._activeTurnPromise) {
      await session._activeTurnPromise;
    }
    events.push("cleanup-after-await");
    session.streamId = null;
    session._abortController = null;
    session._activeTurnPromise = null;
    void options;
    session._activeAgentMessageId = null;
    yield {
      kind: "docStateChanged",
      data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
    };
  });
  const runAgentTurn = vi.fn(async function* (
    session: any,
    userText: string,
    _fileIds?: unknown,
    _chips?: unknown,
    _skills?: unknown,
    _displayParts?: unknown,
    _clientMessageId?: unknown,
    _richText?: unknown,
    _reviewContext?: unknown,
    control?: unknown,
  ): AsyncGenerator<BridgeFrame> {
    controls.push(control);
    events.push(`runAgentTurn:${userText}:stream=${session.streamId ?? "null"}`);
    if (userText === "后台等待旧进程") {
      const controller = new AbortController();
      let resolveActiveTurn!: () => void;
      session.streamId = "old-wait-stream";
      session._abortController = controller;
      session._activeAgentMessageId = "old-agent-message";
      session._activeTurnPromise = new Promise<void>((resolve) => {
        resolveActiveTurn = resolve;
      });
      yield {
        kind: "chatMessageAdded",
        data: {
          message: {
            id: "old-agent-message",
            role: { kind: "agent" },
            ts: "2026-01-01T00:00:00.000Z",
            parts: [],
            chips: null,
          },
        },
      };
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) resolve();
        else controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      events.push(`old-wait-aborted:${String(controller.signal.reason)}`);
      session.streamId = null;
      session._abortController = null;
      session._activeTurnPromise = null;
      resolveActiveTurn();
      return;
    }
    yield {
      kind: "stream",
      data: { kind: "start", data: { streamId: "new-stream" } },
    };
    if (userText.includes("3+5")) {
      yield {
        kind: "chatMessageAppended",
        data: {
          messageId: "new-agent-message",
          seq: 1,
          part: { kind: "text", data: { body: "3+5=8" } },
        },
      };
    }
    if (userText.includes("终止 PID")) {
      yield {
        kind: "chatMessageAppended",
        data: {
          messageId: "new-agent-message",
          seq: 1,
          part: {
            kind: "toolCall",
            data: {
              id: "kill-current-request",
              name: "mastra_workspace_kill_process",
              render: { kind: "chatInline" },
              status: { kind: "done" },
              body: { kind: "generic", data: { argsJson: "" } },
              result: { kind: "genericText", data: "已按本轮要求终止 PID 4242" },
            },
          },
        },
      };
    }
  });
  return { events, controls, abortAndCleanupTurn, runAgentTurn };
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
    mockState.controls.length = 0;
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

  it("真实 SessionManager→SessionActor 路径：wait 中新算术题先收尾旧轮，再只回答本轮", async () => {
    const bridge = await loadBridge();
    const session = await createSession(bridge);

    const oldTurn = bridge.sessionManager.submit(session.sessionId, {
      command: sendMessage(session.sessionId, "后台等待旧进程"),
    });
    await vi.waitFor(() =>
      expect(mockState.events).toContain(
        "runAgentTurn:后台等待旧进程:stream=null",
      )
    );

    const newTurn = bridge.sessionManager.submit(session.sessionId, {
      command: sendMessage(session.sessionId, "顺便告诉我 3+5 等于几?"),
    });
    const [, newFrames] = await Promise.all([oldTurn, newTurn]);
    const emitted = newFrames.map((entry) => entry.frame);

    expect(mockState.events).toContain(
      "old-wait-aborted:preemptedByNewMessage",
    );
    expect(mockState.abortAndCleanupTurn).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ reason: "preemptedByNewMessage" }),
    );
    expect(emitted.some(
      (frame) =>
        frame.kind === "chatMessageAppended" &&
        frame.data.messageId === "old-agent-message",
    )).toBe(false);
    expect(emitted).toContainEqual(expect.objectContaining({
      kind: "chatMessageAppended",
      data: expect.objectContaining({
        part: {
          kind: "text",
          data: { body: "3+5=8" },
        },
      }),
    }));
    expect(mockState.controls.at(-1)).toEqual({
      preemptedByNewMessage: true,
    });
    expect(
      mockState.events.filter((event) => event.includes("get_process_output")),
    ).toEqual([]);
  });

  it("真实 Actor 抢占后，本轮明确 kill 仍按新输入执行，不自动续 wait", async () => {
    const bridge = await loadBridge();
    const session = await createSession(bridge);

    const oldTurn = bridge.sessionManager.submit(session.sessionId, {
      command: sendMessage(session.sessionId, "后台等待旧进程"),
    });
    await vi.waitFor(() =>
      expect(mockState.events).toContain(
        "runAgentTurn:后台等待旧进程:stream=null",
      )
    );
    const killTurn = bridge.sessionManager.submit(session.sessionId, {
      command: sendMessage(session.sessionId, "请终止 PID 4242"),
    });
    const [, killFrames] = await Promise.all([oldTurn, killTurn]);

    expect(
      killFrames.some(
        (entry) =>
          entry.frame.kind === "chatMessageAppended" &&
          entry.frame.data.part.kind === "toolCall" &&
          entry.frame.data.part.data.name === "mastra_workspace_kill_process",
      ),
    ).toBe(true);
    expect(mockState.controls.at(-1)).toEqual({
      preemptedByNewMessage: true,
    });
  });

  it("真实 Actor 全局停止按 routed session 直接清理，不依赖旧 streamId 反查", async () => {
    const bridge = await loadBridge();
    const session = await createSession(bridge);

    const oldTurn = bridge.sessionManager.submit(session.sessionId, {
      command: sendMessage(session.sessionId, "后台等待旧进程"),
    });
    await vi.waitFor(() =>
      expect(mockState.events).toContain(
        "runAgentTurn:后台等待旧进程:stream=null",
      )
    );
    const stopTurn = bridge.sessionManager.submit(session.sessionId, {
      command: {
        kind: "cancelStream",
        data: { streamId: "old-wait-stream" },
      },
    });
    await Promise.all([oldTurn, stopTurn]);

    expect(mockState.events).toContain("old-wait-aborted:globalStop");
    expect(mockState.abortAndCleanupTurn).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ reason: "globalStop" }),
    );
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
        data: { sessionId: session.sessionId, streamId: "stream-cancel" },
      }),
    );

    expect(controller.signal.aborted).toBe(true);
    expect(mockState.abortAndCleanupTurn).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([{
      kind: "docStateChanged",
      data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
    }]);
  });

  it("规划期尚无前端 streamId 时按 sessionId 中止活动流程，不再继续产出问卷", async () => {
    const bridge = await loadBridge();
    const session = await createSession(bridge);
    const controller = new AbortController();
    session.streamId = "planning-before-start-frame";
    session._abortController = controller;
    session._activeTurnPromise = Promise.resolve();

    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "cancelStream",
        data: { sessionId: session.sessionId },
      }),
    );

    expect(controller.signal.aborted).toBe(true);
    expect(mockState.abortAndCleanupTurn).toHaveBeenCalledTimes(1);
    expect(mockState.runAgentTurn).not.toHaveBeenCalled();
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

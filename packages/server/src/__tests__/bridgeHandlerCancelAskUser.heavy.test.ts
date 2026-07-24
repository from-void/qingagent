import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, ToolCallSpec, BridgeFrame } from "@qingagent/contract-ts";

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) {
    frames.push(frame);
  }
  return frames;
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
  const schedulePersist = vi.fn(async () => undefined);

  vi.doMock("@qingagent/core", async () => {
    const actual = await vi.importActual<typeof import("@qingagent/core")>("@qingagent/core");
    return {
      ...actual,
      createSessionThread: vi.fn(async () => undefined),
      persistSessionMetadata: vi.fn(async () => undefined),
      schedulePersist,
    };
  });

  return {
    bridge: await import("../gateway/bridgeHandler"),
    schedulePersist,
  };
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

describe("R0 cancelAskUser bridge red tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["askUser", "planDraft", "askUserQuestion"] as const)(
    "OL-1b clears %s suspension state and emits failed tool unlock frames",
    async (toolName) => {
    const { bridge } = await loadBridge();
    const session = await createCachedSession(bridge);
    const askUser = askUserToolCall("ask-1", toolName);
    session.docState = { kind: "empty" };
    session.previousDocState = { kind: "empty" };
    session.chatHistory = [{
      id: "msg-ask",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "toolCall", data: askUser }],
      chips: null,
    }];
    session.runId = "run-ask";
    session.toolCallId = "ask-1";
    session._suspensionOwner = {
      streamId: "stream-ask",
      runId: "run-ask",
      toolCallId: "ask-1",
      toolName,
    };
    session._lastEmittedWireKind = "empty";

    const command: Command = {
      kind: "cancelAskUser",
      data: { sessionId: session.sessionId, toolCallId: "ask-1" },
    };

    const frames = await collectFrames(bridge.handleCommand(command));

    expect(frames.map((frame) => frame.kind)).toEqual([
      "toolCallUpdated",
      "docStateChanged",
    ]);
    expect(session.runId).toBeNull();
    expect(session.toolCallId).toBeNull();
    expect(session._suspensionOwner).toBeNull();
    expect(frames[0]).toMatchObject({
      kind: "toolCallUpdated",
      data: {
        toolCallId: "ask-1",
        spec: {
          status: {
            kind: "failed",
            data: { retriable: false, reason: "用户已放弃本轮问卷" },
          },
        },
      },
    });
    expect(frames[1]).toEqual({
      kind: "docStateChanged",
      data: { state: { kind: "empty" }, activeOverlay: null, agentBusy: false },
    });
    },
  );

  it("aborts active stream when cancelling running askUser before suspension", async () => {
    const { bridge } = await loadBridge();
    const session = await createCachedSession(bridge);
    const controller = new AbortController();
    const askUser = askUserToolCall("ask-running");
    session.docState = { kind: "editing" };
    session.previousDocState = { kind: "editing" };
    session.chatHistory = [{
      id: "msg-running",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "toolCall", data: askUser }],
      chips: null,
    }];
    session.streamId = "stream-running";
    session.runId = null;
    session.toolCallId = null;
    session._suspensionOwner = null;
    session._abortController = controller;
    session._activeTurnPromise = Promise.resolve();
    session._lastEmittedWireKind = "editing:askUser:busy";

    const originalConsoleError = console.error;
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      if (String(args[0]).includes("Failed to persist session metadata")) return;
      originalConsoleError(...args);
    });
    let frames!: BridgeFrame[];
    try {
      frames = await collectFrames(bridge.handleCommand({
        kind: "cancelAskUser",
        data: { sessionId: session.sessionId, toolCallId: "ask-running" },
      }));
    } finally {
      consoleErrorSpy.mockRestore();
    }

    expect(controller.signal.aborted).toBe(true);
    expect(session.streamId).toBeNull();
    expect(session._abortController).toBeNull();
    expect(session._activeTurnPromise).toBeNull();
    expect(frames.map((frame) => frame.kind)).toEqual([
      "toolCallUpdated",
      "docStateChanged",
    ]);
    expect(frames[0]).toMatchObject({
      kind: "toolCallUpdated",
      data: {
        toolCallId: "ask-running",
        spec: {
          status: {
            kind: "failed",
            data: { retriable: false, reason: "用户已放弃本轮问卷" },
          },
        },
      },
    });
    expect(frames[1]).toEqual({
      kind: "docStateChanged",
      data: { state: { kind: "empty" }, activeOverlay: null, agentBusy: false },
    });
  });

  it("重复 cancelAskUser 对已取消终态幂等成功，不再报没有待放弃问卷", async () => {
    const { bridge } = await loadBridge();
    const session = await createCachedSession(bridge);
    const askUser = askUserToolCall("ask-idempotent");
    session.docState = { kind: "empty" };
    session.previousDocState = { kind: "empty" };
    session.chatHistory = [{
      id: "msg-idempotent",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "toolCall", data: askUser }],
      chips: null,
    }];
    session.runId = "run-idempotent";
    session.toolCallId = askUser.id;
    session._suspensionOwner = {
      streamId: "stream-idempotent",
      runId: "run-idempotent",
      toolCallId: askUser.id,
      toolName: "askUser",
    };

    const command: Command = {
      kind: "cancelAskUser",
      data: { sessionId: session.sessionId, toolCallId: askUser.id },
    };
    const first = await collectFrames(bridge.handleCommand(command));
    const repeated = await collectFrames(bridge.handleCommand(command));

    expect(first.map((frame) => frame.kind)).toEqual([
      "toolCallUpdated",
      "docStateChanged",
    ]);
    expect(repeated).toEqual([]);
    expect(session.chatHistory[0]?.parts[0]).toMatchObject({
      kind: "toolCall",
      data: {
        status: {
          kind: "failed",
          data: { reason: "用户已放弃本轮问卷" },
        },
      },
    });
  });

  it("P1-11:取消终态持久化失败会向 actor 抛出，不能只记日志后静默成功", async () => {
    const { bridge, schedulePersist } = await loadBridge();
    const session = await createCachedSession(bridge);
    const askUser = askUserToolCall("ask-persist-failure");
    session.docState = { kind: "editing" };
    session.previousDocState = { kind: "editing" };
    session.chatHistory = [{
      id: "msg-persist-failure",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "toolCall", data: askUser }],
      chips: null,
    }];
    session.runId = "run-persist-failure";
    session.toolCallId = askUser.id;
    session._suspensionOwner = {
      streamId: "stream-persist-failure",
      runId: "run-persist-failure",
      toolCallId: askUser.id,
      toolName: "askUser",
    };
    schedulePersist.mockClear();
    schedulePersist.mockRejectedValueOnce(new Error("primary persistence unavailable"));

    const generator = bridge.handleCommand({
      kind: "cancelAskUser",
      data: { sessionId: session.sessionId, toolCallId: askUser.id },
    });

    await expect(generator.next()).resolves.toMatchObject({
      value: { kind: "toolCallUpdated" },
      done: false,
    });
    await expect(generator.next()).resolves.toMatchObject({
      value: { kind: "docStateChanged" },
      done: false,
    });
    await expect(generator.next()).rejects.toThrow("primary persistence unavailable");
    expect(schedulePersist).toHaveBeenCalledWith(session, "cancelAskUser");
  });
});

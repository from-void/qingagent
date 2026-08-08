import { beforeEach, describe, expect, it, vi } from "vitest";

let restoreImpl: (
  sessionId: string,
  options?: { preferredAskUserToolCallId?: string | null; mode?: "activate" | "snapshot" },
) => unknown = (sessionId) => ({ sessionId, docId: sessionId });
const loadSessionFromThread = vi.fn(
  async (
    sessionId: string,
    options?: { preferredAskUserToolCallId?: string | null; mode?: "activate" | "snapshot" },
  ) => restoreImpl(sessionId, options),
);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function loadLifecycle() {
  vi.resetModules();
  loadSessionFromThread.mockClear();
  vi.doMock("@qingagent/core", async () => {
    const actual = await vi.importActual<typeof import("@qingagent/core")>("@qingagent/core");
    return { ...actual, loadSessionFromThread };
  });
  return import("../sessionLifecycle.js");
}

describe("只读会话恢复", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    restoreImpl = (sessionId) => ({ sessionId, docId: sessionId });
  });

  it("getOrRestoreSessionReadOnly 与 sessionExists 都使用纯 snapshot 模式且不注册 sessions", async () => {
    const lifecycle = await loadLifecycle();

    const restored = await lifecycle.getOrRestoreSessionReadOnly("snapshot-session");
    await expect(lifecycle.sessionExists("exists-session")).resolves.toBe(true);

    expect(restored?.sessionId).toBe("snapshot-session");
    expect(loadSessionFromThread).toHaveBeenNthCalledWith(1, "snapshot-session", {
      mode: "snapshot",
    });
    expect(loadSessionFromThread).toHaveBeenNthCalledWith(2, "exists-session", {
      mode: "snapshot",
    });
    expect(lifecycle.getSession("snapshot-session")).toBeUndefined();
    expect(lifecycle.getSession("exists-session")).toBeUndefined();
  });

  it("cached 缺 runId 时只合并恢复挂起字段，保留未持久化聊天与正文状态", async () => {
    const lifecycle = await loadLifecycle();
    const { createSession } = await import("@qingagent/core");
    const sessionId = "cached-resume-session";
    const cached = createSession(sessionId);
    cached.title = "内存新标题";
    cached.docVersion = 9;
    cached.docState = { kind: "editing" };
    cached._askUserCompleted = true;
    cached.materials.set("unpersisted-material", {
      id: "unpersisted-material",
      filename: "内存素材.md",
      mimeType: "text/markdown",
      text: "尚未持久化的素材正文",
      summary: null,
      fileId: null,
      metadata: {
        pages: null,
        wordCount: 1,
        title: "内存素材",
        parseState: "ready",
      },
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    });
    cached.chatHistory.push({
      id: "unpersisted-user-message",
      role: { kind: "user" },
      ts: "2026-07-27T00:00:00.000Z",
      parts: [{ kind: "text", data: { body: "尚未持久化的新消息" } }],
      chips: null,
    });
    lifecycle.sessions.set(sessionId, cached);

    const restored = createSession(sessionId);
    restored.title = "数据库旧标题";
    restored.docVersion = 3;
    restored.runId = "run-restored";
    restored.toolCallId = "ask-restored";
    restored.previousDocState = { kind: "editing" };
    restored._suspendedThisTurn = true;
    restored._suspensionOwner = {
      streamId: "restored:run-restored",
      runId: "run-restored",
      toolCallId: "ask-restored",
      toolName: "askUser",
    };
    restored._askUserAsked = true;
    restored.chatHistory.push({
      id: "persisted-old-message",
      role: { kind: "agent" },
      ts: "2026-07-26T00:00:00.000Z",
      parts: [{ kind: "text", data: { body: "数据库旧消息" } }],
      chips: null,
    });
    restoreImpl = () => restored;

    const result = await lifecycle.getOrRestoreSession(sessionId, {
      preferredAskUserToolCallId: "ask-restored",
    });

    expect(loadSessionFromThread).toHaveBeenCalledWith(sessionId, {
      preferredAskUserToolCallId: "ask-restored",
    });
    expect(result).toBe(cached);
    expect(lifecycle.getSession(sessionId)).toBe(cached);
    expect(result).toMatchObject({
      title: "内存新标题",
      docVersion: 9,
      docState: { kind: "editing" },
      runId: "run-restored",
      toolCallId: "ask-restored",
      previousDocState: { kind: "editing" },
      _suspendedThisTurn: true,
      _askUserCompleted: true,
      _askUserAsked: true,
    });
    expect(result?._suspensionOwner).toEqual(restored._suspensionOwner);
    expect(result?.materials.get("unpersisted-material")?.text).toBe(
      "尚未持久化的素材正文",
    );
    expect(result?.chatHistory.map((message) => message.id)).toEqual([
      "unpersisted-user-message",
    ]);
  });

  it("冷加载期间出现 cached 时合并挂起字段而不整体替换新对象", async () => {
    const lifecycle = await loadLifecycle();
    const { createSession } = await import("@qingagent/core");
    const sessionId = "restore-race-session";
    const restoreGate = deferred<ReturnType<typeof createSession>>();
    restoreImpl = () => restoreGate.promise;

    const restoring = lifecycle.getOrRestoreSession(sessionId, {
      preferredAskUserToolCallId: "ask-race",
    });
    await vi.waitFor(() => expect(loadSessionFromThread).toHaveBeenCalledTimes(1));

    const cached = createSession(sessionId);
    cached.chatHistory.push({
      id: "race-unpersisted-message",
      role: { kind: "user" },
      ts: "2026-07-27T00:00:00.000Z",
      parts: [{ kind: "text", data: { body: "冷加载期间写入" } }],
      chips: null,
    });
    lifecycle.sessions.set(sessionId, cached);

    const restored = createSession(sessionId);
    restored.runId = "run-race";
    restored.toolCallId = "ask-race";
    restored._suspendedThisTurn = true;
    restored._suspensionOwner = {
      streamId: "restored:run-race",
      runId: "run-race",
      toolCallId: "ask-race",
      toolName: "askUser",
    };
    restoreGate.resolve(restored);

    const result = await restoring;

    expect(result).toBe(cached);
    expect(lifecycle.getSession(sessionId)).toBe(cached);
    expect(result?.runId).toBe("run-race");
    expect(result?._suspensionOwner).toEqual(restored._suspensionOwner);
    expect(result?.chatHistory.map((message) => message.id)).toEqual([
      "race-unpersisted-message",
    ]);
  });
});

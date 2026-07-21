import { describe, expect, it, vi } from "vitest";
import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import { InMemoryFrameLog } from "../frameLog";
import { SessionManager } from "../sessionManager";
import type { HandleCommandFn } from "../sessionActor";

function startExisting(sessionId: string): Command {
  return {
    kind: "startSession",
    data: { mode: { kind: "existing", data: { id: sessionId } } },
  };
}

function frame(sessionId: string): BridgeFrame {
  return { kind: "sessionMeta", data: { sessionId, title: sessionId } };
}

describe("SessionManager", () => {
  it("RF5: 启动只加载 pending，completed 首次命令按主键惰性查询并缓存", async () => {
    const get = vi.fn(async (sessionId: string) => {
      if (sessionId === "completed-lazy") {
        return { sessionId, phase: "completed" as const };
      }
      return null;
    });
    const deletionStore = {
      begin: vi.fn(async (sessionId: string) => ({
        sessionId,
        phase: "draining" as const,
      })),
      list: vi.fn(async () => [{ sessionId: "pending-startup", phase: "draining" as const }]),
      get,
    };
    const manager = new SessionManager({
      handleCommand: async function* (command) {
        if (command.kind === "startSession" && command.data.mode.kind === "existing") {
          yield frame(command.data.mode.data.id);
        }
      },
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
      markSessionDeleted: vi.fn(),
      drainSessionPersistence: vi.fn(async () => undefined),
      deleteSessionThread: vi.fn(async () => undefined),
      deletionRetryDelayMs: 60_000,
      deletionStore,
    });

    await manager.resumePendingDeletions();
    expect(deletionStore.list).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    await expect(manager.submit("pending-startup", {
      command: startExisting("pending-startup"),
    })).rejects.toThrow("Session deletion is in progress");

    await expect(manager.submit("completed-lazy", {
      command: startExisting("completed-lazy"),
    })).rejects.toThrow("Session has been deleted");
    await expect(manager.submit("completed-lazy", {
      command: startExisting("completed-lazy"),
    })).rejects.toThrow("Session has been deleted");
    expect(get).toHaveBeenCalledTimes(1);

    await expect(manager.submit("active-cached", {
      command: startExisting("active-cached"),
    })).resolves.toHaveLength(1);
    await expect(manager.submit("active-cached", {
      command: startExisting("active-cached"),
    })).resolves.toHaveLength(1);
    expect(get.mock.calls.filter(([sessionId]) => sessionId === "active-cached")).toHaveLength(1);

    const boundedGet = vi.fn(async (_sessionId: string) => null);
    const boundedManager = new SessionManager({
      handleCommand: async function* (command) {
        if (command.kind === "startSession" && command.data.mode.kind === "existing") {
          yield frame(command.data.mode.data.id);
        }
      },
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
      deletionLookupCacheSize: 2,
      deletionStore: {
        begin: vi.fn(async (sessionId: string) => ({ sessionId, phase: "draining" as const })),
        list: vi.fn(async () => []),
        get: boundedGet,
      },
    });
    for (const sessionId of ["cache-a", "cache-b", "cache-c", "cache-a"]) {
      await boundedManager.submit(sessionId, { command: startExisting(sessionId) });
    }
    expect(boundedGet.mock.calls.filter(([sessionId]) => sessionId === "cache-a")).toHaveLength(2);
  });

  it("F1-R: 删除恢复按需初始化，失败后下一次调用可重试", async () => {
    const list = vi.fn(async () => []);
    list.mockRejectedValueOnce(new Error("restore failed"));
    const deletionStore = {
      begin: vi.fn(async (sessionId: string) => ({
        sessionId,
        phase: "draining" as const,
      })),
      list,
      get: vi.fn(async () => null),
    };
    const manager = new SessionManager({
      handleCommand: async function* () {
        yield frame("lazy-submit");
      },
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
      deletionStore,
    });

    await Promise.resolve();
    expect(list).not.toHaveBeenCalled();

    await expect(manager.submit("lazy-submit", {
      command: startExisting("lazy-submit"),
    })).rejects.toThrow("restore failed");
    expect(list).toHaveBeenCalledTimes(1);

    await expect(manager.submit("lazy-submit", {
      command: startExisting("lazy-submit"),
    })).resolves.toHaveLength(1);
    expect(list).toHaveBeenCalledTimes(2);

    const destroyList = vi.fn(async () => []);
    const destroyStore = {
      begin: vi.fn(async (sessionId: string) => ({
        sessionId,
        phase: "draining" as const,
      })),
      list: destroyList,
      get: vi.fn(async () => null),
    };
    const destroyManager = new SessionManager({
      handleCommand: async function* () {
        yield frame("lazy-destroy");
      },
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
      markSessionDeleted: vi.fn(),
      drainSessionPersistence: vi.fn(async () => undefined),
      deleteSessionThread: vi.fn(async () => undefined),
      deletionStore: destroyStore,
    });

    await Promise.resolve();
    expect(destroyList).not.toHaveBeenCalled();
    await expect(destroyManager.destroySession("lazy-destroy")).resolves.toEqual({
      deleted: true,
      status: "completed",
    });
    expect(destroyList).toHaveBeenCalledTimes(1);
  });

  it("F1: 删除排空超时后新实例从持久化墓碑续跑，完成前只返回 pending", async () => {
    const records = new Map<string, { sessionId: string; phase: "draining" | "completed" }>();
    const deletionStore = {
      begin: vi.fn(async (sessionId: string) => {
        const record = records.get(sessionId) ?? { sessionId, phase: "draining" as const };
        records.set(sessionId, record);
        return record;
      }),
      list: vi.fn(async () => [...records.values()].filter((record) => record.phase !== "completed")),
      get: vi.fn(async (sessionId: string) => records.get(sessionId) ?? null),
    };
    const firstManager = new SessionManager({
      handleCommand: async function* () {
        yield frame("restart-pending");
      },
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
      markSessionDeleted: vi.fn(),
      drainSessionPersistence: vi.fn(async () => {
        throw new Error("drain timed out");
      }),
      deleteSessionThread: vi.fn(async () => undefined),
      deletionRetryDelayMs: 60_000,
      deletionStore,
    });

    const pending = await firstManager.destroySession("restart-pending", 5);
    expect(pending).toEqual({ deleted: false, status: "pending" });
    expect(records.get("restart-pending")?.phase).toBe("draining");

    const resumedDelete = vi.fn(async () => {
      records.set("restart-pending", {
        sessionId: "restart-pending",
        phase: "completed",
      });
    });
    const restartedManager = new SessionManager({
      handleCommand: async function* () {
        yield frame("restart-pending");
      },
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
      markSessionDeleted: vi.fn(),
      drainSessionPersistence: vi.fn(async () => undefined),
      deleteSessionThread: resumedDelete,
      deletionRetryDelayMs: 1,
      deletionStore,
    });

    await restartedManager.resumePendingDeletions();
    await expect(restartedManager.submit("restart-pending", {
      command: startExisting("restart-pending"),
    })).rejects.toThrow("Session deletion is in progress");
    await vi.waitFor(() => expect(resumedDelete).toHaveBeenCalledWith("restart-pending"));
    await expect(restartedManager.submit("restart-pending", {
      command: startExisting("restart-pending"),
    })).rejects.toThrow("Session has been deleted");
  });

  it("submit 会创建 actor 并写入共享 FrameLog", async () => {
    const frameLog = new InMemoryFrameLog();
    const handleCommand: HandleCommandFn = async function* (command) {
      if (command.kind === "startSession" && command.data.mode.kind === "existing") {
        yield frame(command.data.mode.data.id);
      }
    };
    const manager = new SessionManager({
      frameLog,
      handleCommand,
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
    });

    const frames = await manager.submit("s1", { command: startExisting("s1") });

    expect(frames).toHaveLength(1);
    expect(frameLog.readFrom("s1", 0).frames).toHaveLength(1);
  });

  it("LRU 会驱逐空闲 actor 且不驱逐忙碌 actor", async () => {
    const frameLog = new InMemoryFrameLog();
    let releaseBusy!: () => void;
    const cleanupSession = vi.fn();
    const handleCommand: HandleCommandFn = async function* (command) {
      if (command.kind !== "startSession" || command.data.mode.kind !== "existing") return;
      if (command.data.mode.data.id === "busy") {
        await new Promise<void>((resolve) => {
          releaseBusy = resolve;
        });
      }
      yield frame(command.data.mode.data.id);
    };
    const manager = new SessionManager({
      frameLog,
      handleCommand,
      abortSession: vi.fn(),
      cleanupSession,
      maxActors: 2,
    });

    await manager.submit("idle-a", { command: startExisting("idle-a") });
    await manager.submit("idle-b", { command: startExisting("idle-b") });
    await manager.submit("idle-c", { command: startExisting("idle-c") });
    expect(cleanupSession).toHaveBeenCalledWith("idle-a");
    expect(manager.getActorCountForTest()).toBe(2);

    const busy = manager.submit("busy", { command: startExisting("busy") });
    await Promise.resolve();
    await manager.submit("newer", { command: startExisting("newer") });
    expect(manager.getActorCountForTest()).toBeGreaterThanOrEqual(2);
    releaseBusy();
    await busy;
  });

  // 回归(0702 review Lane A · A8):maxActors LRU 驱逐"空闲但仍被浏览"的会话时,
  // disposeSession→frameLog.evict 会删掉带 listeners 的状态条目;后续帧经 ensure()
  // 落进新建的空 listeners 条目 → 已连接的 SSE 订阅者(还在收 ping)永远收不到新帧,
  // 页面静默冻结。修复:驱逐候选跳过 frameLog.hasSubscribers 的会话。
  it("LRU 驱逐跳过仍有 SSE 订阅者的空闲会话,订阅者持续收到后续帧", async () => {
    const frameLog = new InMemoryFrameLog();
    const cleanupSession = vi.fn();
    const handleCommand: HandleCommandFn = async function* (command) {
      if (command.kind === "startSession" && command.data.mode.kind === "existing") {
        yield frame(command.data.mode.data.id);
      }
    };
    const manager = new SessionManager({
      frameLog,
      handleCommand,
      abortSession: vi.fn(),
      cleanupSession,
      maxActors: 2,
    });

    // watched 是最老的空闲会话,但有活跃订阅者(模拟仍开着的标签页)
    await manager.submit("watched", { command: startExisting("watched") });
    const received: BridgeFrame[] = [];
    const unsubscribe = frameLog.subscribe("watched", 0, (entry) => {
      received.push(entry.frame);
    });
    const baselineReceived = received.length;

    await manager.submit("idle-b", { command: startExisting("idle-b") });
    await manager.submit("idle-c", { command: startExisting("idle-c") }); // 触发超限驱逐

    // 被驱逐的必须是无订阅者的 idle-b,而不是最老但仍被浏览的 watched
    expect(cleanupSession).toHaveBeenCalledWith("idle-b");
    expect(cleanupSession).not.toHaveBeenCalledWith("watched");
    expect(manager.getActorState("watched")).not.toBeNull();

    // 关键断言:订阅者对后续帧仍然可达(修复前 watched 被 evict,新帧进空 listeners 条目,收不到)
    await manager.submit("watched", { command: startExisting("watched") });
    expect(received.length).toBeGreaterThan(baselineReceived);

    // 取消订阅后,watched 恢复为可驱逐候选(证明保护不是永久的):
    // 连开两个新会话触发两次驱逐,{watched, idle-c} 均被清出(不依赖同毫秒时间戳的 LRU 顺序)。
    unsubscribe();
    await manager.submit("idle-d", { command: startExisting("idle-d") });
    await manager.submit("idle-e", { command: startExisting("idle-e") });
    expect(cleanupSession).toHaveBeenCalledWith("watched");
    expect(cleanupSession).toHaveBeenCalledWith("idle-c");
  });

  it("disposeSession 会 dispose actor、evict FrameLog 并调用 cleanupSession", async () => {
    const frameLog = new InMemoryFrameLog();
    const cleanupSession = vi.fn();
    const manager = new SessionManager({
      frameLog,
      handleCommand: async function* () {
        yield frame("s1");
      },
      abortSession: vi.fn(),
      cleanupSession,
    });

    await manager.submit("s1", { command: startExisting("s1") });
    const oldEpoch = frameLog.getEpoch("s1");
    await manager.disposeSession("s1");

    expect(cleanupSession).toHaveBeenCalledWith("s1");
    expect(manager.getActorState("s1")).toBeNull();
    expect(frameLog.getEpoch("s1")).toBeGreaterThan(oldEpoch);
  });

  it("destroySession 会等待在途生成收尾和持久化排空后再删 thread", async () => {
    const order: string[] = [];
    let releaseTurn!: () => void;
    const turnBlocked = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const abortSession = vi.fn(() => {
      order.push("abort");
      releaseTurn();
    });
    const manager = new SessionManager({
      handleCommand: async function* () {
        await turnBlocked;
        order.push("turn-settled");
      },
      abortSession,
      cleanupSession: vi.fn(async () => {
        order.push("cleanup");
      }),
      markSessionDeleted: vi.fn(() => {
        order.push("tombstone");
      }),
      drainSessionPersistence: vi.fn(async () => {
        order.push("persist-drained");
      }),
      deleteSessionThread: vi.fn(async () => {
        order.push("thread-deleted");
      }),
    });

    const running = manager.submit("destroy-running", {
      command: startExisting("destroy-running"),
    });
    await Promise.resolve();
    await manager.destroySession("destroy-running");
    await expect(running).rejects.toThrow("Session actor disposed");

    expect(abortSession).toHaveBeenCalledWith("destroy-running");
    expect(order).toEqual([
      "tombstone",
      "abort",
      "turn-settled",
      "cleanup",
      "persist-drained",
      "thread-deleted",
    ]);
    await expect(manager.submit("destroy-running", {
      command: startExisting("destroy-running"),
    })).rejects.toThrow("Session has been deleted");
  });

  it("F2: documents 已提交后 thread 删除失败保留墓碑并持续补删", async () => {
    const markSessionDeleted = vi.fn();
    const unmarkSessionDeleted = vi.fn();
    const deleteSessionThread = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("delete failed"), {
        phase: "documents_deleted",
      }))
      .mockResolvedValue(undefined);
    const manager = new SessionManager({
      handleCommand: async function* (command) {
        if (command.kind === "startSession" && command.data.mode.kind === "existing") {
          yield frame(command.data.mode.data.id);
        }
      },
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
      markSessionDeleted,
      unmarkSessionDeleted,
      drainSessionPersistence: vi.fn(async () => undefined),
      deleteSessionThread,
      deletionRetryDelayMs: 1,
    });

    await expect(manager.destroySession("delete-failed")).resolves.toEqual({
      deleted: false,
      status: "pending",
    });
    expect(markSessionDeleted).toHaveBeenCalledWith("delete-failed", "delete-failed");
    expect(unmarkSessionDeleted).not.toHaveBeenCalled();

    await expect(manager.submit("delete-failed", {
      command: startExisting("delete-failed"),
    })).rejects.toThrow("Session deletion is in progress");
    await vi.waitFor(() => expect(deleteSessionThread).toHaveBeenCalledTimes(2));
    await expect(manager.submit("delete-failed", {
      command: startExisting("delete-failed"),
    })).rejects.toThrow("Session has been deleted");
  });

  it("destroySession 进行中与完成后分别返回明确状态", async () => {
    let releaseDelete!: () => void;
    const deleting = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const deleteSessionThread = vi.fn(() => deleting);
    const manager = new SessionManager({
      handleCommand: async function* () {
        yield frame("deleting-state");
      },
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
      markSessionDeleted: vi.fn(),
      drainSessionPersistence: vi.fn(async () => undefined),
      deleteSessionThread,
    });

    const destroy = manager.destroySession("deleting-state");
    await vi.waitFor(() => expect(deleteSessionThread).toHaveBeenCalled());
    await expect(manager.submit("deleting-state", {
      command: startExisting("deleting-state"),
    })).rejects.toThrow("Session deletion is in progress");

    releaseDelete();
    await destroy;
    await expect(manager.submit("deleting-state", {
      command: startExisting("deleting-state"),
    })).rejects.toThrow("Session has been deleted");
  });

  it("destroySession 持久化排空超时后不立即物理删除，并在后台排空后补删", async () => {
    const drainSessionPersistence = vi.fn()
      .mockRejectedValueOnce(new Error("drain timed out"))
      .mockResolvedValue(undefined);
    const deleteSessionThread = vi.fn(async () => undefined);
    const markSessionDeleted = vi.fn();
    const manager = new SessionManager({
      handleCommand: async function* () {
        yield frame("drain-timeout");
      },
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
      resolveSessionDocumentId: vi.fn(async () => "doc-drain-timeout"),
      markSessionDeleted,
      drainSessionPersistence,
      deleteSessionThread,
      deletionRetryDelayMs: 20,
    });

    await manager.destroySession("drain-timeout", 5);

    expect(markSessionDeleted).toHaveBeenCalledWith(
      "drain-timeout",
      "doc-drain-timeout",
    );
    expect(deleteSessionThread).not.toHaveBeenCalled();
    await expect(manager.submit("drain-timeout", {
      command: startExisting("drain-timeout"),
    })).rejects.toThrow("Session deletion is in progress");

    await vi.waitFor(() => expect(deleteSessionThread).toHaveBeenCalledTimes(1));
    expect(drainSessionPersistence).toHaveBeenCalledTimes(2);
    await expect(manager.submit("drain-timeout", {
      command: startExisting("drain-timeout"),
    })).rejects.toThrow("Session has been deleted");
  });
});

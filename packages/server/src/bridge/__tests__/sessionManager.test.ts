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
});

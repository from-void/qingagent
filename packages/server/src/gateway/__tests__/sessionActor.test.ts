import { describe, expect, it, vi } from "vitest";
import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import { InMemoryFrameLog } from "../frameLog";
import {
  SessionActor,
  SessionActorCommandError,
  type HandleCommandFn,
} from "../sessionActor";

function sendMessage(text: string): Command {
  return {
    kind: "sendMessage",
    data: {
      sessionId: "s1",
      text,
      mentions: [],
      skills: [],
      chips: [],
      fileIds: [],
    },
  };
}

function commitReviewGroups(batchId = "batch-1"): Command {
  return {
    kind: "commitReviewGroups",
    data: { acceptReviewBatchIds: [batchId] },
  };
}

function cancelStream(): Command {
  return { kind: "cancelStream", data: { streamId: "stream-1" } };
}

function meta(title: string): BridgeFrame {
  return { kind: "sessionMeta", data: { sessionId: "s1", title } };
}

describe("SessionActor", () => {
  it("串行 drain 同一会话的命令", async () => {
    const log = new InMemoryFrameLog();
    const order: string[] = [];
    const handleCommand: HandleCommandFn = async function* (command) {
      if (command.kind !== "sendMessage") return;
      order.push(`start:${command.data.text}`);
      await Promise.resolve();
      yield meta(command.data.text);
      order.push(`end:${command.data.text}`);
    };
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: log,
      handleCommand,
      abortSession: vi.fn(),
    });

    await Promise.all([
      actor.enqueue({ command: sendMessage("a") }),
      actor.enqueue({ command: sendMessage("b") }),
    ]);

    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    expect(log.readFrom("s1", 0).frames.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("运行中的 sendMessage 后串行 commit，且把 actor sessionId 传给无 sessionId 命令", async () => {
    const log = new InMemoryFrameLog();
    const order: string[] = [];
    const routedSessionIds: Array<string | undefined> = [];
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handleCommand: HandleCommandFn = async function* (
      command,
      _trace,
      _origin,
      _overrides,
      _client,
      routedSessionId,
    ) {
      routedSessionIds.push(routedSessionId);
      if (command.kind === "sendMessage") {
        order.push("send:start");
        started();
        await releasePromise;
        order.push("send:end");
        yield meta("send");
        return;
      }
      if (command.kind === "commitReviewGroups") {
        order.push("commit");
        yield meta("commit");
      }
    };
    const abortSession = vi.fn();
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: log,
      handleCommand,
      abortSession,
    });

    const send = actor.enqueue({ command: sendMessage("running") });
    await startedPromise;
    const commit = actor.enqueue({ command: commitReviewGroups() });
    await Promise.resolve();
    expect(order).toEqual(["send:start"]);
    expect(abortSession).not.toHaveBeenCalled();

    release();
    await Promise.all([send, commit]);

    expect(order).toEqual(["send:start", "send:end", "commit"]);
    expect(routedSessionIds).toEqual(["s1", "s1"]);
  });

  it("cancelStream 与运行中的 commit 交错时先 abort、再安全串行处理 cancel", async () => {
    const log = new InMemoryFrameLog();
    const order: string[] = [];
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handleCommand: HandleCommandFn = async function* (command) {
      if (command.kind === "commitReviewGroups") {
        order.push("commit:start");
        started();
        await releasePromise;
        order.push("commit:end");
        yield meta("commit");
        return;
      }
      if (command.kind === "cancelStream") {
        order.push("cancel");
        yield meta("cancel");
      }
    };
    const abortSession = vi.fn(() => release());
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: log,
      handleCommand,
      abortSession,
    });

    const commit = actor.enqueue({ command: commitReviewGroups() });
    await startedPromise;
    const cancel = actor.enqueue({ command: cancelStream() });

    await Promise.all([commit, cancel]);
    expect(abortSession).toHaveBeenCalledWith("s1");
    expect(order).toEqual(["commit:start", "commit:end", "cancel"]);
  });

  it("sendMessage 抢占正在运行的命令并触发 abort", async () => {
    const log = new InMemoryFrameLog();
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    let releaseReady!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const releaseReadyPromise = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const handleCommand: HandleCommandFn = async function* (command) {
      if (command.kind !== "sendMessage") return;
      if (command.data.text === "first") {
        firstStarted();
        yield meta("first-start");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
          releaseReady();
        });
        yield meta("first-end");
        return;
      }
      yield meta("second");
    };
    const abortSession = vi.fn(() => releaseFirst?.());
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: log,
      handleCommand,
      abortSession,
    });

    const first = actor.enqueue({ command: sendMessage("first") });
    await firstStartedPromise;
    await releaseReadyPromise;
    const second = actor.enqueue({ command: sendMessage("second") });
    await Promise.all([first, second]);

    expect(abortSession).toHaveBeenCalledWith("s1");
    expect(log.readFrom("s1", 0).frames.map((entry) => entry.frame)).toEqual([
      meta("first-start"),
      meta("first-end"),
      meta("second"),
    ]);
  });

  it("单个命令失败会 reject 该项并继续队列", async () => {
    const log = new InMemoryFrameLog();
    const handleCommand: HandleCommandFn = async function* (command) {
      if (command.kind !== "sendMessage") return;
      if (command.data.text === "bad") throw new Error("bad command");
      yield meta(command.data.text);
    };
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: log,
      handleCommand,
      abortSession: vi.fn(),
    });

    await expect(actor.enqueue({ command: sendMessage("bad") })).rejects.toBeInstanceOf(
      SessionActorCommandError,
    );
    await expect(actor.enqueue({ command: sendMessage("good") })).resolves.toHaveLength(1);

    expect(log.readFrom("s1", 0).frames.map((entry) => entry.frame.kind)).toEqual([
      "stream",
      "sessionMeta",
    ]);
  });

  // 回归(0702 review Lane A · A7):命令失败广播的 draftingFailed 文案按命令类别分流——
  // 只有真正触发模型生成的命令(sendMessage/resumeAskUser/cancelAskUser)才用
  // "模型服务暂时不可用";非模型命令(acceptPatch/updateDoc 等)的失败是会话状态/操作层面,
  // 统一模型文案会误导用户。错误详情不透传(可能含内部路径/密钥)。
  it("命令失败的广播文案按命令类别分流:模型类 vs 操作类", async () => {
    const log = new InMemoryFrameLog();
    const handleCommand: HandleCommandFn = async function* (command) {
      void command;
      throw new Error("No session owns patchId: p-1");
      yield meta("unreachable"); // 保持 async generator 形态
    };
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: log,
      handleCommand,
      abortSession: vi.fn(),
    });

    const acceptPatch: Command = {
      kind: "acceptPatch",
      data: { id: "p-1" },
    };
    await expect(actor.enqueue({ command: acceptPatch })).rejects.toBeInstanceOf(
      SessionActorCommandError,
    );
    await expect(actor.enqueue({ command: sendMessage("hi") })).rejects.toBeInstanceOf(
      SessionActorCommandError,
    );

    const reasons = log
      .readFrom("s1", 0)
      .frames.map((entry) => entry.frame)
      .filter(
        (f): f is Extract<BridgeFrame, { kind: "stream" }> => f.kind === "stream",
      )
      .map((f) => (f.data.kind === "draftingFailed" ? f.data.data.reason : null));
    // 操作类命令失败:不再谎称模型不可用
    expect(reasons[0]).toBe("操作未能完成，请刷新页面后重试");
    // 模型类命令失败:保留模型文案
    expect(reasons[1]).toBe("模型服务暂时不可用，请稍后重试");
    // 原始 error message(含内部 id)绝不透传给订阅者
    expect(JSON.stringify(log.readFrom("s1", 0).frames)).not.toContain("p-1");
  });

  it("dispose 会 abort 当前命令并 reject 未处理队列", async () => {
    const log = new InMemoryFrameLog();
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const handleCommand: HandleCommandFn = async function* (command) {
      if (command.kind !== "sendMessage") return;
      firstStarted();
      await new Promise(() => undefined);
      yield meta(command.data.text);
    };
    const abortSession = vi.fn();
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: log,
      handleCommand,
      abortSession,
    });

    const first = actor.enqueue({ command: sendMessage("first") });
    const second = actor.enqueue({ command: sendMessage("second") });
    await firstStartedPromise;
    actor.dispose();

    await expect(first).rejects.toThrow("Session actor disposed");
    await expect(second).rejects.toThrow("Session actor disposed");
    expect(abortSession).toHaveBeenCalledWith("s1");
    expect(actor.state).toBe("disposed");
  });

  // 回归(0702 review):dispose+evict 后,在飞的 drainLoop 若继续 append / setActiveRunner,
  // 会经 frameLog.ensure() 重建一条已驱逐会话的僵尸状态条目(条目泄漏,直到下次 dispose)。
  it("dispose+evict 后在飞的生成器不再重建 frameLog 僵尸条目", async () => {
    const log = new InMemoryFrameLog();
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    let generatorFinished!: () => void;
    const generatorFinishedPromise = new Promise<void>((resolve) => {
      generatorFinished = resolve;
    });
    const handleCommand: HandleCommandFn = async function* (command) {
      if (command.kind !== "sendMessage") return;
      try {
        firstStarted();
        yield meta("before-dispose");
        await releasePromise;
        yield meta("after-dispose-1");
        yield meta("after-dispose-2");
      } finally {
        generatorFinished();
      }
    };
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: log,
      handleCommand,
      abortSession: vi.fn(),
    });

    const first = actor.enqueue({ command: sendMessage("first") });
    await firstStartedPromise;
    // 模拟 SessionManager.disposeSession 的真实顺序:先 dispose 再 evict。
    actor.dispose();
    log.evict("s1");
    expect(log.getSessionCountForTest()).toBe(0);

    release();
    await expect(first).rejects.toThrow("Session actor disposed");
    await generatorFinishedPromise;
    // 关键断言:生成器 dispose 后继续吐帧,不得经 ensure() 重建已驱逐的会话条目。
    expect(log.getSessionCountForTest()).toBe(0);
  });
});

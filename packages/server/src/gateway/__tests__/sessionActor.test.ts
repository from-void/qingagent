import { describe, expect, it, vi } from "vitest";
import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import { InMemoryFrameLog } from "../frameLog";
import {
  SessionActor,
  SessionActorCommandError,
  SessionActorExternalLeaseHeldError,
  SessionActorNativeBusyError,
  SessionActorQueueFullError,
  type HandleCommandFn,
} from "../sessionActor";

function sendMessage(text: string): Extract<Command, { kind: "sendMessage" }> {
  return {
    kind: "sendMessage",
    data: {
      sessionId: "s1",
      text,
      skills: [],
      chips: [],
      fileIds: [],
    },
  };
}

function sendReview(text = "开始一致性审查"): Command {
  return {
    ...sendMessage(text),
    data: {
      ...sendMessage(text).data,
      displayCard: {
        title: "一致性审查",
        lines: [{ label: "模板", value: "全面自洽核查" }],
        status: "running",
      },
      reviewContext: {
        type: "consistency",
        templateId: "review-consistency-default",
        templateName: "全面自洽核查",
      },
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
  return { kind: "cancelStream", data: { sessionId: "s1" } };
}

function submitReviewOutcome(): Command {
  return {
    kind: "submitReviewOutcome",
    data: {
      sessionId: "s1",
      outcome: { acceptedCount: 0, rejectedCount: 0, hunks: [] },
    },
  };
}

function resumeAskUser(): Command {
  return {
    kind: "resumeAskUser",
    data: {
      sessionId: "s1",
      toolCallId: "ask-1",
      answers: { q1: { chosen: [], freeText: "继续" } },
    },
  };
}

function meta(title: string): BridgeFrame {
  return { kind: "sessionMeta", data: { sessionId: "s1", title } };
}

describe("SessionActor", () => {
  it("begin admission 同时扫描当前、排队命令与 H1 confirm task 标记", async () => {
    const log = new InMemoryFrameLog();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: log,
      handleCommand: async function* () {},
      abortSession: vi.fn(),
    });

    const current = actor.enqueueTask(async function* () {
      started();
      await gate;
    }, { agentTurnDispatch: true });
    await startedPromise;
    expect(() => actor.enqueueTask(async function* () {}, {
      rejectIfAgentTurnDispatchPending: true,
    })).toThrow(SessionActorNativeBusyError);
    release();
    await current;

    let releaseBlocker!: () => void;
    let blockerStarted!: () => void;
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const blockerStartedPromise = new Promise<void>((resolve) => { blockerStarted = resolve; });
    const blocker = actor.enqueueTask(async function* () {
      blockerStarted();
      await blockerGate;
    });
    await blockerStartedPromise;
    const queuedCommand = actor.enqueue({ command: sendMessage("queued") });
    const queuedConfirm = actor.enqueueTask(async function* () {}, {
      agentTurnDispatch: true,
    });
    expect(() => actor.enqueueTask(async function* () {}, {
      rejectIfAgentTurnDispatchPending: true,
    })).toThrow(SessionActorNativeBusyError);
    releaseBlocker();
    await Promise.all([blocker, queuedCommand, queuedConfirm]);
  });

  it.each([
    ["sendMessage", sendMessage("blocked")],
    ["submitReviewOutcome", submitReviewOutcome()],
    ["resumeAskUser", resumeAskUser()],
  ] as const)("external lease 入队快拒 %s", async (_name, command) => {
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: new InMemoryFrameLog(),
      handleCommand: async function* () {},
      abortSession: vi.fn(),
      hasExternalBusyLease: () => true,
    });

    expect(() => actor.enqueue({ command }))
      .toThrow(SessionActorExternalLeaseHeldError);
  });

  it("入队后才出现 external lease 时执行二查发 turn-rejected", async () => {
    const log = new InMemoryFrameLog();
    let leaseHeld = false;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: log,
      handleCommand: async function* () {
        yield meta("不应执行");
      },
      abortSession: vi.fn(),
      hasExternalBusyLease: () => leaseHeld,
    });
    const blocker = actor.enqueueTask(async function* () {
      started();
      await gate;
    });
    await startedPromise;
    const queued = actor.enqueue({ command: sendMessage("accepted-before-lease") });
    leaseHeld = true;
    release();
    await blocker;
    await expect(queued).rejects.toThrow(SessionActorExternalLeaseHeldError);
    expect(log.readFrom("s1", 0).frames.map((entry) => entry.frame)).toContainEqual({
      kind: "turn-rejected",
      data: {
        reason: "external_lease_held",
        message: "Agent 正在编辑，稍后再试",
      },
    });
  });

  it("startSession(existing) 的整批恢复帧按 replay 投递，普通命令仍按 live 投递", async () => {
    const log = new InMemoryFrameLog();
    const deliveries: string[] = [];
    const unsubscribe = log.subscribe("s1", 0, (_entry, delivery) => {
      deliveries.push(delivery);
    });
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: log,
      handleCommand: async function* (command) {
        yield meta(command.kind);
      },
      abortSession: vi.fn(),
    });

    await actor.enqueue({
      command: {
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: "s1" } } },
      },
    });
    await actor.enqueue({ command: sendMessage("继续写") });
    unsubscribe();

    expect(deliveries).toEqual(["replay", "live"]);
  });

  it("等待队列达到容量后立即拒绝新命令，当前项与既有排队项仍可完成", async () => {
    const log = new InMemoryFrameLog();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: log,
      maxQueueSize: 1,
      handleCommand: async function* (command) {
        if (command.kind !== "sendMessage") return;
        if (command.data.text === "running") {
          started();
          await releasePromise;
        }
        yield meta(command.data.text);
      },
      abortSession: vi.fn(),
    });

    const running = actor.enqueue({ command: sendMessage("running") });
    await startedPromise;
    const queued = actor.enqueue({ command: commitReviewGroups() });

    expect(() => actor.enqueue({ command: commitReviewGroups("overflow") }))
      .toThrow(SessionActorQueueFullError);

    release();
    await expect(Promise.all([running, queued])).resolves.toHaveLength(2);
  });

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

  it("规划期 session 级 cancelStream 会先 abort 当前流程、再安全串行清理", async () => {
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
    expect(abortSession).toHaveBeenCalledWith("s1", "globalStop");
    expect(order).toEqual(["commit:start", "commit:end", "cancel"]);
  });

  it("规划期一次取消会清掉此前排队的重复 turn，不再派发后续问卷", async () => {
    const log = new InMemoryFrameLog();
    const order: string[] = [];
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstReleasePromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handleCommand: HandleCommandFn = async function* (command) {
      if (command.kind === "cancelStream") {
        order.push("cancel");
        yield meta("cancel");
        return;
      }
      if (command.kind !== "sendMessage") return;
      order.push(`${command.data.text}:start`);
      if (command.data.text === "first") {
        firstStarted();
        await firstReleasePromise;
        order.push("first:end");
        return;
      }
      // 若旧实现继续派发这个 queued turn，就会产生问卷帧。
      yield meta("questionnaire");
    };
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: log,
      handleCommand,
      abortSession: vi.fn(() => releaseFirst()),
    });

    const first = actor.enqueue({ command: sendMessage("first") });
    await firstStartedPromise;
    const queuedQuestionnaire = actor.enqueue({ command: sendMessage("questionnaire") });
    const queuedSettlement = expect(queuedQuestionnaire).rejects.toThrow(/stop barrier/);
    const cancel = actor.enqueue({ command: cancelStream() });

    await Promise.all([first, queuedSettlement, cancel]);
    expect(order).toEqual(["first:start", "first:end", "cancel"]);
    expect(
      log.readFrom("s1", 0).frames.some(
        (entry) => entry.frame.kind === "sessionMeta" && entry.frame.data.title === "questionnaire",
      ),
    ).toBe(false);
  });

  it("取消屏障对 cancel 前的多步排队持续有效，且不吞掉 cancel 后的新 turn", async () => {
    const log = new InMemoryFrameLog();
    const order: string[] = [];
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstReleasePromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handleCommand: HandleCommandFn = async function* (command) {
      if (command.kind === "cancelStream") {
        order.push("cancel");
        return;
      }
      if (command.kind !== "sendMessage") return;
      order.push(command.data.text);
      if (command.data.text === "first") {
        firstStarted();
        await firstReleasePromise;
      }
      yield meta(command.data.text);
    };
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: log,
      handleCommand,
      abortSession: vi.fn(() => releaseFirst()),
    });

    const first = actor.enqueue({ command: sendMessage("first") });
    await firstStartedPromise;
    const queuedSecond = actor.enqueue({ command: sendMessage("queued-second") });
    const queuedThird = actor.enqueue({ command: sendMessage("queued-third") });
    const queuedSecondSettlement = expect(queuedSecond).rejects.toThrow(/stop barrier/);
    const queuedThirdSettlement = expect(queuedThird).rejects.toThrow(/stop barrier/);
    const cancel = actor.enqueue({ command: cancelStream() });
    const nextTurn = actor.enqueue({ command: sendMessage("new-user-turn") });

    await Promise.all([
      first,
      queuedSecondSettlement,
      queuedThirdSettlement,
      cancel,
      nextTurn,
    ]);
    expect(order).toEqual(["first", "cancel", "new-user-turn"]);
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
    const preemptionReasons: Array<string | undefined> = [];
    const handleCommand: HandleCommandFn = async function* (
      command,
      _clientTraceId,
      _origin,
      _modelOverrides,
      _client,
      _routedSessionId,
      _abortSignal,
      preemptionReason,
    ) {
      if (command.kind !== "sendMessage") return;
      preemptionReasons.push(preemptionReason);
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

    expect(abortSession).toHaveBeenCalledWith("s1", "preemptedByNewMessage");
    expect(preemptionReasons).toEqual([undefined, "preemptedByNewMessage"]);
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

  // 未分类异常无论命令类型都只说操作未完成；命令种类不能证明故障来自模型。
  it("命令失败的广播文案不按命令种类冒称模型故障", async () => {
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
    // 两类命令都只陈述可以保证的操作结果。
    expect(reasons[0]).toBe("操作未能完成，请刷新页面后重试");
    expect(reasons[1]).toBe("操作未能完成，请刷新页面后重试");
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
    expect(abortSession).toHaveBeenCalledWith("s1", "globalStop");
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

describe("SessionActor 受保护工作", () => {
  it("审查中收到追问时不抢占，追问排队到审查真实收口且不冒充接管轮", async () => {
    const log = new InMemoryFrameLog();
    const order: string[] = [];
    const preemptionReasons: Array<string | undefined> = [];
    let reviewStarted!: () => void;
    const reviewStartedPromise = new Promise<void>((resolve) => { reviewStarted = resolve; });
    let releaseReview!: () => void;
    const reviewReleasePromise = new Promise<void>((resolve) => { releaseReview = resolve; });
    const abortSession = vi.fn();
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: log,
      handleCommand: async function* (
        command,
        _trace,
        _origin,
        _overrides,
        _client,
        _sessionId,
        _abortSignal,
        preemptionReason,
      ) {
        if (command.kind !== "sendMessage") return;
        preemptionReasons.push(preemptionReason);
        order.push(`${command.data.text}:start`);
        if (command.data.reviewContext) {
          reviewStarted();
          await reviewReleasePromise;
        }
        order.push(`${command.data.text}:end`);
        yield meta(command.data.text);
      },
      abortSession,
      hasProtectedWork: (_sessionId, activeCommand) =>
        activeCommand?.kind === "sendMessage" && activeCommand.data.reviewContext !== undefined,
    });

    const review = actor.enqueue({ command: sendReview() });
    await reviewStartedPromise;
    const followup = actor.enqueue({ command: sendMessage("审查到哪了？") });

    expect(abortSession).not.toHaveBeenCalled();
    expect(order).toEqual(["开始一致性审查:start"]);

    releaseReview();
    await Promise.all([review, followup]);

    expect(order).toEqual([
      "开始一致性审查:start",
      "开始一致性审查:end",
      "审查到哪了？:start",
      "审查到哪了？:end",
    ]);
    // 排队追问不是抢占接管轮，不能拿到“上一轮已中断”的虚假上下文。
    expect(preemptionReasons).toEqual([undefined, undefined]);
  });

  it("用户已确认、正在执行的命令不被新消息抢占,新消息排队等它收口", async () => {
    const log = new InMemoryFrameLog();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const abortSession = vi.fn();
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: log,
      handleCommand: async function* (command) {
        if (command.kind === "sendMessage") yield meta(command.data.text);
      },
      abortSession,
      hasProtectedWork: () => true,
    });

    const protectedRun = actor.enqueueTask(async function* () {
      started();
      await releasePromise;
      yield meta("confirmed-command-done");
    });
    await startedPromise;

    const queued = actor.enqueue({ command: sendMessage("怎么样了") });
    // 抢占必须被跳过:已确认的命令还在跑。
    expect(abortSession).not.toHaveBeenCalled();

    release();
    await expect(protectedRun).resolves.toHaveLength(1);
    await expect(queued).resolves.toHaveLength(1);
    await actor.disposeAndWait();
  });

  it("用户显式停止仍能立刻打断受保护工作", async () => {
    const log = new InMemoryFrameLog();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const abortSession = vi.fn(() => release());
    const actor = new SessionActor({
      sessionId: "s1",
      frameLog: log,
      handleCommand: async function* () {
        yield meta("cancelled");
      },
      abortSession,
      hasProtectedWork: () => true,
    });

    const protectedRun = actor.enqueueTask(async function* () {
      started();
      await releasePromise;
      yield meta("confirmed-command-stopped");
    });
    await startedPromise;

    const cancelled = actor.enqueue({ command: cancelStream() });
    expect(abortSession).toHaveBeenCalledWith("s1", "globalStop");

    await expect(protectedRun).resolves.toHaveLength(1);
    await expect(cancelled).resolves.toHaveLength(1);
    await actor.disposeAndWait();
  });
});

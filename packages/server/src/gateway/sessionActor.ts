import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import type { ModelOverrides } from "@qingagent/core";
import type { FrameDelivery, FrameLog, LoggedFrame } from "./frameLog";
import { terminalDocumentFrameFields } from "../lib/terminalDocumentFrame";

export type SessionActorState = "idle" | "running" | "cancelling" | "disposed";
export type CommandOrigin = "manual" | "agent" | "e2e" | "external";
export type TurnPreemptionReason = "preemptedByNewMessage" | "globalStop";

export interface ExternalLeaseOwner {
  principalId: string;
  turnId: string;
}

export interface ActorCommand {
  command: Command;
  clientTraceId?: string;
  origin?: CommandOrigin;
  client?: string;
  modelOverrides?: ModelOverrides;
  abortSignal?: AbortSignal;
  externalLeaseOwner?: ExternalLeaseOwner;
}

export type HandleCommandFn = (
  command: Command,
  clientTraceId?: string,
  origin?: CommandOrigin,
  modelOverrides?: ModelOverrides,
  client?: string,
  routedSessionId?: string,
  abortSignal?: AbortSignal,
  preemptionReason?: TurnPreemptionReason,
  externalLeaseOwner?: ExternalLeaseOwner,
) => AsyncGenerator<BridgeFrame>;

export class SessionActorCommandError extends Error {
  constructor(
    message: string,
    readonly originalError: unknown,
    readonly frames: LoggedFrame[],
  ) {
    super(message);
    this.name = "SessionActorCommandError";
  }
}

export const DEFAULT_SESSION_ACTOR_QUEUE_CAPACITY = 64;

export class SessionActorQueueFullError extends Error {
  readonly statusCode = 429;

  constructor(readonly capacity: number) {
    super("Session actor queue is full");
    this.name = "SessionActorQueueFullError";
  }
}

export class SessionActorNativeBusyError extends Error {
  readonly statusCode = 409;

  constructor() {
    super("Native agent turn is active or queued");
    this.name = "SessionActorNativeBusyError";
  }
}

export class SessionActorExternalLeaseHeldError extends Error {
  readonly statusCode = 409;

  constructor() {
    super("External editing lease is active");
    this.name = "SessionActorExternalLeaseHeldError";
  }
}

export interface EnqueueTaskOptions {
  /** 该任务会启动或续跑 agent；H1 要求普通命令与 confirm task 使用同一队列身份。 */
  agentTurnDispatch?: boolean;
  /** begin 专用：入队瞬间若已有起轮任务则原子拒绝，不排到其后等待。 */
  rejectIfAgentTurnDispatchPending?: boolean;
}

interface QueueItem {
  input: ActorCommand | null;
  task?: () => AsyncGenerator<BridgeFrame>;
  agentTurnDispatch: boolean;
  preemptionReason?: TurnPreemptionReason;
  resolve: (frames: LoggedFrame[]) => void;
  reject: (error: unknown) => void;
}

export interface SessionActorOptions {
  sessionId: string;
  frameLog: FrameLog;
  handleCommand: HandleCommandFn;
  abortSession: (sessionId: string, reason?: TurnPreemptionReason) => void;
  afterRun?: (sessionId: string) => void;
  maxQueueSize?: number;
  /** 用户已确认且正在执行的命令等"不能被系统悄悄丢掉"的工作。 */
  hasProtectedWork?: (sessionId: string, activeCommand?: Command) => boolean;
  /** 只读取当前进程内未过期的 external lease；Actor 准入与执行二查共用。 */
  hasExternalBusyLease?: (sessionId: string) => boolean;
}

const DISPOSED_ERROR = new Error("Session actor disposed");
const STOP_BARRIER_ERROR = new Error(
  "Session actor command cancelled by stop barrier",
);

function commandFrameDelivery(command: Command | null): FrameDelivery | undefined {
  // startSession(existing) 产出的是一整批权威恢复快照，不是实时增量。
  // 冷启动时 SSE 往往先于持久层恢复就绪；若沿用 live，正文大帧写出期间
  // 后续聊天/批注/候选帧会占满慢客户端预算并被换线清掉。历史路径本来就
  // 由 FrameLog.subscribe 标成 replay，这里让“订阅已先建立”的时序等价。
  return command?.kind === "startSession" && command.data.mode.kind === "existing"
    ? "replay"
    : undefined;
}

export class SessionActor {
  private readonly queue: QueueItem[] = [];
  private draining = false;
  private drainPromise: Promise<void> | null = null;
  private current: QueueItem | null = null;
  private stateValue: SessionActorState = "idle";
  private readonly maxQueueSize: number;

  constructor(private readonly options: SessionActorOptions) {
    this.maxQueueSize = Math.max(
      1,
      Math.floor(options.maxQueueSize ?? DEFAULT_SESSION_ACTOR_QUEUE_CAPACITY),
    );
  }

  get state(): SessionActorState {
    return this.stateValue;
  }

  get isBusy(): boolean {
    return this.stateValue === "running" || this.stateValue === "cancelling";
  }

  enqueue(input: ActorCommand): Promise<LoggedFrame[]> {
    if (this.stateValue === "disposed") return Promise.reject(DISPOSED_ERROR);
    const agentTurnDispatch = isAgentTurnDispatchCommand(input.command);
    if (agentTurnDispatch && this.hasExternalBusyLease()) {
      throw new SessionActorExternalLeaseHeldError();
    }
    let preemptionReason: TurnPreemptionReason | undefined;
    if (input.command.kind === "cancelStream") {
      // cancel 是当前用户 turn 的终止屏障：除 abort 正在跑的项外，还要丢弃在它之前
      // 已排队的模型续轮/重复派发。否则队列会按 old → queued send → cancel 执行，
      // queued send 先重新发 start/问卷，用户只能再点一次停止。
      this.cancelQueuedTurnDispatches();
    }
    this.assertQueueCapacity();
    if (this.isBusy && isPreemptiveCommand(input.command)) {
      const reason = preemptionReasonForCommand(input.command);
      // 用户已经点过确认、命令正在跑:新消息只排队,绝不顺手把它掐死——那会让用户
      // 付出的确认动作白丢,卡片落成笼统"已中止"(0729 真机 P1)。
      // 用户显式点停止(cancelStream → globalStop)仍必须立刻生效。
      if (reason === "preemptedByNewMessage" && this.hasProtectedWork()) {
        console.info("[session-lifecycle] preemption skipped: protected work in flight", {
          sessionId: this.options.sessionId,
          command: input.command.kind,
        });
      } else {
        preemptionReason = reason;
        this.abortCurrent(preemptionReason);
      }
    }

    return new Promise<LoggedFrame[]>((resolve, reject) => {
      this.queue.push({ input, agentTurnDispatch, preemptionReason, resolve, reject });
      this.startDrainLoop();
    });
  }

  /** 专用上行通道进入同一会话串行队列，避免把 secret/决策塞进通用 Command。 */
  enqueueTask(
    task: () => AsyncGenerator<BridgeFrame>,
    options: EnqueueTaskOptions = {},
  ): Promise<LoggedFrame[]> {
    if (this.stateValue === "disposed") return Promise.reject(DISPOSED_ERROR);
    if (
      options.rejectIfAgentTurnDispatchPending === true
      && this.hasAgentTurnDispatchPending()
    ) {
      throw new SessionActorNativeBusyError();
    }
    if (options.agentTurnDispatch === true && this.hasExternalBusyLease()) {
      throw new SessionActorExternalLeaseHeldError();
    }
    this.assertQueueCapacity();
    return new Promise<LoggedFrame[]>((resolve, reject) => {
      this.queue.push({
        input: null,
        task,
        agentTurnDispatch: options.agentTurnDispatch === true,
        resolve,
        reject,
      });
      this.startDrainLoop();
    });
  }

  private hasAgentTurnDispatchPending(): boolean {
    return this.current?.agentTurnDispatch === true
      || this.queue.some((item) => item.agentTurnDispatch);
  }

  private hasExternalBusyLease(): boolean {
    try {
      return this.options.hasExternalBusyLease?.(this.options.sessionId) === true;
    } catch {
      return false;
    }
  }

  private assertQueueCapacity(): void {
    if (this.queue.length >= this.maxQueueSize) {
      throw new SessionActorQueueFullError(this.maxQueueSize);
    }
  }

  private hasProtectedWork(): boolean {
    try {
      return this.options.hasProtectedWork?.(
        this.options.sessionId,
        this.current?.input?.command,
      ) === true;
    } catch {
      return false;
    }
  }

  abortCurrent(reason: TurnPreemptionReason = "globalStop"): void {
    if (this.stateValue !== "running" && this.stateValue !== "cancelling") return;
    this.stateValue = "cancelling";
    try {
      this.options.abortSession(this.options.sessionId, reason);
    } catch (error) {
      console.error("[sessionActor] abortSession failed", {
        sessionId: this.options.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private cancelQueuedTurnDispatches(): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const item = this.queue[index];
      if (!item?.agentTurnDispatch || !item.input) continue;
      this.queue.splice(index, 1);
      // /commands 对模型命令本就是 accepted 后台语义；被同 turn 的停止屏障消费时
      // 不制造伪错误帧，但内部 completion 必须失败，幂等层才能释放本次 claim。
      // 排在 cancel 之后的新用户 turn 不受影响。
      item.reject(STOP_BARRIER_ERROR);
    }
  }

  dispose(): void {
    if (this.stateValue === "disposed") return;
    if (this.isBusy) this.abortCurrent();
    this.stateValue = "disposed";
    this.options.frameLog.setGeneration(
      this.options.sessionId,
      this.options.frameLog.getGeneration(this.options.sessionId) + 1,
    );
    this.options.frameLog.setActiveRunner(this.options.sessionId, false);
    this.current?.reject(DISPOSED_ERROR);
    this.current = null;
    while (this.queue.length > 0) {
      this.queue.shift()?.reject(DISPOSED_ERROR);
    }
  }

  async disposeAndWait(): Promise<void> {
    this.dispose();
    await this.drainPromise;
  }

  private startDrainLoop(): void {
    if (this.draining) return;
    this.draining = true;
    this.drainPromise = this.drainLoop().finally(() => {
      this.draining = false;
      this.drainPromise = null;
      if (this.queue.length > 0 && this.stateValue !== "disposed") {
        this.startDrainLoop();
      }
    });
  }

  private async drainLoop(): Promise<void> {
    while (this.queue.length > 0 && this.stateValue !== "disposed") {
      const item = this.queue.shift()!;
      this.current = item;
      const generation = this.options.frameLog.getGeneration(this.options.sessionId) + 1;
      const produced: LoggedFrame[] = [];
      const delivery = commandFrameDelivery(item.input?.command ?? null);
      this.options.frameLog.setGeneration(this.options.sessionId, generation);
      this.options.frameLog.setActiveRunner(this.options.sessionId, true);
      this.stateValue = "running";

      try {
        if (item.agentTurnDispatch && this.hasExternalBusyLease()) {
          const rejectedFrame = externalLeaseTurnRejectedFrame();
          const seq = this.options.frameLog.append(
            this.options.sessionId,
            rejectedFrame,
            { generation, delivery },
          );
          if (seq !== null) {
            produced.push({
              seq,
              epoch: this.options.frameLog.getEpoch(this.options.sessionId),
              generation,
              frame: rejectedFrame,
            });
          }
          item.reject(new SessionActorExternalLeaseHeldError());
          continue;
        }
        const frames = item.task
          ? item.task()
          : this.options.handleCommand(
              item.input!.command,
              item.input!.clientTraceId,
              item.input!.origin ?? "manual",
              item.input!.modelOverrides,
              item.input!.client,
              this.options.sessionId,
              item.input!.abortSignal,
              item.preemptionReason,
              item.input!.externalLeaseOwner,
            );
        for await (const frame of frames) {
          // dispose 后继续消费 generator 到 done，但绝不 append。只调用一次 return()
          // 会在 generator 的 finally 仍含 yield 时把它挂在首个终态帧，后续持久化与
          // _activeTurnPromise resolve 都无法执行；disposeAndWait 必须等完整收尾。
          if ((this.stateValue as SessionActorState) === "disposed") continue;
          const seq = this.options.frameLog.append(
            this.options.sessionId,
            frame,
            { generation, delivery },
          );
          if (seq !== null) {
            const terminalFields = terminalDocumentFrameFields(frame, seq);
            if (terminalFields) {
              console.info("[terminal-document] appended", {
                stage: "appended",
                sessionId: this.options.sessionId,
                ...terminalFields,
              });
            }
            produced.push({
              seq,
              epoch: this.options.frameLog.getEpoch(this.options.sessionId),
              generation,
              frame,
            });
          }
        }
        item.resolve(produced);
      } catch (error) {
        // disposed 后不再落错误帧:frameLog 已 evict,append 会重建僵尸条目;
        // item 也已被 dispose() reject 过(重复 reject 对已 settle 的 promise 是 no-op)。
        if ((this.stateValue as SessionActorState) !== "disposed" && item.input) {
          const errorFrame = commandErrorFrame(item.input.command.kind);
          const seq = this.options.frameLog.append(
            this.options.sessionId,
            errorFrame,
            { generation },
          );
          if (seq !== null) {
            produced.push({
              seq,
              epoch: this.options.frameLog.getEpoch(this.options.sessionId),
              generation,
              frame: errorFrame,
            });
          }
        }
        item.reject(
          new SessionActorCommandError("Session actor command failed", error, produced),
        );
      } finally {
        if (this.current === item) this.current = null;
        if ((this.stateValue as SessionActorState) !== "disposed") {
          this.options.frameLog.setActiveRunner(this.options.sessionId, false);
          this.stateValue = this.queue.length > 0 ? "running" : "idle";
        }
        this.options.afterRun?.(this.options.sessionId);
      }
    }
  }
}

export function isPreemptiveCommand(command: Command): boolean {
  return command.kind === "cancelStream" || command.kind === "sendMessage";
}

/** 会启动或续跑 agent 的命令；cancelStream 必须清掉其前方尚未执行的同 turn 派发。 */
export function isAgentTurnDispatchCommand(command: Command): boolean {
  return (
    command.kind === "sendMessage" ||
    command.kind === "resumeAskUser" ||
    command.kind === "submitReviewOutcome"
  );
}

function preemptionReasonForCommand(command: Command): TurnPreemptionReason {
  return command.kind === "sendMessage"
    ? "preemptedByNewMessage"
    : "globalStop";
}

function commandErrorFrame(_commandKind: Command["kind"]): BridgeFrame {
  // 未分类异常只证明命令没有完成，不能仅凭命令种类推断故障来自模型。
  // 原始 error message 可能含内部路径/密钥，仍只向用户发送脱敏中性文案。
  const reason = "操作未能完成，请刷新页面后重试";
  return {
    kind: "stream",
    data: {
      kind: "draftingFailed",
      data: {
        streamId: "error",
        reason,
        retriable: true,
      },
    },
  };
}

function externalLeaseTurnRejectedFrame(): BridgeFrame {
  return {
    kind: "turn-rejected",
    data: {
      reason: "external_lease_held",
      message: "Agent 正在编辑，稍后再试",
    },
  };
}

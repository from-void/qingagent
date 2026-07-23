import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import type { ModelOverrides } from "@qingagent/core";
import type { FrameLog, LoggedFrame } from "./frameLog";

export type SessionActorState = "idle" | "running" | "cancelling" | "disposed";
export type CommandOrigin = "manual" | "agent" | "e2e" | "external";

export interface ActorCommand {
  command: Command;
  clientTraceId?: string;
  origin?: CommandOrigin;
  client?: string;
  modelOverrides?: ModelOverrides;
  abortSignal?: AbortSignal;
}

export type HandleCommandFn = (
  command: Command,
  clientTraceId?: string,
  origin?: CommandOrigin,
  modelOverrides?: ModelOverrides,
  client?: string,
  routedSessionId?: string,
  abortSignal?: AbortSignal,
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

interface QueueItem {
  input: ActorCommand | null;
  task?: () => AsyncGenerator<BridgeFrame>;
  resolve: (frames: LoggedFrame[]) => void;
  reject: (error: unknown) => void;
}

export interface SessionActorOptions {
  sessionId: string;
  frameLog: FrameLog;
  handleCommand: HandleCommandFn;
  abortSession: (sessionId: string) => void;
  afterRun?: (sessionId: string) => void;
}

const DISPOSED_ERROR = new Error("Session actor disposed");

export class SessionActor {
  private readonly queue: QueueItem[] = [];
  private draining = false;
  private drainPromise: Promise<void> | null = null;
  private current: QueueItem | null = null;
  private stateValue: SessionActorState = "idle";

  constructor(private readonly options: SessionActorOptions) {}

  get state(): SessionActorState {
    return this.stateValue;
  }

  get isBusy(): boolean {
    return this.stateValue === "running" || this.stateValue === "cancelling";
  }

  enqueue(input: ActorCommand): Promise<LoggedFrame[]> {
    if (this.stateValue === "disposed") return Promise.reject(DISPOSED_ERROR);
    if (input.command.kind === "cancelStream") {
      // cancel 是当前用户 turn 的终止屏障：除 abort 正在跑的项外，还要丢弃在它之前
      // 已排队的模型续轮/重复派发。否则队列会按 old → queued send → cancel 执行，
      // queued send 先重新发 start/问卷，用户只能再点一次停止。
      this.cancelQueuedTurnDispatches();
    }
    if (this.isBusy && isPreemptiveCommand(input.command)) {
      this.abortCurrent();
    }

    return new Promise<LoggedFrame[]>((resolve, reject) => {
      this.queue.push({ input, resolve, reject });
      this.startDrainLoop();
    });
  }

  /** 专用上行通道进入同一会话串行队列，避免把 secret/决策塞进通用 Command。 */
  enqueueTask(task: () => AsyncGenerator<BridgeFrame>): Promise<LoggedFrame[]> {
    if (this.stateValue === "disposed") return Promise.reject(DISPOSED_ERROR);
    return new Promise<LoggedFrame[]>((resolve, reject) => {
      this.queue.push({ input: null, task, resolve, reject });
      this.startDrainLoop();
    });
  }

  abortCurrent(): void {
    if (this.stateValue !== "running" && this.stateValue !== "cancelling") return;
    this.stateValue = "cancelling";
    try {
      this.options.abortSession(this.options.sessionId);
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
      if (!item?.input || !isAgentTurnDispatchCommand(item.input.command)) continue;
      this.queue.splice(index, 1);
      // /commands 对模型命令本就是 accepted 后台语义；被同 turn 的停止屏障消费是
      // 正常取消，不制造伪错误帧，也不影响排在 cancel 之后的新用户 turn。
      item.resolve([]);
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
      this.options.frameLog.setGeneration(this.options.sessionId, generation);
      this.options.frameLog.setActiveRunner(this.options.sessionId, true);
      this.stateValue = "running";

      try {
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
            );
        for await (const frame of frames) {
          // dispose 后立即停泵(0702 review):manager 已 frameLog.evict,此处再 append
          // 会经 ensure() 重建一条僵尸状态条目(帧虽被 generation 过滤,条目本身泄漏)。
          // break 触发 generator.return(),让 handleCommand 的 finally 正常收尾。
          if ((this.stateValue as SessionActorState) === "disposed") break;
          const seq = this.options.frameLog.append(
            this.options.sessionId,
            frame,
            { generation },
          );
          if (seq !== null) {
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

/**
 * 会真正触发模型生成的命令。只有这些命令失败时,"模型服务暂时不可用"的文案才成立;
 * 其余命令(acceptPatch / updateDoc / removeMaterial…)的失败是会话状态/操作层面的,
 * 用模型文案会误导用户(0702 review Lane A · A7)。
 */
const MODEL_DRIVEN_COMMANDS: ReadonlySet<Command["kind"]> = new Set([
  "sendMessage",
  "resumeAskUser",
  "cancelAskUser",
]);

function commandErrorFrame(commandKind: Command["kind"]): BridgeFrame {
  // 注意:错误详情不透传原始 error message(可能含内部路径/密钥),只按命令类别分文案。
  const reason = MODEL_DRIVEN_COMMANDS.has(commandKind)
    ? "模型服务暂时不可用，请稍后重试"
    : "操作未能完成，请刷新页面后重试";
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

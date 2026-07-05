import type { BridgeFrame } from "@qingagent/contract-ts";

export interface LoggedFrame {
  seq: number;
  epoch: number;
  generation: number;
  frame: BridgeFrame;
}

export interface FrameLogReadResult {
  frames: LoggedFrame[];
  minSeq: number;
  nextSeq: number;
  epoch: number;
  gap: boolean;
  activeRunner: boolean;
}

export interface FrameLog {
  append(
    sessionId: string,
    frame: BridgeFrame,
    options?: { generation?: number },
  ): number | null;
  readFrom(sessionId: string, afterSeq: number): FrameLogReadResult;
  subscribe(
    sessionId: string,
    afterSeq: number,
    onFrame: (frame: LoggedFrame) => void,
  ): () => void;
  setGeneration(sessionId: string, generation: number): void;
  getGeneration(sessionId: string): number;
  setActiveRunner(sessionId: string, active: boolean): void;
  getEpoch(sessionId: string): number;
  /** 该会话当前是否有活跃订阅者(SSE listener)。只读探询,不得惰性建条目。 */
  hasSubscribers(sessionId: string): boolean;
  /** 最近持有帧状态的会话。只读探询,不得惰性建条目。 */
  listSessionIds?(limit?: number): string[];
  evict(sessionId: string): void;
}

interface SessionFrameLogState {
  frames: LoggedFrame[];
  nextSeq: number;
  epoch: number;
  generation: number;
  activeRunner: boolean;
  listeners: Set<(frame: LoggedFrame) => void>;
}

export class InMemoryFrameLog implements FrameLog {
  private readonly sessions = new Map<string, SessionFrameLogState>();
  private nextEpoch = Date.now();

  constructor(
    private readonly maxFramesPerSession = 2_000,
    private readonly maxSessions = 1_024,
  ) {
    if (!Number.isInteger(maxFramesPerSession) || maxFramesPerSession <= 0) {
      throw new Error("maxFramesPerSession must be a positive integer");
    }
    if (!Number.isInteger(maxSessions) || maxSessions <= 0) {
      throw new Error("maxSessions must be a positive integer");
    }
  }

  /** 仅测试用:当前持有的会话状态条目数。 */
  getSessionCountForTest(): number {
    return this.sessions.size;
  }

  append(
    sessionId: string,
    frame: BridgeFrame,
    options: { generation?: number } = {},
  ): number | null {
    const state = this.ensure(sessionId);
    if (
      options.generation !== undefined &&
      options.generation !== state.generation
    ) {
      return null;
    }

    // 深拷贝快照(0702 桌面验收 bug):生产者(processAgentStream/emitRestoreFrames)yield 的
    // chatMessageAdded 携带的是 chatHistory 里**仍在流式增长的同一个消息对象**(parts 就地 push),
    // 而 SSE 下发是订阅时才 JSON.stringify。若不冻结,晚到的订阅者(重进重放 after=0)会拿到
    // "已长满 parts 的 chatMessageAdded" + 再重放全部 chatMessageAppended 增量 → 同一条消息内容
    // 应用两遍,正文/工具卡整段重复。append 即快照,保证重放者看到的与当时直播订阅者一致。
    const logged: LoggedFrame = {
      seq: state.nextSeq,
      epoch: state.epoch,
      generation: state.generation,
      frame: structuredClone(frame),
    };
    state.nextSeq += 1;
    state.frames.push(logged);
    if (state.frames.length > this.maxFramesPerSession) {
      state.frames.splice(0, state.frames.length - this.maxFramesPerSession);
    }

    for (const listener of [...state.listeners]) {
      try {
        listener(logged);
      } catch (error) {
        console.error("[frameLog] subscriber failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return logged.seq;
  }

  readFrom(sessionId: string, afterSeq: number): FrameLogReadResult {
    const state = this.ensure(sessionId);
    const normalizedAfter = normalizeSeq(afterSeq);
    const minSeq = state.frames[0]?.seq ?? state.nextSeq;
    const frames = state.frames.filter((entry) => entry.seq > normalizedAfter);
    return {
      frames,
      minSeq,
      nextSeq: state.nextSeq,
      epoch: state.epoch,
      gap: normalizedAfter + 1 < minSeq,
      activeRunner: state.activeRunner,
    };
  }

  subscribe(
    sessionId: string,
    afterSeq: number,
    onFrame: (frame: LoggedFrame) => void,
  ): () => void {
    const state = this.ensure(sessionId);
    let active = true;
    let lastSeq = normalizeSeq(afterSeq);

    const listener = (entry: LoggedFrame) => {
      if (!active || entry.seq <= lastSeq) return;
      lastSeq = entry.seq;
      try {
        onFrame(entry);
      } catch (error) {
        console.error("[frameLog] subscriber failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    state.listeners.add(listener);
    for (const entry of this.readFrom(sessionId, lastSeq).frames) {
      listener(entry);
    }

    return () => {
      active = false;
      state.listeners.delete(listener);
    };
  }

  setGeneration(sessionId: string, generation: number): void {
    this.ensure(sessionId).generation = generation;
  }

  getGeneration(sessionId: string): number {
    return this.ensure(sessionId).generation;
  }

  setActiveRunner(sessionId: string, active: boolean): void {
    this.ensure(sessionId).activeRunner = active;
  }

  getEpoch(sessionId: string): number {
    return this.ensure(sessionId).epoch;
  }

  hasSubscribers(sessionId: string): boolean {
    // 不走 ensure():这是只读探询(SessionManager 驱逐决策用),
    // 不能因为查一下就惰性创建条目/触发 LRU touch。
    return (this.sessions.get(sessionId)?.listeners.size ?? 0) > 0;
  }

  listSessionIds(limit = this.maxSessions): string[] {
    const n = Math.max(0, Math.floor(limit));
    if (n === 0) return [];
    return [...this.sessions.keys()].reverse().slice(0, n);
  }

  evict(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private ensure(sessionId: string): SessionFrameLogState {
    let state = this.sessions.get(sessionId);
    if (state) {
      // LRU touch:重插到 Map 尾部,使迭代顺序保持"最久未访问在前"。
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, state);
      return state;
    }
    state = {
      frames: [],
      nextSeq: 1,
      epoch: this.nextEpoch++,
      generation: 0,
      activeRunner: false,
      listeners: new Set(),
    };
    this.sessions.set(sessionId, state);
    this.evictOverflowSessions(sessionId);
    return state;
  }

  /**
   * 会话条目数上限防护(0702 review):GET /events / getEpoch 等只读路径也会 ensure()
   * 惰性建状态,且不经 SessionManager(其 LRU 只驱逐有 actor 的会话)——未认证请求可用
   * 任意 sessionId 无限造条目。超限时从最久未访问端驱逐"无订阅者且非活跃生成"的会话;
   * 被驱逐的会话重连时因 epoch 变化自动走 restore 快照重建,行为可恢复。
   */
  private evictOverflowSessions(protectedSessionId: string): void {
    if (this.sessions.size <= this.maxSessions) return;
    for (const [sessionId, state] of this.sessions) {
      if (this.sessions.size <= this.maxSessions) return;
      if (sessionId === protectedSessionId) continue;
      if (state.activeRunner || state.listeners.size > 0) continue;
      this.sessions.delete(sessionId);
    }
  }
}

function normalizeSeq(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

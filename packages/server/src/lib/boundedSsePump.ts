import { Buffer } from "node:buffer";

export interface SseMessage {
  data: string;
  event?: string;
  id?: string;
}

export interface BoundedSsePumpOptions {
  write: (message: SseMessage) => Promise<unknown>;
  onClose: (
    reason: "overflow" | "write_error",
    details: SsePumpCloseDetails,
  ) => void;
  maxFrames?: number;
  maxBytes?: number;
}

export interface SseEnqueueOptions {
  /** FrameLog 同步回放由其 2000 帧窗口约束，不计入 live 慢客户端背压预算。 */
  delivery?: "live" | "replay";
  /** 合法快照没有 512 KiB 文档上限；仍受 live 帧数上限约束。 */
  allowOversized?: boolean;
  /** 心跳等可丢消息不能成为压垮连接的最后一帧。 */
  dropOnOverflow?: boolean;
}

export const DEFAULT_SSE_QUEUE_MAX_FRAMES = 64;
export const DEFAULT_SSE_QUEUE_MAX_BYTES = 512 * 1024;

export interface SsePumpCloseDetails {
  reason: "overflow" | "write_error";
  queuedFrames: number;
  queuedBytes: number;
  lastWrittenSeq: string | null;
  firstUnwrittenSeq: string | null;
  attemptedSeq: string | null;
  attemptedBytes: number | null;
}

interface QueuedMessage {
  message: SseMessage;
  bytes: number;
  limitedFrames: number;
  limitedBytes: number;
}

/**
 * 每条 SSE 连接仅运行一个 writer；生产者只持有有界帧队列，不创建随帧数增长的
 * Promise 链。溢出时立即丢弃待写帧并通知路由关闭订阅，客户端靠 Last-Event-ID 重连。
 */
export class BoundedSsePump {
  private readonly queue: QueuedMessage[] = [];
  private readonly maxFrames: number;
  private readonly maxBytes: number;
  private queuedBytes = 0;
  private limitedQueuedFrames = 0;
  private limitedQueuedBytes = 0;
  private pumping = false;
  private closed = false;
  private inFlightId: string | null = null;
  private inFlightBytes = 0;
  private lastWrittenId: string | null = null;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly options: BoundedSsePumpOptions) {
    this.maxFrames = positiveInteger(options.maxFrames, DEFAULT_SSE_QUEUE_MAX_FRAMES);
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_SSE_QUEUE_MAX_BYTES);
  }

  enqueue(message: SseMessage, enqueueOptions: SseEnqueueOptions = {}): boolean {
    if (this.closed) return false;
    const bytes = messageBytes(message);
    const isReplay = enqueueOptions.delivery === "replay";
    const limitedFrames = isReplay ? 0 : 1;
    const limitedBytes = isReplay || enqueueOptions.allowOversized ? 0 : bytes;
    const overflow =
      (!isReplay && !enqueueOptions.allowOversized && bytes > this.maxBytes) ||
      this.limitedQueuedFrames + limitedFrames > this.maxFrames ||
      this.limitedQueuedBytes + limitedBytes > this.maxBytes;
    if (overflow) {
      if (enqueueOptions.dropOnOverflow) return false;
      this.close("overflow", {
        attemptedSeq: message.id ?? null,
        attemptedBytes: bytes,
      });
      return false;
    }
    this.queue.push({ message, bytes, limitedFrames, limitedBytes });
    this.queuedBytes += bytes;
    this.limitedQueuedFrames += limitedFrames;
    this.limitedQueuedBytes += limitedBytes;
    this.startPump();
    return true;
  }

  close(
    reason?: "overflow" | "write_error",
    attempted: {
      attemptedSeq?: string | null;
      attemptedBytes?: number | null;
    } = {},
  ): void {
    if (this.closed) return;
    this.closed = true;
    const details = reason
      ? {
          reason,
          queuedFrames: this.queue.length + (this.inFlightId ? 1 : 0),
          queuedBytes: this.queuedBytes + this.inFlightBytes,
          lastWrittenSeq: this.lastWrittenId,
          firstUnwrittenSeq:
            this.inFlightId ??
            this.queue[0]?.message.id ??
            attempted.attemptedSeq ??
            null,
          attemptedSeq: attempted.attemptedSeq ?? null,
          attemptedBytes: attempted.attemptedBytes ?? null,
        }
      : null;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.limitedQueuedFrames = 0;
    this.limitedQueuedBytes = 0;
    if (reason && details) this.options.onClose(reason, details);
    this.resolveIdleIfDone();
  }

  waitForIdle(): Promise<void> {
    if (!this.pumping && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** 仅测试/资源观测使用。 */
  stats(): { queuedFrames: number; queuedBytes: number; pumping: boolean; closed: boolean } {
    return {
      queuedFrames: this.queue.length,
      queuedBytes: this.queuedBytes,
      pumping: this.pumping,
      closed: this.closed,
    };
  }

  private startPump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      while (!this.closed) {
        const queued = this.queue.shift();
        if (!queued) break;
        this.queuedBytes -= queued.bytes;
        this.limitedQueuedFrames -= queued.limitedFrames;
        this.limitedQueuedBytes -= queued.limitedBytes;
        this.inFlightId = queued.message.id ?? null;
        this.inFlightBytes = queued.bytes;
        await this.options.write(queued.message);
        this.lastWrittenId = queued.message.id ?? this.lastWrittenId;
        this.inFlightId = null;
        this.inFlightBytes = 0;
      }
    } catch {
      this.close("write_error");
    } finally {
      this.pumping = false;
      if (!this.closed && this.queue.length > 0) {
        this.startPump();
      } else {
        this.resolveIdleIfDone();
      }
    }
  }

  private resolveIdleIfDone(): void {
    if (this.pumping || this.queue.length > 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}

function messageBytes(message: SseMessage): number {
  return Buffer.byteLength(
    `${message.id ? `id:${message.id}\n` : ""}${message.event ? `event:${message.event}\n` : ""}data:${message.data}\n\n`,
    "utf8",
  );
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

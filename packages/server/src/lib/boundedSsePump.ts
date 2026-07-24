import { Buffer } from "node:buffer";

export interface SseMessage {
  data: string;
  event?: string;
  id?: string;
}

export interface BoundedSsePumpOptions {
  write: (message: SseMessage) => Promise<unknown>;
  onClose: (reason: "overflow" | "write_error") => void;
  maxFrames?: number;
  maxBytes?: number;
}

export const DEFAULT_SSE_QUEUE_MAX_FRAMES = 64;
export const DEFAULT_SSE_QUEUE_MAX_BYTES = 512 * 1024;

interface QueuedMessage {
  message: SseMessage;
  bytes: number;
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
  private pumping = false;
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly options: BoundedSsePumpOptions) {
    this.maxFrames = positiveInteger(options.maxFrames, DEFAULT_SSE_QUEUE_MAX_FRAMES);
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_SSE_QUEUE_MAX_BYTES);
  }

  enqueue(message: SseMessage): boolean {
    if (this.closed) return false;
    const bytes = messageBytes(message);
    if (bytes > this.maxBytes || this.queue.length >= this.maxFrames || this.queuedBytes + bytes > this.maxBytes) {
      this.close("overflow");
      return false;
    }
    this.queue.push({ message, bytes });
    this.queuedBytes += bytes;
    this.startPump();
    return true;
  }

  close(reason?: "overflow" | "write_error"): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    if (reason) this.options.onClose(reason);
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
        await this.options.write(queued.message);
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

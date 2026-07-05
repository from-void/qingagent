export type TrackToolUsed = (name: string) => void;

export interface ToolCallStreamScannerOptions {
  maxSeenIds?: number;
  carryChars?: number;
}

const TOOL_CALL_RE = /"toolCallId":"([^"]{1,64})","spec":\{[\s\S]{0,200}?"name":"([A-Za-z0-9_.-]{1,64})"/g;
const TOOL_CALL_ID_RE = /"toolCallId":"([^"]{1,64})"/g;

// 扫 agent SSE 流里的 toolCallUpdated 帧,按 toolCallId 去重后上报 tool_used。
// 同一次调用会有多帧(status 变化),toolCallId 去重保证一次调用只报一条;"每天一次"由网关规则决定。
export class ToolCallStreamScanner {
  private readonly seenToolCallIds = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly maxSeenIds: number;
  private readonly carryChars: number;

  constructor(
    private readonly trackToolUsed: TrackToolUsed,
    options: ToolCallStreamScannerOptions = {},
  ) {
    this.maxSeenIds = Math.max(1, options.maxSeenIds ?? 2000);
    this.carryChars = Math.max(0, options.carryChars ?? 1024);
  }

  async scan(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let carry = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = carry + decoder.decode(value, { stream: true });
        const nextCarry = this.sliceCarry(text);
        const protectedIds = collectToolCallIds(nextCarry);
        const observedInText = new Set<string>();
        TOOL_CALL_RE.lastIndex = 0;

        let m: RegExpExecArray | null;
        while ((m = TOOL_CALL_RE.exec(text))) {
          const callId = m[1];
          const name = m[2];
          if (!callId || !name || observedInText.has(callId)) continue;
          observedInText.add(callId);
          if (this.seenToolCallIds.has(callId)) continue;

          this.remember(callId, protectedIds);
          this.trackToolUsed(name);
        }

        this.trimSeen(protectedIds);
        carry = nextCarry;
      }
    } catch {
      /* 观察失败不影响生成主流 */
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* noop */
      }
    }
  }

  private sliceCarry(text: string): string {
    return this.carryChars > 0 ? text.slice(-this.carryChars) : "";
  }

  private remember(callId: string, protectedIds: ReadonlySet<string>): void {
    this.seenToolCallIds.add(callId);
    this.seenOrder.push(callId);
    this.trimSeen(protectedIds);
  }

  private trimSeen(protectedIds: ReadonlySet<string>): void {
    let rotatedProtected = 0;
    while (this.seenToolCallIds.size > this.maxSeenIds && this.seenOrder.length > 0) {
      const oldest = this.seenOrder.shift();
      if (!oldest || !this.seenToolCallIds.has(oldest)) continue;
      if (protectedIds.has(oldest)) {
        this.seenOrder.push(oldest);
        rotatedProtected += 1;
        if (rotatedProtected >= this.seenOrder.length) break;
        continue;
      }
      this.seenToolCallIds.delete(oldest);
      rotatedProtected = 0;
    }
  }
}

function collectToolCallIds(text: string): Set<string> {
  const ids = new Set<string>();
  TOOL_CALL_ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_CALL_ID_RE.exec(text))) {
    if (m[1]) ids.add(m[1]);
  }
  return ids;
}

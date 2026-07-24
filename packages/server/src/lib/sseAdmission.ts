import type { Context } from "hono";
import { isLoopbackHost } from "./debugGate";

export type SseAdmissionRejection = "total" | "ip" | "session";

export type SseAdmissionResult =
  | { accepted: true; release: () => void }
  | { accepted: false; reason: SseAdmissionRejection };

export interface SseAdmissionLimits {
  maxTotal: number;
  maxPerIp: number;
  maxPerSession: number;
}

export const DEFAULT_SSE_ADMISSION_LIMITS: SseAdmissionLimits = {
  maxTotal: 256,
  maxPerIp: 32,
  maxPerSession: 16,
};

export class SseAdmissionController {
  private total = 0;
  private readonly byIp = new Map<string, number>();
  private readonly bySession = new Map<string, number>();

  constructor(private readonly limits: SseAdmissionLimits = DEFAULT_SSE_ADMISSION_LIMITS) {}

  acquire(ip: string, sessionId: string, options: { loopback?: boolean } = {}): SseAdmissionResult {
    // 本机单用户开发/agent-browser 评测可以合法打开大量标签；公网来源才进入 DoS 预算。
    if (options.loopback) return { accepted: true, release: () => undefined };
    if (this.total >= this.limits.maxTotal) return { accepted: false, reason: "total" };
    if ((this.byIp.get(ip) ?? 0) >= this.limits.maxPerIp) {
      return { accepted: false, reason: "ip" };
    }
    if ((this.bySession.get(sessionId) ?? 0) >= this.limits.maxPerSession) {
      return { accepted: false, reason: "session" };
    }

    this.total += 1;
    increment(this.byIp, ip);
    increment(this.bySession, sessionId);
    let active = true;
    return {
      accepted: true,
      release: () => {
        if (!active) return;
        active = false;
        this.total -= 1;
        decrement(this.byIp, ip);
        decrement(this.bySession, sessionId);
      },
    };
  }

  stats(): { total: number; ips: number; sessions: number } {
    return { total: this.total, ips: this.byIp.size, sessions: this.bySession.size };
  }
}

/** /events、external events 与 folder bridge 共用总量/IP/会话准入账本。 */
export const sseAdmission = new SseAdmissionController();

export interface RequestClientAddress {
  ip: string;
  loopback: boolean;
}

/**
 * 非回环直连永不因伪造转发头获得回环豁免；只有连接本身来自回环代理时才采信
 * X-Forwarded-For/X-Real-IP。app.request 没有 socket，按本机测试调用处理。
 */
export function requestClientAddress(c: Context): RequestClientAddress {
  const incoming = (c.env as {
    incoming?: { socket?: { remoteAddress?: string | null } };
  } | undefined)?.incoming;
  const remote = normalizeIp(incoming?.socket?.remoteAddress);
  if (remote && !isLoopbackIp(remote)) return { ip: remote, loopback: false };

  const forwarded = normalizeIp(c.req.header("x-forwarded-for")?.split(",", 1)[0]);
  const real = normalizeIp(c.req.header("x-real-ip"));
  const ip = forwarded || real || remote || "direct";
  return { ip, loopback: ip === "direct" || isLoopbackIp(ip) };
}

function normalizeIp(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("::ffff:")) return normalized.slice(7);
  return normalized;
}

function isLoopbackIp(ip: string): boolean {
  return isLoopbackHost(ip);
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrement(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 1) - 1;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

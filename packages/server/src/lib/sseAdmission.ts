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

  acquire(ip: string, sessionId: string): SseAdmissionResult {
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

export function requestClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "direct";
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrement(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 1) - 1;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

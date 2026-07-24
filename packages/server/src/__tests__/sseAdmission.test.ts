import { describe, expect, it } from "vitest";
import { SseAdmissionController } from "../lib/sseAdmission";

describe("SseAdmissionController", () => {
  it("分别限制总连接数、每 IP 与每会话，并在释放后恢复名额", () => {
    const perSession = new SseAdmissionController({
      maxTotal: 4,
      maxPerIp: 3,
      maxPerSession: 1,
    });
    const first = perSession.acquire("ip-a", "session-a");
    expect(first.accepted).toBe(true);
    expect(perSession.acquire("ip-b", "session-a")).toEqual({
      accepted: false,
      reason: "session",
    });
    if (first.accepted) first.release();
    expect(perSession.acquire("ip-b", "session-a").accepted).toBe(true);

    const perIp = new SseAdmissionController({
      maxTotal: 4,
      maxPerIp: 1,
      maxPerSession: 4,
    });
    expect(perIp.acquire("ip-a", "session-a").accepted).toBe(true);
    expect(perIp.acquire("ip-a", "session-b")).toEqual({
      accepted: false,
      reason: "ip",
    });

    const total = new SseAdmissionController({
      maxTotal: 1,
      maxPerIp: 4,
      maxPerSession: 4,
    });
    expect(total.acquire("ip-a", "session-a").accepted).toBe(true);
    expect(total.acquire("ip-b", "session-b")).toEqual({
      accepted: false,
      reason: "total",
    });
  });

  it("回环来源豁免总量、IP 与会话上限且不占公网账本", () => {
    const admission = new SseAdmissionController({
      maxTotal: 1,
      maxPerIp: 1,
      maxPerSession: 1,
    });

    for (let index = 0; index < 300; index += 1) {
      expect(admission.acquire("127.0.0.1", "same-session", { loopback: true }).accepted).toBe(true);
    }
    expect(admission.stats()).toEqual({ total: 0, ips: 0, sessions: 0 });
    expect(admission.acquire("203.0.113.10", "public-session").accepted).toBe(true);
    expect(admission.acquire("203.0.113.11", "other-session")).toEqual({
      accepted: false,
      reason: "total",
    });
  });
});

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
});

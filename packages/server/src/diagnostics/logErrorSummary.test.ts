import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeLogErrors } from "./logErrorSummary";

describe("summarizeLogErrors", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("同消息不同 uuid/数字/路径 归一为一条", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T12:00:00.000Z"));

    const summary = summarizeLogErrors([
      {
        path: "logs/server-2026-07-08.log",
        content: [
          "[2026-07-08T11:00:00.000Z] [ERROR] request 123 failed id=11111111-1111-4111-8111-111111111111 path=/tmp/a/file.txt",
          "[2026-07-08T11:01:00.000Z] [ERROR] request 456 failed id=22222222-2222-4222-8222-222222222222 path=/tmp/b/file.txt",
        ].join("\n"),
      },
    ]);

    expect(summary).toContain("count=2");
    expect(summary).toContain("request <num> failed id=<uuid> path=<path>");
  });

  it("按时间窗过滤旧日志", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T12:00:00.000Z"));

    const summary = summarizeLogErrors([
      {
        path: "logs/server-2026-07-08.log",
        content: [
          "[2026-07-08T11:00:00.000Z] [WARN] fresh warning",
          "[2026-07-07T10:00:00.000Z] [ERROR] stale error",
        ].join("\n"),
      },
    ], { windowHours: 24 });

    expect(summary).toContain("fresh warning");
    expect(summary).not.toContain("stale error");
  });

  it("按计数取 top N", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T12:00:00.000Z"));

    const summary = summarizeLogErrors([
      {
        path: "logs/server-2026-07-08.log",
        content: [
          "[2026-07-08T11:00:00.000Z] [ERROR] a",
          "[2026-07-08T11:01:00.000Z] [ERROR] a",
          "[2026-07-08T11:02:00.000Z] [WARN] b",
        ].join("\n"),
      },
    ], { topN: 1 });

    expect(summary).toContain("count=2");
    expect(summary).toContain("a");
    expect(summary).not.toContain("b");
  });

  it("空日志返回无", () => {
    expect(summarizeLogErrors([])).toBe("无");
  });
});

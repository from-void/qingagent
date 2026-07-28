import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "@qingagent/contract-ts";
import { sessionMetaToHomeSession } from "./sessions";

describe("sessionMetaToHomeSession 相对日期", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("按本地日历日识别跨午夜的昨天", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 28, 0, 30));
    const session = sessionMetaToHomeSession(
      makeSession(new Date(2026, 6, 27, 23, 30).toISOString()),
    );

    expect(session.date).toBe("昨天");
  });

  it("未来日期使用稳定文案，不生成负数相对时间", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 28, 12));
    const session = sessionMetaToHomeSession(
      makeSession(new Date(2026, 7, 2, 12).toISOString()),
    );

    expect(session.date).toBe("今天");
  });

  it("非法日期使用稳定文案和有限排序回退值", () => {
    const session = sessionMetaToHomeSession({
      ...makeSession("not-a-date"),
      updated_at: "also-not-a-date",
      summary: "",
    });

    expect(session.date).toBe("未知日期");
    expect(session.brief).toBe("未知日期创建");
    expect(session.createdAt).toBe(0);
    expect(session.recentEditedAt).toBe(0);
    expect(session.pushedAt).toBe(0);
    expect([
      session.createdAt,
      session.recentEditedAt,
      session.pushedAt,
    ].every(Number.isFinite)).toBe(true);
  });
});

function makeSession(createdAt: string): SessionMeta {
  return {
    id: "session-1",
    title: "标题",
    created_at: createdAt,
    summary: "摘要",
    status: { kind: "Active" },
  };
}

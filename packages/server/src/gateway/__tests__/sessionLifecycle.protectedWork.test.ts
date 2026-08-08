import { describe, expect, it } from "vitest";
import type { Command } from "@qingagent/contract-ts";
import { createSession } from "@qingagent/core";
import { hasProtectedSessionWork } from "../sessionLifecycle";

function message(review = false): Command {
  return {
    kind: "sendMessage",
    data: {
      sessionId: "protected-work",
      text: review ? "开始审查" : "普通消息",
      skills: [],
      chips: [],
      fileIds: [],
      ...(review
        ? {
            reviewContext: {
              type: "consistency" as const,
              templateId: "review-consistency-default",
              templateName: "全面自洽核查",
            },
          }
        : {}),
    },
  };
}

describe("hasProtectedSessionWork", () => {
  it("把当前审查命令纳入保护集，普通消息仍可被新消息接管", () => {
    const session = createSession("protected-work");

    expect(hasProtectedSessionWork(session, message(true))).toBe(true);
    expect(hasProtectedSessionWork(session, message(false))).toBe(false);
  });

  it("冷会话尚未恢复进注册表时也按当前命令识别审查，关闭加载竞态", () => {
    expect(hasProtectedSessionWork(undefined, message(true))).toBe(true);
    expect(hasProtectedSessionWork(undefined, message(false))).toBe(false);
  });

  it.each(["pending", "resuming"] as const)(
    "保留确认卡 %s 的既有保护语义",
    (status) => {
      const session = createSession(`confirm-${status}`);
      session.pendingConfirms.set("confirm-1", {
        toolCallId: "confirm-1",
        confirmId: "confirm-1",
        status,
      } as never);

      expect(hasProtectedSessionWork(session, message(false))).toBe(true);
    },
  );

  it("保留已确认命令执行中的既有保护语义", () => {
    const session = createSession("confirmed-running");
    session._activeConfirmedToolCallId = "tool-confirmed";

    expect(hasProtectedSessionWork(session, message(false))).toBe(true);
  });
});

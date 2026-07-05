import { describe, expect, it } from "vitest";
import {
  canRetryStreamError,
  shouldStickStreamErrorToast,
  streamErrorActionLabel,
  streamErrorLabel,
  streamErrorToastMessage,
  streamErrorToastRole,
  streamErrorToastTone,
} from "./streamErrorPresenter";

describe("streamErrorPresenter", () => {
  it("draftingFailed 按真实原因区分 label 并开放 retriable 重试", () => {
    const empty = {
      kind: "draftingFailed" as const,
      reason: "模型没有返回任何内容，请重试。",
      retriable: true,
    };
    const timeout = {
      kind: "draftingFailed" as const,
      reason: "生成长时间无响应，请重试。",
      retriable: true,
    };

    expect(streamErrorLabel(empty)).toBe("没有生成内容");
    expect(streamErrorLabel(timeout)).toBe("生成中断");
    expect(canRetryStreamError(empty)).toBe(true);
  });

  it("402 余额/配额不足不可重试，并提示检查模型设置/余额", () => {
    const quota = {
      kind: "draftingFailed" as const,
      reason: "模型余额或调用额度不足，请检查模型设置或账户余额。",
      retriable: false,
      statusCode: 402,
      category: "quota" as const,
      userMessage: "模型余额或调用额度不足，请检查模型设置或账户余额。",
      action: "check_balance" as const,
    };

    expect(streamErrorLabel(quota)).toBe("余额/配额不足");
    expect(canRetryStreamError(quota)).toBe(false);
    expect(streamErrorActionLabel(quota)).toBe("检查模型设置/余额");
    expect(streamErrorToastTone(quota)).toBe("error");
    expect(shouldStickStreamErrorToast(quota)).toBe(true);
    expect(streamErrorToastRole(quota)).toBe("alert");
    expect(streamErrorToastMessage(quota)).toContain("余额/配额不足");
  });

  it("cancelled 是用户主动中止:走瞬时 warn status 而非常驻失败", () => {
    const cancelled = {
      kind: "cancelled" as const,
      reason: "已手动停止生成",
    };

    expect(streamErrorLabel(cancelled)).toBe("已取消");
    expect(streamErrorToastTone(cancelled)).toBe("warn");
    expect(shouldStickStreamErrorToast(cancelled)).toBe(false);
    expect(streamErrorToastRole(cancelled)).toBe("status");
  });
});

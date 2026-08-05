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

  it("批注修改零候选直接展示中性中文反馈", () => {
    const annotationMutation = {
      kind: "draftingFailed" as const,
      reason: "未能生成修改，可再试或手动编辑。",
      retriable: true,
    };

    expect(streamErrorToastMessage(annotationMutation)).toBe(
      "未能生成修改，可再试或手动编辑。",
    );
    expect(streamErrorToastTone(annotationMutation)).toBe("warn");
    expect(canRetryStreamError(annotationMutation)).toBe(true);
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

  it("内网地址被本地策略拦截:独立 label,不给无用的重试入口", () => {
    const reason =
      "模型地址解析为内网地址，被本地安全策略拦截。" +
      "若这是公司或自建的内网模型服务：桌面客户端请更新到最新版（已默认放行）；" +
      "自部署请设置 QINGAGENT_ALLOW_PRIVATE_MODEL_HOST=1。";
    const blocked = {
      kind: "draftingFailed" as const,
      reason,
      retriable: false,
      category: "blocked_address" as const,
      userMessage: reason,
      action: "check_model_settings" as const,
    };

    expect(streamErrorLabel(blocked)).toBe("模型地址被安全策略拦截");
    expect(canRetryStreamError(blocked)).toBe(false);
    expect(streamErrorActionLabel(blocked)).toBe("检查模型设置");
    expect(streamErrorToastMessage(blocked)).toContain("内网地址");
  });

  it.each([
    [400, "素材或对话内容超出模型上下文长度。请删除部分素材、改用摘要，或拆分后分段处理。"],
    [413, "请求中的素材或内容体量过大，模型服务拒绝接收。请删除部分素材、改用摘要，或拆分后分段处理。"],
  ])("HTTP %s 素材体量错误使用准确标题", (statusCode, reason) => {
    const error = {
      kind: "draftingFailed" as const,
      reason,
      retriable: false,
      statusCode,
      category: "request" as const,
      userMessage: reason,
      action: "none" as const,
    };

    expect(streamErrorLabel(error)).toBe("素材过大");
    expect(streamErrorToastMessage(error)).toContain(reason);
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

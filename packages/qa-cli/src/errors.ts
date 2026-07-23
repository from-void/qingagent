export type QaErrorCode =
  | "NO_INSTANCE"
  | "AUTH_FAILED"
  | "AGENT_BUSY"
  | "REVIEW_PENDING"
  | "VERSION_CONFLICT"
  | "VALIDATION"
  | "NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "MATERIAL_NOT_FOUND"
  | "RATE_LIMITED";

export const NEXT_STEP: Record<QaErrorCode, string> = {
  REVIEW_PENDING: "用 `qa review list -s <id>` 查看待审修改,再用 `qa review accept|reject|commit` 完成审查",
  AGENT_BUSY: "青简 agent 正在干活,稍等重试一次;仍忙则告知用户并等 events",
  VERSION_CONFLICT: "文档已被改过,请 `qa doc read` 重读,基于新版本重做提案,绝不原样重发",
  AUTH_FAILED: "实例没了/重启了,重新 `qa status` 感应;还不行请告诉用户打开青简",
  NO_INSTANCE: "实例没了/重启了,重新 `qa status` 感应;还不行请告诉用户打开青简",
  VALIDATION: "提案不合法(空文档只能 fullDraft / 已有文档禁整篇覆写 / 未命中 / 超 50 处),按提示改",
  NOT_FOUND: "实例没了/重启了,重新 `qa status` 感应;还不行请告诉用户打开青简",
  SESSION_NOT_FOUND: "会话不存在,用 `qa sessions list` 重新对号,不要重试原 id",
  MATERIAL_NOT_FOUND: "材料不存在,用 `qa files list` 重新对号,不要重试原 id",
  RATE_LIMITED: "请求太频繁,请降低读取频率并优先使用 `qa doc events --follow`",
};

export class QaCliError extends Error {
  readonly code: QaErrorCode;
  readonly details: unknown;

  constructor(code: QaErrorCode, message?: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "QaCliError";
  }
}

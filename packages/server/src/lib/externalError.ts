import type { ExternalErrorCode } from "../../../contract-ts/src/ExternalApi";
import type { Context } from "hono";

export const EXTERNAL_NEXT_STEP: Record<ExternalErrorCode, string> = {
  REVIEW_PENDING: "青简里有待处理的修改建议,请先采纳或拒绝;然后用 `qa doc events --follow` 等 docCommitted 再继续",
  AGENT_BUSY: "青简 agent 正在干活,稍等重试一次;仍忙则告知用户并等 events",
  VERSION_CONFLICT: "文档已被改过,请 `qa doc read` 重读,基于新版本重做提案,绝不原样重发",
  AUTH_FAILED: "实例没了/重启了,重新 `qa status` 感应;还不行请告诉用户打开青简",
  NOT_FOUND: "实例没了/重启了,重新 `qa status` 感应;还不行请告诉用户打开青简",
  SESSION_NOT_FOUND: "会话不存在,用 `qa sessions list` 重新对号,不要重试原 id",
  MATERIAL_NOT_FOUND: "材料不存在,用 `qa files list` 重新对号,不要重试原 id",
  VALIDATION: "提案不合法(空文档只能 fullDraft / 已有文档禁整篇覆写 / 未命中 / 超 50 处),按提示改",
  RATE_LIMITED: "请求太频繁,请降低读取频率并优先使用 `qa doc events --follow`",
};

export function externalError(
  c: Context,
  status: 400 | 401 | 404 | 409 | 429,
  code: ExternalErrorCode,
  message?: string,
) {
  return c.json(
    { error: message ?? code, code, nextStep: EXTERNAL_NEXT_STEP[code] },
    status,
  );
}

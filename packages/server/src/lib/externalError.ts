import type { ExternalErrorCode } from "../../../contract-ts/src/ExternalApi";
import type { Context } from "hono";

export const EXTERNAL_NEXT_STEP: Record<ExternalErrorCode, string> = {
  REVIEW_PENDING: "用 `qa review list -s <id>` 查看待审修改并采纳或拒绝（也可在青简中处理）；然后用 `qa doc events --follow` 等 docCommitted 再继续",
  CONFLICT: "资源已变化,请重新读取最新版本后再提交",
  AGENT_BUSY: "青简 agent 正在干活,稍等重试一次;仍忙则告知用户并等 events",
  VERSION_CONFLICT: "文档已被改过,请 `qa doc read` 重读,基于新版本重做提案,绝不原样重发",
  AUTH_FAILED: "实例没了/重启了,重新 `qa status` 感应;还不行请告诉用户打开青简",
  NOT_FOUND: "实例没了/重启了,重新 `qa status` 感应;还不行请告诉用户打开青简",
  SESSION_NOT_FOUND: "会话不存在,用 `qa sessions list` 重新对号,不要重试原 id;若确认 id 正确,可能是清单分页未覆盖,用 `qa sessions list --all`",
  MATERIAL_NOT_FOUND: "材料不存在,用 `qa files list` 重新对号,不要重试原 id",
  VALIDATION: "提案不合法(空文档只能 fullDraft/qingmlDraft / 已有文档禁 fullDraft / QingML 结构有害降级 / 未命中 / 超 50 处),按提示改",
  RATE_LIMITED: "请求太频繁,请降低读取频率并优先使用 `qa doc events --follow`",
};

export function externalError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503,
  code: ExternalErrorCode,
  message?: string,
  nextStep?: string,
) {
  if (status === 429) c.header("Retry-After", "1");
  return c.json(
    { error: message ?? code, code, nextStep: nextStep ?? EXTERNAL_NEXT_STEP[code] },
    status,
  );
}

import type { ToastTone } from "../../../system/ToastProvider";
import type { StreamError } from "../data/protocol";

const ANNOTATION_MUTATION_NO_PATCH_NOTICE = "未能生成修改，可再试或手动编辑。";

function isAnnotationMutationNoPatch(error: StreamError): boolean {
  return error.kind === "draftingFailed"
    && error.reason.trim() === ANNOTATION_MUTATION_NO_PATCH_NOTICE;
}

export function streamErrorLabel(error: StreamError): string {
  if (error.kind === "cancelled") return "已取消";
  if (error.kind === "docWriteConflict") return "文档已被改动";
  if (error.category === "quota" || error.statusCode === 402) return "余额/配额不足";
  if (error.category === "auth" || error.statusCode === 401 || error.statusCode === 403) return "模型配置不可用";
  if (error.category === "blocked_address") return "模型地址被安全策略拦截";
  if (error.kind === "draftingFailed") {
    if (/没有返回任何内容|空响应|empty/i.test(error.reason)) return "没有生成内容";
    if (/tool-only|工具调用|步数|未完成/i.test(error.reason)) return "生成未完成";
    if (/长时间无响应|timeout|超时/i.test(error.reason)) return "生成中断";
    return "生成失败";
  }
  return "连接失败";
}

export function canRetryStreamError(error: StreamError): boolean {
  if (error.retriable === false) return false;
  if (error.action && error.action !== "retry" && error.kind !== "docWriteConflict") return false;
  return error.kind === "docWriteConflict" || error.kind === "failed" || error.retriable === true;
}

export function streamErrorActionLabel(error: StreamError): string | null {
  if (canRetryStreamError(error)) {
    return error.kind === "docWriteConflict" ? "重载" : "重试";
  }
  if (error.action === "reload") return "重载";
  if (error.action === "check_balance") return "检查模型设置/余额";
  if (error.action === "check_model_settings") return "检查模型设置";
  return null;
}

export function streamErrorToastMessage(error: StreamError): string {
  if (isAnnotationMutationNoPatch(error)) return ANNOTATION_MUTATION_NO_PATCH_NOTICE;
  const label = streamErrorLabel(error);
  const reason = error.reason.trim();
  return reason ? `${label} · ${reason}` : label;
}

export function streamErrorToastTone(error: StreamError): ToastTone {
  if (isAnnotationMutationNoPatch(error)) return "warn";
  return error.kind === "cancelled" || error.kind === "docWriteConflict" ? "warn" : "error";
}

export function shouldStickStreamErrorToast(error: StreamError): boolean {
  return error.kind !== "cancelled";
}

export function streamErrorToastRole(error: StreamError): "status" | "alert" {
  return shouldStickStreamErrorToast(error) ? "alert" : "status";
}

export type QaErrorCode =
  | "NO_INSTANCE"
  | "INVALID_RESPONSE"
  | "EVENT_TARGET_NOT_REACHED"
  | "AUTH_FAILED"
  | "AGENT_BUSY"
  | "REVIEW_PENDING"
  | "CONFLICT"
  | "VERSION_CONFLICT"
  | "VALIDATION"
  | "NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "MATERIAL_NOT_FOUND"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE";

export const NEXT_STEP: Record<QaErrorCode, string> = {
  INVALID_RESPONSE: "确认青简与 qa-cli 版本匹配；仍失败请重启青简后重试一次",
  REVIEW_PENDING: "用 `qa review list -s <id>` 查看待审修改,再用 `qa review accept|reject|commit` 完成审查",
  CONFLICT: "远端资源已变化,请重新读取最新版本后再提交",
  AGENT_BUSY: "青简 agent 正在干活,稍等重试一次;仍忙则告知用户并等 events",
  VERSION_CONFLICT: "文档已被改过,请 `qa doc read` 重读,基于新版本重做提案,绝不原样重发",
  AUTH_FAILED: "实例没了/重启了,重新 `qa status` 感应;还不行请告诉用户打开青简",
  NO_INSTANCE: "实例没了/重启了,重新 `qa status` 感应;还不行请告诉用户打开青简",
  EVENT_TARGET_NOT_REACHED: "事件流已结束但目标未命中,用 `qa doc state -s <id> --json` 对账后再决定是否续听",
  VALIDATION: "提案不合法(空文档只能 fullDraft/qingmlDraft / 已有文档禁 fullDraft / QingML 结构有害降级 / 未命中 / 超 50 处),按提示改",
  NOT_FOUND: "实例没了/重启了,重新 `qa status` 感应;还不行请告诉用户打开青简",
  SESSION_NOT_FOUND: "会话不存在,用 `qa sessions list` 重新对号,不要重试原 id",
  MATERIAL_NOT_FOUND: "材料不存在,用 `qa files list` 重新对号,不要重试原 id",
  RATE_LIMITED: "请求太频繁,请降低读取频率并优先使用 `qa doc events --follow`",
  SERVICE_UNAVAILABLE: "先运行 `qa status` 检查实例状态,稍后重试一次;仍失败请告知用户",
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

export function formatQaCliError(args: string[], error: QaCliError): string {
  const hint = commandErrorHint(args, error);
  return `${error.code}: ${error.message}\n${hint ? `下一步: ${hint}\n` : ""}`;
}

export function commandErrorHint(
  args: string[],
  error: QaCliError,
): string | null {
  const group = args[0];
  const command = args[1];
  const remote = remoteNextStep(error.details);
  const common = commonErrorHint(error.code);

  if (group === "template") {
    if (error.code === "CONFLICT") {
      if (error.message.includes("内置")) {
        return "内置模板只能使用 `qa template select <id>` 选用，不能修改或删除";
      }
      return remote?.includes("qa template")
        ? remote
        : "用 `qa template pull <id> --out <file.md>` 拉取最新版，合并后再 push";
    }
    if (error.code === "NOT_FOUND") {
      return "用 `qa template list [--type <t>]` 重新确认模板 id";
    }
    if (error.code === "VALIDATION") {
      if (error.message.includes("禁止") || error.message.includes("权限")) {
        return "当前实例未开启模板写入权限；请在受信部署中配置 QINGAGENT_ALLOW_TEMPLATE_MUTATION";
      }
      return "按错误正文检查模板 type、name、prompt、frontmatter 与模板写入权限";
    }
    return common;
  }

  if (group === "skills") {
    if (error.code === "CONFLICT") {
      return error.message.includes("内置")
        ? "内置技能不能覆盖或删除；只能使用 `qa skills enable|disable <name>` 调整启停"
        : "用 `qa skills list` 检查重名；更新仅适用于 source=installed 的技能";
    }
    if (error.code === "NOT_FOUND") {
      return "用 `qa skills list` 重新确认技能名称和 source";
    }
    if (error.code === "VALIDATION") {
      if (error.message.includes("禁止") || error.message.includes("权限")) {
        return "当前实例未开启技能写入权限；请在受信部署中配置 QINGAGENT_ALLOW_SKILL_MUTATION";
      }
      return "先运行 `qa skills validate <dir>`，再按错误正文修正 SKILL.md 或文件路径";
    }
    return common;
  }

  if (group === "review") {
    if (error.code === "NOT_FOUND" && command === "run") {
      return "用 `qa template list --type <t>` 确认模板存在且类型与 --type 一致";
    }
    if (error.code === "NOT_FOUND") {
      return "用 `qa review list -s <id>` 重新确认审查项";
    }
    if (error.code === "VALIDATION") {
      return command === "run"
        ? "检查 -s、--type、--template 与 --supplement；模板类型必须与 --type 一致"
        : "按错误正文检查审查目标、文档版本和命令参数";
    }
    return common ?? remote;
  }

  if (group === "doc") {
    return remote ?? NEXT_STEP[error.code];
  }
  if (error.code === "VALIDATION") return null;
  return common ?? remote;
}

function commonErrorHint(code: QaErrorCode): string | null {
  if (
    code === "NO_INSTANCE" ||
    code === "INVALID_RESPONSE" ||
    code === "AUTH_FAILED" ||
    code === "AGENT_BUSY" ||
    code === "REVIEW_PENDING" ||
    code === "VERSION_CONFLICT" ||
    code === "SESSION_NOT_FOUND" ||
    code === "MATERIAL_NOT_FOUND" ||
    code === "RATE_LIMITED" ||
    code === "SERVICE_UNAVAILABLE"
  ) {
    return NEXT_STEP[code];
  }
  return null;
}

function remoteNextStep(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const value = (details as { nextStep?: unknown }).nextStep;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

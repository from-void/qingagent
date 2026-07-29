import type { ConfirmSpec } from "@qingagent/contract-ts";
import { confirmSpecSchema } from "@qingagent/contract-ts/schemas";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { redactSensitiveText } from "../agent-run/redaction.js";
import { assessCommand } from "../workspace/commandRisk.js";
import { formatCommandDuration } from "../workspace/backgroundCommandLimits.js";
import {
  BACKGROUND_TIMEOUT_LIMIT_SECONDS,
  FOREGROUND_TIMEOUT_LIMIT_SECONDS,
  resolveCommandTimeout,
} from "../workspace/commandTimeoutPolicy.js";
import {
  isEnvEnabled,
  sessionWorkspaceDir,
} from "../workspace/sessionWorkspace.js";

const durationSchema = z.preprocess(
  (value) => {
    if (value === null || value === undefined || value === "") return undefined;
    return typeof value === "string" ? Number(value) : value;
  },
  z.number().positive().optional(),
);

/**
 * 单位歧义是已实证的 P1：模型按毫秒风格写 `timeout: 15000`，协议却按秒解释成 15000 秒。
 * 因此三个字段的 description 都必须把单位与上限写死在模型一眼能看到的地方。
 */
export const TIMEOUT_SECONDS_DESCRIPTION =
  `命令超时，单位=秒，不是毫秒。前台最长 ${FOREGROUND_TIMEOUT_LIMIT_SECONDS} 秒，` +
  `后台（background:true）最长 ${BACKGROUND_TIMEOUT_LIMIT_SECONDS} 秒；` +
  "超过上限会被自动钳制到上限，结果里会告知实际生效值。例：timeoutSeconds: 60 表示 60 秒。" +
  "需要等更久（扫码/登录授权等）请改用 background:true，不要把秒数写大。";
export const TIMEOUT_MS_DESCRIPTION =
  "命令超时，单位=毫秒。与 timeoutSeconds 互斥，只能二选一。" +
  `同样受硬上限钳制：前台最长 ${FOREGROUND_TIMEOUT_LIMIT_SECONDS * 1_000} 毫秒。`;
export const LEGACY_TIMEOUT_DESCRIPTION =
  "已废弃的旧字段，单位=秒，不是毫秒。仅为兼容保留，新调用一律用 timeoutSeconds；" +
  "与 timeoutSeconds/timeoutMs 同时给出时以新字段为准。";

export const MAX_EXECUTE_COMMAND_LENGTH = 8_192;
export const MAX_EXECUTE_COMMAND_REASON_LENGTH = 80;

function joinExplanationParts(parts: Array<string | undefined>): string {
  const uniqueParts = parts.filter(
    (value, index, values): value is string =>
      Boolean(value) && values.indexOf(value) === index,
  );
  return uniqueParts.reduce(
    (explanation, part) =>
      explanation
        ? `${explanation}${/[。！？.!?]$/u.test(explanation) ? "" : "。"}${part}`
        : part,
    "",
  );
}

function mentionsInstallAction(reason: string): boolean {
  return /下载|安装|装(?:好|上|入|这个|该|工具|软件|依赖|命令行|[。！？.!?]|$)/u.test(reason);
}

export function insecureRememberEnvironmentAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const explicitDevelopmentRuntime = env.NODE_ENV === "development" || (
    env.QINGAGENT_RUNTIME === "desktop" &&
    env.QINGAGENT_DESKTOP_PACKAGED !== "1"
  );
  return explicitDevelopmentRuntime &&
    env.QINGAGENT_PUBLIC_DEPLOYMENT !== "1" &&
    env.QINGAGENT_DESKTOP_PACKAGED !== "1" &&
    isEnvEnabled(env.QINGAGENT_DEV_ALLOW_INSECURE_REMEMBER);
}

export const executeCommandInputSchema = z.object({
  command: z.string().min(1).max(MAX_EXECUTE_COMMAND_LENGTH),
  reason: z.string()
    .max(MAX_EXECUTE_COMMAND_REASON_LENGTH)
    .describe("面向用户简短说明为什么需要执行这条命令")
    .optional(),
  timeoutSeconds: durationSchema.nullish().describe(TIMEOUT_SECONDS_DESCRIPTION),
  timeoutMs: durationSchema.nullish().describe(TIMEOUT_MS_DESCRIPTION),
  timeout: durationSchema.nullish().describe(LEGACY_TIMEOUT_DESCRIPTION),
  cwd: z.string().max(1_024).nullish(),
  tail: z.number().int().nonnegative().max(100_000).nullish(),
  background: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  // 两个新字段单位不同，同时给出无法判断模型的真实意图，只能明确报错让它改写。
  if (
    typeof value.timeoutSeconds === "number" &&
    typeof value.timeoutMs === "number"
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["timeoutMs"],
      message: "timeoutSeconds 与 timeoutMs 互斥，只能二选一（timeoutSeconds 单位=秒，timeoutMs 单位=毫秒）",
    });
  }
});

export type ExecuteCommandInput = z.infer<typeof executeCommandInputSchema>;

function lexicalExecutionCwd(sessionId: string, cwd?: string | null): string {
  const sessionDir = sessionWorkspaceDir(sessionId);
  return cwd && cwd.length > 0 ? resolve(sessionDir, cwd) : sessionDir;
}

export function commandConfirmationDigest(
  sessionId: string,
  input: ExecuteCommandInput,
): string {
  // 超时按归一后的毫秒入摘要：新旧字段换写法不会伪造出新摘要，也不会绕过已发放的确认。
  const stable = JSON.stringify({
    command: input.command,
    timeoutMs: resolveCommandTimeout(input, { background: input.background === true }).requestedMs
      ?? null,
    cwd: lexicalExecutionCwd(sessionId, input.cwd),
    tail: input.tail ?? null,
    background: input.background === true,
  });
  return createHash("sha256").update(stable).digest("hex");
}

export function buildCommandConfirmSpec(
  input: ExecuteCommandInput,
  policyReason: string,
  id: string = randomUUID(),
): ConfirmSpec {
  const verdict = assessCommand(input.command);
  const preview = redactSensitiveText(input.command).replace(/\s+/g, " ").trim().slice(0, 320);
  const kind = verdict.confirmKind ?? "command";
  const isMultiEffect = verdict.effects.length > 1;
  const riskSub = kind === "install" && !input.background
    ? undefined
    : verdict.risk === "safe"
      ? "资源受限后台命令"
      : kind === "install"
        ? "可能会改动这台电脑上的软件或设置"
        : kind === "send"
          ? "将向外部发送或写入数据"
          : isMultiEffect
            ? "包含多种副作用"
            : "破坏性命令";
  const sub = input.background
    ? `后台执行 · 最长运行 ${
      formatCommandDuration(resolveCommandTimeout(input, { background: true }).effectiveMs)
    } · ${riskSub}`
    : riskSub;
  const primaryLabel = kind === "install"
    ? "确认安装"
    : kind === "send"
      ? verdict.title.includes("发布") || verdict.title.includes("推送") ? "确认发布" : "确认发送"
      : "确认执行";
  const modelReason = input.reason
    ? redactSensitiveText(input.reason)
      .replace(/<[^>]*>/g, " ")
      .replace(/[<>\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_EXECUTE_COMMAND_REASON_LENGTH)
    : "";
  const installImpact = "会从网上下载并安装到这台电脑";
  const explanationParts = modelReason
    ? kind === "install"
      ? [modelReason, mentionsInstallAction(modelReason) ? undefined : installImpact]
      : [modelReason, verdict.detail]
    : kind === "install"
      ? [verdict.detail]
      : [policyReason, verdict.detail];
  const explanation = joinExplanationParts(explanationParts);
  const rememberCategory = kind === "install" || kind === "command" || kind === "send"
    ? {
        kind,
        label: kind === "install"
          ? "以后安装时不再询问"
          : kind === "send"
            ? "以后向外发送时不再询问"
            : "以后遇到同类操作不再询问",
        ...(insecureRememberEnvironmentAllowed()
          ? { insecureWithoutDesktop: true }
          : {}),
      }
    : undefined;
  // 「以后不用再问我」:确认卡上唯一的减少打扰出口。勾选并批准后全局永久生效——
  // 之后所有命令不再询问、直接执行。默认(不勾)一律照旧弹卡,这是产品可信度的一部分。
  // 副说明必须把后果和改回路径一句话讲清,不得出现任何内部机制词。
  const bypassOption = {
    label: "以后不用再问我",
    hint: "以后的命令会直接执行；可以在 设置 → 安全 里改回。",
  };
  return confirmSpecSchema.parse({
    id,
    kind,
    title: input.background && verdict.risk === "safe"
      ? "启动后台命令"
      : verdict.title.replace(/^需要执行：/, ""),
    ...(sub ? { sub } : {}),
    say: explanation,
    commandPreview: preview || "（无可显示内容）",
    ...(rememberCategory ? { rememberCategory } : {}),
    bypassOption,
    primaryLabel,
    secondaryLabel: "取消",
  });
}

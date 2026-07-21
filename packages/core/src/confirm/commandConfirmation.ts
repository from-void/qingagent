import type { ConfirmSpec } from "@qingagent/contract-ts";
import { confirmSpecSchema } from "@qingagent/contract-ts/schemas";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { redactSensitiveText } from "../agent-run/redaction.js";
import { assessCommand } from "../workspace/commandRisk.js";
import {
  effectiveBackgroundTimeoutMs,
  formatCommandDuration,
} from "../workspace/backgroundCommandLimits.js";
import {
  isEnvEnabled,
  sessionWorkspaceDir,
} from "../workspace/sessionWorkspace.js";

const secondsSchema = z.preprocess(
  (value) => {
    if (value === null || value === undefined || value === "") return undefined;
    return typeof value === "string" ? Number(value) : value;
  },
  z.number().positive().optional(),
);

export const MAX_EXECUTE_COMMAND_LENGTH = 8_192;

export function insecureRememberEnvironmentAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.QINGAGENT_DESKTOP_PACKAGED !== "1"
    && isEnvEnabled(env.QINGAGENT_DEV_ALLOW_INSECURE_REMEMBER);
}

export const executeCommandInputSchema = z.object({
  command: z.string().min(1).max(MAX_EXECUTE_COMMAND_LENGTH),
  timeout: secondsSchema.nullish(),
  cwd: z.string().max(1_024).nullish(),
  tail: z.number().int().positive().max(100_000).nullish(),
  background: z.boolean().optional(),
}).strict();

export type ExecuteCommandInput = z.infer<typeof executeCommandInputSchema>;

function lexicalExecutionCwd(sessionId: string, cwd?: string | null): string {
  const sessionDir = sessionWorkspaceDir(sessionId);
  return cwd && cwd.length > 0 ? resolve(sessionDir, cwd) : sessionDir;
}

export function commandConfirmationDigest(
  sessionId: string,
  input: ExecuteCommandInput,
): string {
  const stable = JSON.stringify({
    command: input.command,
    timeout: input.timeout ?? null,
    cwd: lexicalExecutionCwd(sessionId, input.cwd),
    tail: input.tail ?? null,
    background: input.background === true,
  });
  return createHash("sha256").update(stable).digest("hex");
}

export function buildCommandConfirmSpec(
  input: ExecuteCommandInput,
  reason: string,
  id: string = randomUUID(),
  platform: NodeJS.Platform = process.platform,
): ConfirmSpec {
  const verdict = assessCommand(input.command);
  const preview = redactSensitiveText(input.command).replace(/\s+/g, " ").trim().slice(0, 320);
  const kind = verdict.confirmKind ?? "command";
  const isMultiEffect = verdict.effects.length > 1;
  const riskSub = verdict.risk === "safe"
    ? "资源受限后台命令"
    : kind === "install"
      ? "将修改运行环境"
      : kind === "send"
        ? "将向外部发送或写入数据"
        : isMultiEffect
          ? "包含多种副作用"
          : "破坏性命令";
  const sub = input.background
    ? `后台执行 · 最长运行 ${formatCommandDuration(effectiveBackgroundTimeoutMs(input.timeout))} · ${riskSub}`
    : riskSub;
  const primaryLabel = kind === "install"
    ? "确认安装"
    : kind === "send"
      ? verdict.title.includes("发布") || verdict.title.includes("推送") ? "确认发布" : "确认发送"
      : "确认执行";
  const explanation = [reason, verdict.detail]
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index)
    .join("。");
  const rememberCategory = kind === "install" || kind === "command"
    ? {
        kind,
        label: kind === "install"
          ? "后续的安装指令都默认同意"
          : "后续此类命令都默认同意",
        ...(platform === "win32" && kind === "install"
          ? { riskHint: "默认同意后，后续安装可能修改这台电脑的运行环境。" }
          : {}),
        ...(insecureRememberEnvironmentAllowed()
          ? { insecureWithoutDesktop: true }
          : {}),
      }
    : undefined;
  return confirmSpecSchema.parse({
    id,
    kind,
    title: input.background && verdict.risk === "safe"
      ? "启动后台命令"
      : verdict.title.replace(/^需要执行：/, ""),
    sub,
    say: explanation,
    commandPreview: preview || "（无可显示内容）",
    ...(rememberCategory ? { rememberCategory } : {}),
    footHint: "本次确认只对这次操作有效 · 10 分钟内未处理会自动关闭",
    primaryLabel,
    secondaryLabel: "取消",
  });
}

import type { ConfirmSpec } from "@qingagent/contract-ts";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { z } from "zod";
import { checkCredentialPath } from "../skills/credentialPaths.js";

/**
 * 按需授权兜底通道:任意命令行工具(不论有没有技能声明)因凭证路径读/写被拒时,
 * 模型可以就地申请放行。校验、存储与生效管线与技能声明通道完全同一套——
 * 授权按「规范化路径」记,不绑技能。
 */
export const REQUEST_CREDENTIAL_ACCESS_TOOL = "request_credential_access";

export const MAX_CREDENTIAL_REASON_LENGTH = 80;

export const requestCredentialAccessInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(512)
    .describe("要共享的位置,必须写成 ~/ 开头的用户目录路径,如 ~/.yuque"),
  reason: z
    .string()
    .min(1)
    .max(MAX_CREDENTIAL_REASON_LENGTH)
    .describe("一句话说明哪个命令行工具、为什么需要,会原样念给用户听"),
}).strict();

export type RequestCredentialAccessInput = z.infer<typeof requestCredentialAccessInputSchema>;

export function effectiveCredentialHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME?.trim() || homedir();
}

/** 与命令确认同构的摘要:确认卡与真正落授权的那次调用必须是同一份参数。 */
export function credentialAccessDigest(
  sessionId: string,
  input: RequestCredentialAccessInput,
): string {
  return createHash("sha256")
    .update(JSON.stringify([sessionId, input.path.trim(), input.reason.trim()]))
    .digest("hex");
}

export type CredentialAccessCheck =
  | {
      ok: true;
      /** 规范化后的绝对路径。 */
      path: string;
      /** 用户看到的写法,始终是 ~/ 形态。 */
      declared: string;
      reason: string;
    }
  | { ok: false; message: string };

export function checkRequestedCredentialAccess(
  input: RequestCredentialAccessInput,
  home: string,
): CredentialAccessCheck {
  const checked = checkCredentialPath(input.path, home);
  if (!checked.ok) return { ok: false, message: checked.reason };
  const declared = checked.value.declared.startsWith("~/")
    ? checked.value.declared
    : checked.value.path.replace(home, "~");
  return { ok: true, path: checked.value.path, declared, reason: input.reason.trim() };
}

/**
 * 确认卡文案。说人话:哪个工具、为什么、在哪收回;不出现内部机制词,也不用红色报错。
 */
export function buildCredentialAccessConfirmSpec(
  input: { declared: string; reason: string },
  confirmId: string,
): ConfirmSpec {
  return {
    id: confirmId,
    kind: "connect",
    title: "共享已登录的账号",
    sub: input.declared,
    say:
      `命令行工具需要访问 ${input.declared} 来共享你已有的登录，允许吗？` +
      `${input.reason}`,
    rememberCategory: {
      kind: "connect",
      label: "连接账号",
    },
    footHint: "只涉及这个位置 · 在 设置 → 安全 里随时收回",
    primaryLabel: "允许共享",
    secondaryLabel: "暂不共享",
  };
}

import type { ConfirmSpec } from "@qingagent/contract-ts";
import { confirmSpecSchema } from "@qingagent/contract-ts/schemas";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { redactSensitiveText } from "../agent-run/redaction.js";
import { assessCommand } from "../workspace/commandRisk.js";
import { sessionWorkspaceDir } from "../workspace/sessionWorkspace.js";

const secondsSchema = z.preprocess(
  (value) => {
    if (value === null || value === undefined || value === "") return undefined;
    return typeof value === "string" ? Number(value) : value;
  },
  z.number().positive().optional(),
);

export const MAX_EXECUTE_COMMAND_LENGTH = 8_192;

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
): ConfirmSpec {
  const verdict = assessCommand(input.command);
  const preview = redactSensitiveText(input.command).replace(/\s+/g, " ").trim().slice(0, 320);
  return confirmSpecSchema.parse({
    id,
    kind: "command",
    title: verdict.title.replace(/^需要执行：/, ""),
    sub: input.background ? "后台命令" : "命令执行",
    say: `${reason}。命令预览：${preview || "（无可显示内容）"}`,
    footHint: "只授权本次调用 · 10 分钟后自动失效",
    primaryLabel: "确认执行",
    secondaryLabel: "取消",
  });
}

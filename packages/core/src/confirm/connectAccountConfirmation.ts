import type { ConfirmSpec } from "@qingagent/contract-ts";
import { confirmSpecSchema } from "@qingagent/contract-ts/schemas";
import { createHash } from "node:crypto";
import { z } from "zod";

export const GITHUB_AUTH_START_TOOL = "github_auth_start";
export const FEISHU_AUTH_START_TOOL = "feishu_auth_start";
export const WECHAT_AUTH_START_TOOL = "wechat_auth_start";

export const CONNECT_ACCOUNT_AUTH_TOOLS = [
  GITHUB_AUTH_START_TOOL,
  FEISHU_AUTH_START_TOOL,
  WECHAT_AUTH_START_TOOL,
] as const;

export type ConnectAccountAuthToolName =
  typeof CONNECT_ACCOUNT_AUTH_TOOLS[number];

const connectAccountAuthToolNames = new Set<string>(
  CONNECT_ACCOUNT_AUTH_TOOLS,
);

export const githubAuthStartInputSchema = z.object({
  scope: z.enum(["public_repo", "repo"]).default("repo"),
}).strict();

export const feishuAuthDomainSchema = z.enum([
  "docs", "base", "sheets", "calendar", "im", "drive", "mail", "task",
  "approval", "contact", "minutes", "wiki",
]);

export const feishuAuthStartInputSchema = z.object({
  domains: z.array(feishuAuthDomainSchema).min(1).max(12),
}).strict();

export const wechatAuthStartInputSchema = z.object({}).strict();

type ConnectAccountAuthInput =
  | {
      toolName: typeof GITHUB_AUTH_START_TOOL;
      args: z.infer<typeof githubAuthStartInputSchema>;
    }
  | {
      toolName: typeof FEISHU_AUTH_START_TOOL;
      args: z.infer<typeof feishuAuthStartInputSchema>;
    }
  | {
      toolName: typeof WECHAT_AUTH_START_TOOL;
      args: z.infer<typeof wechatAuthStartInputSchema>;
    };

export function isConnectAccountAuthTool(
  toolName: string,
): toolName is ConnectAccountAuthToolName {
  return connectAccountAuthToolNames.has(toolName);
}

export function parseConnectAccountAuthInput(
  toolName: string,
  args: unknown,
): ConnectAccountAuthInput | null {
  if (toolName === GITHUB_AUTH_START_TOOL) {
    const parsed = githubAuthStartInputSchema.safeParse(args);
    return parsed.success ? { toolName, args: parsed.data } : null;
  }
  if (toolName === FEISHU_AUTH_START_TOOL) {
    const parsed = feishuAuthStartInputSchema.safeParse(args);
    return parsed.success ? { toolName, args: parsed.data } : null;
  }
  if (toolName === WECHAT_AUTH_START_TOOL) {
    const parsed = wechatAuthStartInputSchema.safeParse(args);
    return parsed.success ? { toolName, args: parsed.data } : null;
  }
  return null;
}

function exactToolCall(input: ConnectAccountAuthInput): string {
  return `${input.toolName}(${JSON.stringify(input.args)})`;
}

export function connectAccountConfirmationDigest(
  sessionId: string,
  input: ConnectAccountAuthInput,
): string {
  return createHash("sha256")
    .update(JSON.stringify([sessionId, input.toolName, input.args]))
    .digest("hex");
}

export function buildConnectAccountConfirmSpec(
  input: ConnectAccountAuthInput,
  confirmId: string,
): ConfirmSpec {
  const copy = input.toolName === GITHUB_AUTH_START_TOOL
    ? {
        title: "连接 GitHub",
        say: "连接你的 GitHub 账号后，青简可以搜索并读取你名下和有权访问的仓库。",
        primaryLabel: "连接",
      }
    : input.toolName === FEISHU_AUTH_START_TOOL
      ? {
          title: "扫码授权飞书",
          say: "完成授权后，青简可以以你的身份读写飞书里的文档、多维表格、电子表格、日历等内容。",
          primaryLabel: "扫码授权",
        }
      : {
          title: "扫码登录微信公众平台",
          say: "登录后，青简可以按公众号名称搜索文章、抓取正文全文做写作素材。",
          primaryLabel: "扫码登录",
        };

  return confirmSpecSchema.parse({
    id: confirmId,
    kind: "connect",
    title: copy.title,
    sub: "连接账号",
    say: copy.say,
    commandPreview: exactToolCall(input),
    rememberCategory: {
      kind: "connect",
      label: "连接账号",
    },
    primaryLabel: copy.primaryLabel,
    secondaryLabel: "取消",
  });
}

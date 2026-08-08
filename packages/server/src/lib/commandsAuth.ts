import type { MiddlewareHandler } from "hono";
import { extractAuthToken, tokensMatch } from "./authToken";
import { getExternalToken } from "./externalInstance";

const COMMAND_MUTATION_PATHS = new Set(["/api/v1/commands"]);

export function isCommandMutationPath(pathname: string): boolean {
  return COMMAND_MUTATION_PATHS.has(pathname);
}

/**
 * commands 使用一个确定性共享密钥：部署方显式配置的全局 token 优先；桌面零配置形态
 * 则复用当前 instance token。后者只存在于主进程/server 内存和 0600 instance.json，
 * renderer 由 Electron 主进程代理补头，不直接读取秘密。
 */
export function getCommandsAuthToken(): string | null {
  const configured = process.env.QINGAGENT_AUTH_TOKEN;
  if (configured) return configured;
  // instance token 只为同进程 Electron 主进程代理提供桌面零配置能力。
  // server/Web-only 必须显式配置全局 token；qa-cli 继续只走受约束的 external API。
  return process.env.QINGAGENT_RUNTIME === "desktop" ? getExternalToken() : null;
}

export const commandsTokenMiddleware: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const expected = getCommandsAuthToken();
  const provided = extractAuthToken(c);
  if (expected && provided && tokensMatch(provided, expected)) return next();
  return c.json({ error: "unauthorized" }, 401);
};

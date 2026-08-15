import type { MiddlewareHandler } from "hono";
import { getRequestPrincipal } from "./principal";
import { getDesktopGlobalToken } from "./authCredentials";

const COMMAND_MUTATION_PATHS = new Set(["/api/v1/commands"]);

export function isCommandMutationPath(pathname: string): boolean {
  return COMMAND_MUTATION_PATHS.has(pathname);
}

/**
 * commands 使用 global principal：部署方显式配置的全局 token 优先；桌面零配置形态
 * 使用仅存在于主进程/server 内存的临时 global token。instance token 不再越权到 UI route。
 */
export function getCommandsAuthToken(): string | null {
  const configured = process.env.QINGAGENT_AUTH_TOKEN;
  if (configured) return configured;
  // desktop 临时 token 不落盘；server/Web-only 必须显式配置全局 token，
  // qa-cli 继续只走受约束的 external API。
  return process.env.QINGAGENT_RUNTIME === "desktop" ? getDesktopGlobalToken() : null;
}

export const commandsTokenMiddleware: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const principal = getRequestPrincipal(c);
  if (principal.kind === "global" || principal.kind === "attachSession") return next();
  return c.json({ error: "unauthorized" }, 401);
};

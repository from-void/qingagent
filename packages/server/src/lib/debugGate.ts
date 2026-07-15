// 是否对外暴露 + debug/dataAdmin 分层开放判定。单一真源,供路由门与启动警告共用。
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

type SecurityEnv = Readonly<Record<string, string | undefined>>;

export type BindSafetyAssessment =
  | { allowed: true; auditWarning?: string }
  | { allowed: false; error: string };

export function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeHost(host));
}

/**
 * 绑定层 fail-closed：只信任实际传给 serve() 的 host，不从 PUBLIC/HOST 环境变量反推。
 * desktop 固定传 127.0.0.1，因此不会被用户遗留的 QINGAGENT_HOST 误伤。
 */
export function assessBindSafety(
  host: string,
  env: SecurityEnv = process.env,
): BindSafetyAssessment {
  if (isLoopbackHost(host) || Boolean(env.QINGAGENT_AUTH_TOKEN?.trim())) {
    return { allowed: true };
  }

  if (env.QINGAGENT_ALLOW_UNAUTHENTICATED_PUBLIC === "1") {
    return {
      allowed: true,
      auditWarning:
        "[security] 审计告警：已显式允许无鉴权公开监听；任何人可读写文档并消耗模型 key。",
    };
  }

  return {
    allowed: false,
    error:
      `[security] 拒绝在 ${host} 上公开监听：未设置 QINGAGENT_AUTH_TOKEN。` +
      "无鉴权公开监听会让任何可达者读写文档并消耗模型 key。" +
      "请设置强随机 token，或仅在明确接受风险时设置 QINGAGENT_ALLOW_UNAUTHENTICATED_PUBLIC=1。",
  };
}

// 有效监听地址:与 index.ts 的 serve hostname 同口径。
export function effectiveHost(): string {
  return process.env.QINGAGENT_HOST ?? "127.0.0.1";
}

// "是否对外暴露":显式声明公网 或 有效监听地址非回环。服务端无法自证是否公网,故默认从安全侧。
export function isExternallyExposed(): boolean {
  if (process.env.QINGAGENT_PUBLIC_DEPLOYMENT === "1") return true;
  return !isLoopbackHost(effectiveHost());
}

// debug/dataAdmin 是否开放:必须显式 QINGAGENT_ENABLE_DEBUG=1;
// 且(非对外暴露 → 回环形态直接开;对外暴露 → 必须已设 QINGAGENT_AUTH_TOKEN 才开,否则关)。
export function isDebugEndpointEnabled(): boolean {
  if (process.env.QINGAGENT_ENABLE_DEBUG !== "1") return false;
  if (!isExternallyExposed()) return true;
  return Boolean(process.env.QINGAGENT_AUTH_TOKEN);
}

// 启动安全自检警告(index.ts 启动时调用):对外暴露且缺 token 时醒目提醒。
export function logStartupSecurityWarnings(
  options: { suppressUnauthenticatedWarning?: boolean } = {},
): void {
  if (!isExternallyExposed()) return;
  if (!process.env.QINGAGENT_AUTH_TOKEN && !options.suppressUnauthenticatedWarning) {
    console.warn(
      "[security] 检测到对外暴露(非回环监听或 QINGAGENT_PUBLIC_DEPLOYMENT=1)但未设 QINGAGENT_AUTH_TOKEN:" +
        "API 无鉴权,任何人可读写你的全部文档并消耗模型 key。强烈建议设置强随机 QINGAGENT_AUTH_TOKEN。",
    );
  }
  if (process.env.QINGAGENT_ENABLE_DEBUG === "1" && !process.env.QINGAGENT_AUTH_TOKEN) {
    console.warn(
      "[security] QINGAGENT_ENABLE_DEBUG=1 在对外暴露且无 QINGAGENT_AUTH_TOKEN 的形态下被忽略:" +
        "debug/dataAdmin 路由将返回 404。设置 QINGAGENT_AUTH_TOKEN 后方可开放。",
    );
  }
}

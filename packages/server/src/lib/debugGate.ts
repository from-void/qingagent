// 是否对外暴露 + debug/dataAdmin 分层开放判定。单一真源,供路由门与启动警告共用。
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

// 有效监听地址:与 index.ts 的 serve hostname 同口径。
export function effectiveHost(): string {
  return process.env.QINGAGENT_HOST ?? "127.0.0.1";
}

// "是否对外暴露":显式声明公网 或 有效监听地址非回环。服务端无法自证是否公网,故默认从安全侧。
export function isExternallyExposed(): boolean {
  if (process.env.QINGAGENT_PUBLIC_DEPLOYMENT === "1") return true;
  return !LOOPBACK_HOSTS.has(effectiveHost());
}

// debug/dataAdmin 是否开放:必须显式 QINGAGENT_ENABLE_DEBUG=1;
// 且(非对外暴露 → 回环形态直接开;对外暴露 → 必须已设 QINGAGENT_AUTH_TOKEN 才开,否则关)。
export function isDebugEndpointEnabled(): boolean {
  if (process.env.QINGAGENT_ENABLE_DEBUG !== "1") return false;
  if (!isExternallyExposed()) return true;
  return Boolean(process.env.QINGAGENT_AUTH_TOKEN);
}

// 启动安全自检警告(index.ts 启动时调用):对外暴露且缺 token 时醒目提醒。
export function logStartupSecurityWarnings(): void {
  if (!isExternallyExposed()) return;
  if (!process.env.QINGAGENT_AUTH_TOKEN) {
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

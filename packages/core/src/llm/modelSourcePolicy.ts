/**
 * 打包桌面端的模型身份与凭据只允许来自本次请求的 visitor/custom 配置。
 * Web、自部署与 desktop dev 保留 visitor > global-db > env 的既有优先级。
 *
 * 该入口必须保持无副作用、无 Mastra/DB 依赖，供 core 与 server 在模块求值期安全复用。
 */
export function allowGlobalModelFallback(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !(
    env.QINGAGENT_RUNTIME === "desktop" &&
    env.QINGAGENT_DESKTOP_PACKAGED === "1"
  );
}

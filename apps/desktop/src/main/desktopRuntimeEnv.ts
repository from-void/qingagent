export interface DesktopRuntimeEnv {
  [key: string]: string | undefined;
  QINGAGENT_RUNTIME?: string;
  QINGAGENT_DESKTOP_PACKAGED?: string;
  QINGAGENT_DEV_ALLOW_INSECURE_REMEMBER?: string;
  QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES?: string;
  QINGAGENT_ALLOW_SKILL_MUTATION?: string;
  QINGAGENT_ALLOW_TEMPLATE_MUTATION?: string;
  QINGAGENT_CONNECTORS_ENABLED?: string;
  QINGAGENT_ALLOW_PRIVATE_MODEL_HOST?: string;
}

export function configureDesktopRuntimeEnv(
  env: DesktopRuntimeEnv = process.env,
  options: { isPackaged?: boolean } = {},
): void {
  env.QINGAGENT_RUNTIME = "desktop";
  if (options.isPackaged === true) {
    delete env.QINGAGENT_DEV_ALLOW_INSECURE_REMEMBER;
    env.QINGAGENT_DESKTOP_PACKAGED = "1";
  } else {
    delete env.QINGAGENT_DESKTOP_PACKAGED;
  }
  env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
  env.QINGAGENT_ALLOW_SKILL_MUTATION = "1";
  env.QINGAGENT_ALLOW_TEMPLATE_MUTATION = "1";
  env.QINGAGENT_CONNECTORS_ENABLED ??= "1";
  // 桌面端默认放行"模型地址解析到内网"这一场景:客户端跑在用户自己的机器上,自定义模型地址
  // 只可能来自用户在设置页亲手填写(trusted origin + 访客 key 双重门控),公司自建/内网模型网关
  // (如 http://10.0.0.8:8000/v1 或解析到内网的域名)是合法主场景,与既有 loopback 放行
  // (Ollama / LM Studio)同理——都是"用户指着自己机器所在网络里的一台服务器"。
  // 作用面严格限于主模型出站:allowsPrivateModelHost 只被 packages/core/src/llm/modelFetchUrl.ts
  // 消费(经 validateModelFetchUrl / assertModelFetchAddressAllowed / modelTransport),网页抓取、
  // 文档抓取等通用 fetch 的 SSRF 防线不读它,因此不受影响;Web / 自部署形态不注入本默认值,
  // 维持严格拒绝。用户显式设 0(系统环境变量或 userData/.env)即可关掉。
  env.QINGAGENT_ALLOW_PRIVATE_MODEL_HOST ??= "1";
}

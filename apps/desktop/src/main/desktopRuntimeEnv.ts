export interface DesktopRuntimeEnv {
  [key: string]: string | undefined;
  QINGAGENT_RUNTIME?: string;
  QINGAGENT_DESKTOP_PACKAGED?: string;
  QINGAGENT_DEV_ALLOW_INSECURE_REMEMBER?: string;
  QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES?: string;
  QINGAGENT_ALLOW_SKILL_MUTATION?: string;
  QINGAGENT_ALLOW_TEMPLATE_MUTATION?: string;
  QINGAGENT_CONNECTORS_ENABLED?: string;
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
}

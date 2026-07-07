export interface DesktopRuntimeEnv {
  [key: string]: string | undefined;
  QINGAGENT_RUNTIME?: string;
  QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES?: string;
  QINGAGENT_ALLOW_SKILL_MUTATION?: string;
}

export function configureDesktopRuntimeEnv(env: DesktopRuntimeEnv = process.env): void {
  env.QINGAGENT_RUNTIME = "desktop";
  env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
  env.QINGAGENT_ALLOW_SKILL_MUTATION = "1";
}

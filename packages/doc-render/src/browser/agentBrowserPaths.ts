import { homedir } from "node:os";
import { join } from "node:path";

type BrowserPathEnv = {
  QINGAGENT_BROWSER_STORAGE_STATE?: string;
  QINGAGENT_BROWSER_PROFILE_DIR?: string;
};

type BrowserPathOptions = {
  env?: BrowserPathEnv;
  homeDirectory?: string;
};

const STORAGE_STATE_FILE = ".qingagent-browser-state.json";
const PROFILE_DIRECTORY = ".qingagent-browser-profile";

function defaultBrowserDataDirectory(homeDirectory: string): string {
  return join(homeDirectory, ".qingagent");
}

/**
 * storageState 显式配置优先；非 Electron 形态默认落用户级数据目录，绝不依赖 cwd。
 * Electron 主进程会在加载 server/core 前把显式变量注入 app.getPath("userData")。
 */
export function resolveAgentBrowserStorageStatePath(
  options: BrowserPathOptions & { enabled: boolean },
): string | undefined {
  const env = options.env ?? process.env;
  const explicit = env.QINGAGENT_BROWSER_STORAGE_STATE?.trim();
  if (explicit) return explicit;
  if (!options.enabled) return undefined;
  return join(
    defaultBrowserDataDirectory(options.homeDirectory ?? homedir()),
    STORAGE_STATE_FILE,
  );
}

/** 代理 Chromium 的完整 profile 与 storageState 使用同一用户级数据根。 */
export function resolveAgentBrowserProfileDir(
  options: BrowserPathOptions = {},
): string {
  const env = options.env ?? process.env;
  const explicit = env.QINGAGENT_BROWSER_PROFILE_DIR?.trim();
  if (explicit) return explicit;
  return join(
    defaultBrowserDataDirectory(options.homeDirectory ?? homedir()),
    PROFILE_DIRECTORY,
  );
}

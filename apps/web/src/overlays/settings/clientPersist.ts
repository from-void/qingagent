// 客户端凭证/模型配置的持久化后端抽象。
//
// 背景(打包后 key 丢失的根因):桌面打包版内置服务用随机端口起、窗口加载
// http://localhost:<随机端口>,而 localStorage 按 origin(含端口)隔离 → 每次启动
// 都是新 origin、读不到上次存的 key。dev 固定端口故不丢。
//
// 解法:桌面端把这些配置存到 userData/client-config.json(主进程持有、IPC 暴露具名单项 API,
// 与端口/origin 解耦,换版升级也不丢);web 端行为不变,仍用 localStorage。
//
// 同步语义:渲染层在构造请求 header 时同步读取 key(visitorKeyHeaders()),不能改异步。
// preload 的具名 getter 内部按需 sendSync 单项值；这里首次读取后建内存镜像。写入时先同步
// 更新镜像,再异步落盘(IPC),保证后续同步读到最新值，又不在 window 上暴露整份解密配置。

type ConfigMap = Record<string, string>;
type DesktopConfigAccessor = {
  get: () => string | null;
  set: (value: string | null) => Promise<boolean>;
};
export type PersistedReadResult =
  | { ok: true; value: string | null }
  | { ok: false; value: null };
export const CLIENT_PERSIST_CHANGED_EVENT = "qingagent:client-persist-changed";

const cache: ConfigMap = {};
const loadedKeys = new Set<string>();
const writeRevisions = new Map<string, number>();

function updateCacheValue(target: ConfigMap, key: string, value: string | null): void {
  if (value) target[key] = value;
  else delete target[key];
}

function nextWriteRevision(key: string): number {
  const revision = (writeRevisions.get(key) ?? 0) + 1;
  writeRevisions.set(key, revision);
  return revision;
}

function desktopConfigAccessor(key: string): DesktopConfigAccessor | null {
  if (typeof window === "undefined" || window.electron?.isDesktop !== true) return null;
  const bridge = window.electron;
  switch (key) {
    case "qingagent.deepseek_api_key":
      return bridge.getDeepseekApiKey && bridge.setDeepseekApiKey
        ? { get: bridge.getDeepseekApiKey, set: bridge.setDeepseekApiKey }
        : null;
    case "qingagent.custom_provider":
      return bridge.getCustomProvider && bridge.setCustomProvider
        ? { get: bridge.getCustomProvider, set: bridge.setCustomProvider }
        : null;
    case "qingagent.vision_provider":
      return bridge.getVisionProvider && bridge.setVisionProvider
        ? { get: bridge.getVisionProvider, set: bridge.setVisionProvider }
        : null;
    case "qingagent.official_model":
      return bridge.getOfficialModel && bridge.setOfficialModel
        ? { get: bridge.getOfficialModel, set: bridge.setOfficialModel }
        : null;
    case "qingagent.model_tier":
      return bridge.getModelTier && bridge.setModelTier
        ? { get: bridge.getModelTier, set: bridge.setModelTier }
        : null;
    case "qingagent.kimi_model_tier":
      return bridge.getKimiModelTier && bridge.setKimiModelTier
        ? { get: bridge.getKimiModelTier, set: bridge.setKimiModelTier }
        : null;
    // 新增桌面配置键时需同步 preload/index.ts 与 desktop main 的两组白名单。
    case "qingagent.kimi_api_key":
      return bridge.getKimiApiKey && bridge.setKimiApiKey
        ? { get: bridge.getKimiApiKey, set: bridge.setKimiApiKey }
        : null;
    case "qingagent.kimi_custom_provider":
      return bridge.getKimiCustomProvider && bridge.setKimiCustomProvider
        ? { get: bridge.getKimiCustomProvider, set: bridge.setKimiCustomProvider }
        : null;
    case "qingagent.kimi_official_model":
      return bridge.getKimiOfficialModel && bridge.setKimiOfficialModel
        ? { get: bridge.getKimiOfficialModel, set: bridge.setKimiOfficialModel }
        : null;
    case "qingagent.model_provider":
      return bridge.getModelProvider && bridge.setModelProvider
        ? { get: bridge.getModelProvider, set: bridge.setModelProvider }
        : null;
    default:
      return null;
  }
}

function isDesktopWindow(): boolean {
  return typeof window !== "undefined" && window.electron?.isDesktop === true;
}

function isDesktopConfigReady(): boolean {
  if (!isDesktopWindow()) return false;
  const ready = window.electron?.isClientConfigReady;
  if (!ready) return true;
  try {
    return ready();
  } catch {
    return false;
  }
}

function emitPersistedChange(key: string): void {
  window.dispatchEvent(new CustomEvent(CLIENT_PERSIST_CHANGED_EVENT, {
    detail: { key },
  }));
}

function readDesktopCached(key: string, accessor: DesktopConfigAccessor): PersistedReadResult {
  if (!loadedKeys.has(key)) {
    try {
      const initial = accessor.get();
      updateCacheValue(cache, key, initial);
      loadedKeys.add(key);
    } catch {
      // preload 同步 getter 也可能因 IPC/主进程异常失败；不把失败误记为“已加载的空值”。
      return { ok: false, value: null };
    }
  }
  const value = cache[key];
  return { ok: true, value: value && value.length > 0 ? value : null };
}

/** 当前是否走 userData 持久化(桌面端)。web 端为 false,走 localStorage。 */
export function isDesktopPersist(): boolean {
  return isDesktopWindow();
}

/** 读取一个持久化字符串;缺失/空串都返回 null。 */
export function readPersistedChecked(key: string): PersistedReadResult {
  if (isDesktopWindow() && !isDesktopConfigReady()) {
    return { ok: false, value: null };
  }
  const accessor = desktopConfigAccessor(key);
  if (accessor) return readDesktopCached(key, accessor);
  // 已明确是 desktop 时，具名 accessor 暂缺代表桥尚不可读；绝不回退随机 origin 的 localStorage。
  if (isDesktopWindow()) return { ok: false, value: null };
  try {
    return { ok: true, value: window.localStorage.getItem(key) };
  } catch {
    return { ok: false, value: null };
  }
}

/** 宽松读取路径：持久层不可读时按缺失处理，且绝不让底层异常逸出。 */
export function readPersisted(key: string): string | null {
  return readPersistedChecked(key).value;
}

/**
 * 可等待的写入路径，供客户端模型配置统一使用。
 * 桌面端仍会先同步更新镜像；IPC 失败时恢复写入前的值，避免形成“本次能用、重启丢失”的假象。
 */
export async function writePersistedAwaited(key: string, value: string | null): Promise<boolean> {
  if (isDesktopWindow() && !isDesktopConfigReady()) return false;
  const accessor = desktopConfigAccessor(key);
  if (!accessor) {
    if (isDesktopWindow()) return false;
    try {
      if (value) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
      emitPersistedChange(key);
      return true;
    } catch {
      return false;
    }
  }

  const current = readDesktopCached(key, accessor);
  if (!current.ok) return false;
  const hadPrevious = Object.prototype.hasOwnProperty.call(cache, key);
  const previous = cache[key];
  updateCacheValue(cache, key, value);
  loadedKeys.add(key);
  const revision = nextWriteRevision(key);

  try {
    const ok = await accessor.set(value);
    if (ok) {
      emitPersistedChange(key);
      return true;
    }
  } catch {
    // 统一按落盘失败处理，并在下方回滚镜像。
  }

  // 只回滚当前这次写入；若同一 key 已有更新请求，不能用旧值覆盖它。
  if (writeRevisions.get(key) === revision) {
    if (hadPrevious && previous !== undefined) cache[key] = previous;
    else delete cache[key];
  }
  return false;
}

/** 仅供测试:重置内存镜像,使下次读取重新探测 window.electron。 */
export function __resetClientPersistCacheForTests(): void {
  for (const key of Object.keys(cache)) delete cache[key];
  loadedKeys.clear();
  writeRevisions.clear();
}

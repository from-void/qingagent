// 客户端凭证/模型配置的持久化后端抽象。
//
// 背景(打包后 key 丢失的根因):桌面打包版内置服务用随机端口起、窗口加载
// http://localhost:<随机端口>,而 localStorage 按 origin(含端口)隔离 → 每次启动
// 都是新 origin、读不到上次存的 key。dev 固定端口故不丢。
//
// 解法:桌面端把这些配置存到 userData/client-config.json(主进程持有、IPC 暴露,
// 与端口/origin 解耦,换版升级也不丢);web 端行为不变,仍用 localStorage。
//
// 同步语义:渲染层在构造请求 header 时同步读取 key(visitorKeyHeaders()),不能改异步。
// 故桌面端在 preload 阶段用 sendSync 把配置快照注入 window.electron.clientConfig,
// 这里以它为初值建内存镜像;写入时同步更新镜像 + 异步落盘(IPC),保证后续同步读到最新值。

type ConfigMap = Record<string, string>;

// 内存镜像:桌面端首次访问时以 preload 注入的快照为初值;web 端恒为 null(走 localStorage)。
let cache: ConfigMap | null = null;
let resolved = false;

function ensureCache(): ConfigMap | null {
  if (resolved) return cache;
  resolved = true;
  if (typeof window === "undefined") return (cache = null);
  const injected = window.electron?.clientConfig;
  cache = injected ? { ...injected } : null;
  return cache;
}

/** 当前是否走 userData 持久化(桌面端)。web 端为 false,走 localStorage。 */
export function isDesktopPersist(): boolean {
  return ensureCache() !== null;
}

/** 读取一个持久化字符串;缺失/空串都返回 null。 */
export function readPersisted(key: string): string | null {
  const c = ensureCache();
  if (c) {
    const v = c[key];
    return v && v.length ? v : null;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 写入(value=null 表示删除)。桌面端同步更新内存镜像 + 异步落盘 userData。 */
export function writePersisted(key: string, value: string | null): void {
  const c = ensureCache();
  if (c) {
    if (value) c[key] = value;
    else delete c[key];
    // 落盘失败不影响本次会话内存值(下次启动可能丢,但属罕见 IO 异常)。
    void window.electron?.setClientConfig?.({ [key]: value });
    return;
  }
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // localStorage 不可用(隐私模式等)时静默。
  }
}

/** 仅供测试:重置内存镜像,使下次读取重新探测 window.electron。 */
export function __resetClientPersistCacheForTests(): void {
  cache = null;
  resolved = false;
}

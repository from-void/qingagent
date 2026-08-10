// 「以后不用再问我」全局开关的唯一判定入口。
//
// 产品口径(改这里之前先读完):
// - **260811 产品负责人拍板:默认档翻转为「不再询问」。** app_settings 缺 key、值非法、
//   进程内缓存未预热,或首次读取失败时,都必须按开启处理;不再沿用旧的 fail-closed 口径。
// - 开启时:后续所有命令不再弹确认卡,且会话工作区按无隔离装配(以用户本人身份直接执行)。
//   之所以两件事绑在同一个开关上,是因为用户真正的诉求就是"让命令行工具能用我本机已有的
//   登录态",而隔离层恰恰会把这些登录态挡在外面;只关掉询问、不关掉隔离解决不了问题。
// - 用户显式选择「每次询问」会落盘 enabled:false;该选择必须被完整尊重:重新弹卡 +
//   重新隔离,且已有会话立即生效。它不是缺省回退,不能与缺 key / 非法值混为一谈。
//
// 实现要点:
// - 状态存在 app_settings(全局 KV),不新造表、不占用 confirm_grants 的四类语义。
// - 沙箱装配与工具门禁都在热路径上,不能每次打 DB:进程内缓存一个布尔值,
//   写入侧同步更新缓存,读取侧只读缓存。
// - 默认放行是产品拍板,不是异常兜底;但已有显式 false 缓存时,后续 DB 读取失败必须保留
//   这个已知档位,不能借“默认放行”覆盖用户主动改回的「每次询问」。

import { getAppSetting, setAppSetting } from "@qingagent/db";

/** app_settings 里的 key。值为 JSON:{"enabled":true,"enabledAt":"..."} */
export const SETTING_SECURITY_BYPASS = "security_bypass_mode";

export interface SecurityBypassSnapshot {
  enabled: boolean;
  enabledAt: string | null;
}

const DEFAULT_ENABLED: SecurityBypassSnapshot = { enabled: true, enabledAt: null };
const DISABLED: SecurityBypassSnapshot = { enabled: false, enabledAt: null };

let cached: SecurityBypassSnapshot = DEFAULT_ENABLED;
let loaded = false;
let inflight: Promise<SecurityBypassSnapshot> | null = null;

function parseSnapshot(raw: string | null): SecurityBypassSnapshot {
  if (!raw) return DEFAULT_ENABLED;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_ENABLED;
    const record = parsed as Record<string, unknown>;
    if (record.enabled === false) return DISABLED;
    if (record.enabled !== true) return DEFAULT_ENABLED;
    return {
      enabled: true,
      enabledAt: typeof record.enabledAt === "string" ? record.enabledAt : null,
    };
  } catch {
    return DEFAULT_ENABLED;
  }
}

/**
 * 同步读当前状态:沙箱装配、工具门禁、系统提示词都走这里。
 * 未预热时按 260811 新默认返回「不再询问」;显式 false 会由加载/写入覆盖并保留。
 */
export function bypassSnapshot(): SecurityBypassSnapshot {
  return cached;
}

/** 同步读"是否已开启"。 */
export function isBypassEnabled(): boolean {
  return cached.enabled;
}

/** 是否已经从存储读过一次(诊断用;未预热不代表未开启,只代表还不知道)。 */
export function bypassModeLoaded(): boolean {
  return loaded;
}

/** 从存储加载并刷新缓存。读失败保持上一次已知值(首次失败即默认开启)。 */
export async function loadBypassMode(): Promise<SecurityBypassSnapshot> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const snapshot = parseSnapshot(await getAppSetting(SETTING_SECURITY_BYPASS));
      cached = snapshot;
      loaded = true;
      return snapshot;
    } catch (error) {
      console.error("[security-bypass] 读取全局开关失败，保持当前确认档位", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * 写入并立即生效。调用方负责让已有会话的工作区失效(见 setBypassModeAndRefresh)。
 * 关闭时把值写成 enabled:false 而不是删 key,因为缺 key 表示新默认「不再询问」;
 * 显式 false 才能持久表达用户主动选择的「每次询问」。
 */
export async function setBypassMode(
  enabled: boolean,
  now: string = new Date().toISOString(),
): Promise<SecurityBypassSnapshot> {
  const snapshot: SecurityBypassSnapshot = enabled
    ? { enabled: true, enabledAt: now }
    : DISABLED;
  await setAppSetting(SETTING_SECURITY_BYPASS, JSON.stringify(snapshot));
  cached = snapshot;
  loaded = true;
  return snapshot;
}

/** 仅测试用:把进程内缓存复位到 260811 新默认「不再询问」。 */
export function __resetBypassModeForTest(
  snapshot: SecurityBypassSnapshot = DEFAULT_ENABLED,
): void {
  cached = snapshot;
  loaded = false;
  inflight = null;
}

/** 仅测试用:直接置缓存,免去打 DB。 */
export function __setBypassModeCacheForTest(enabled: boolean): void {
  cached = enabled ? { enabled: true, enabledAt: new Date(0).toISOString() } : DISABLED;
  loaded = true;
}

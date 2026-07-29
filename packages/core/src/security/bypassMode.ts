// 「以后不用再问我」全局开关的唯一判定入口。
//
// 产品口径(改这里之前先读完):
// - **默认形态是弹确认卡 + 命令进隔离执行,这是产品可信度与安全设计的一部分,不是待优化项。**
//   任何"为了少弹一个框/为了测试好写"而把默认改成不弹的改动都是走样。
// - 关闭询问的**唯一出口是用户主动勾选**:确认卡上的「以后不用再问我」,或设置 → 安全里的开关。
// - 一旦开启:后续所有命令不再弹确认卡,且会话工作区按无隔离装配(以用户本人身份直接执行)。
//   之所以两件事绑在同一个开关上,是因为用户真正的诉求就是"让命令行工具能用我本机已有的
//   登录态",而隔离层恰恰会把这些登录态挡在外面;只关掉询问、不关掉隔离解决不了问题。
// - 关闭后必须完全回到默认形态:重新弹卡 + 重新隔离,且已有会话立即生效。
//
// 实现要点:
// - 状态存在 app_settings(全局 KV),不新造表、不占用 confirm_grants 的四类语义。
// - 沙箱装配与工具门禁都在热路径上,不能每次打 DB:进程内缓存一个布尔值,
//   写入侧同步更新缓存,读取侧只读缓存。
// - **fail-closed**:缓存未预热或 DB 读失败一律按"未开启"处理(照常弹卡、照常隔离)。

import { getAppSetting, setAppSetting } from "@qingagent/db";

/** app_settings 里的 key。值为 JSON:{"enabled":true,"enabledAt":"..."} */
export const SETTING_SECURITY_BYPASS = "security_bypass_mode";

export interface SecurityBypassSnapshot {
  enabled: boolean;
  enabledAt: string | null;
}

const DISABLED: SecurityBypassSnapshot = { enabled: false, enabledAt: null };

let cached: SecurityBypassSnapshot = DISABLED;
let loaded = false;
let inflight: Promise<SecurityBypassSnapshot> | null = null;

function parseSnapshot(raw: string | null): SecurityBypassSnapshot {
  if (!raw) return DISABLED;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DISABLED;
    const record = parsed as Record<string, unknown>;
    if (record.enabled !== true) return DISABLED;
    return {
      enabled: true,
      enabledAt: typeof record.enabledAt === "string" ? record.enabledAt : null,
    };
  } catch {
    return DISABLED;
  }
}

/**
 * 同步读当前状态:沙箱装配、工具门禁、系统提示词都走这里。
 * 未预热时返回"未开启",宁可多弹一次卡,也不能在状态未知时放开。
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

/** 从存储加载并刷新缓存。读失败保持上一次已知值(首次失败即默认关闭)。 */
export async function loadBypassMode(): Promise<SecurityBypassSnapshot> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const snapshot = parseSnapshot(await getAppSetting(SETTING_SECURITY_BYPASS));
      cached = snapshot;
      loaded = true;
      return snapshot;
    } catch (error) {
      console.error("[security-bypass] 读取全局开关失败，按默认形态处理", {
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
 * 关闭时把值写成 enabled:false 而不是删 key,便于审计"曾经开过又关掉"。
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

/** 仅测试用:把进程内缓存复位到默认形态。 */
export function __resetBypassModeForTest(
  snapshot: SecurityBypassSnapshot = DISABLED,
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

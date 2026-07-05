import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// 本地用户画像状态(userData 下小 JSON):由服务端钩子在"首次发生"时翻牌,app_opened 启动时
// 快照成画像属性上报。只存布尔里程碑与装机时间,不存任何内容/PII;写盘只发生在牌位翻转时
// (一个用户一生约 4 次写)。所有读写绝不抛错、绝不影响主流程。

export type ProfileState = {
  firstRunAt: string;
  hasKey: boolean;
  hasSentMessage: boolean;
  hasApplied: boolean;
  hasExported: boolean;
};

type MilestoneFlag = "hasKey" | "hasSentMessage" | "hasApplied" | "hasExported";

let cached: ProfileState | null = null;
let firstRun = false;

function profileFile(): string {
  return path.join(app.getPath("userData"), ".qing-telemetry-profile.json");
}

function defaults(): ProfileState {
  return { firstRunAt: new Date().toISOString(), hasKey: false, hasSentMessage: false, hasApplied: false, hasExported: false };
}

function persist(state: ProfileState): void {
  try {
    writeFileSync(profileFile(), JSON.stringify(state), "utf8");
  } catch {
    // 写盘失败退化为进程内状态,不影响主流程。
  }
}

/** 加载(或首启创建)画像状态;进程内缓存。 */
export function loadProfile(): ProfileState {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(profileFile(), "utf8")) as Partial<ProfileState>;
    if (typeof raw.firstRunAt !== "string") throw new Error("bad profile");
    cached = {
      firstRunAt: raw.firstRunAt,
      hasKey: raw.hasKey === true,
      hasSentMessage: raw.hasSentMessage === true,
      hasApplied: raw.hasApplied === true,
      hasExported: raw.hasExported === true,
    };
  } catch {
    // 文件不存在 = 首启;损坏 = 重建(保守按非首启算,避免虚高激活数)。
    firstRun = !profileFileExists();
    cached = defaults();
    persist(cached);
  }
  return cached;
}

function profileFileExists(): boolean {
  try {
    readFileSync(profileFile(), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 本次进程是否为首启(loadProfile 之后才有意义)。 */
export function wasFirstRun(): boolean {
  return firstRun;
}

/** 翻牌某里程碑(false→true 才写盘);返回是否发生了翻转。 */
export function markMilestone(flag: MilestoneFlag): boolean {
  const state = loadProfile();
  if (state[flag]) return false;
  state[flag] = true;
  persist(state);
  return true;
}

/** 装机龄分桶(低基数,便于后台聚合)。 */
export function ageDaysBucket(): "0" | "1-7" | "8-30" | "30+" {
  const state = loadProfile();
  const days = Math.floor((Date.now() - Date.parse(state.firstRunAt)) / 86400000);
  if (!Number.isFinite(days) || days <= 0) return "0";
  if (days <= 7) return "1-7";
  if (days <= 30) return "8-30";
  return "30+";
}

import type { SkillMenuAction } from "./SkillMenu";

export const SKILL_USAGE_STORAGE_KEY = "qingagent:skill-usage";

interface SkillUsageEntry {
  count: number;
  lastUsedAt: number;
}

type SkillUsageMap = Record<string, SkillUsageEntry>;

function readSkillUsage(): SkillUsageMap {
  if (typeof window === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(SKILL_USAGE_STORAGE_KEY) ?? "{}",
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const usage: SkillUsageMap = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Partial<SkillUsageEntry>;
      if (
        Number.isInteger(entry.count)
        && (entry.count ?? 0) > 0
        && Number.isFinite(entry.lastUsedAt)
        && (entry.lastUsedAt ?? -1) >= 0
      ) {
        usage[id] = {
          count: entry.count as number,
          lastUsedAt: entry.lastUsedAt as number,
        };
      }
    }
    return usage;
  } catch {
    return {};
  }
}

export function recordSkillUsage(skillId: string, usedAt = Date.now()): void {
  const usage = readSkillUsage();
  const previous = usage[skillId];
  usage[skillId] = {
    count: (previous?.count ?? 0) + 1,
    lastUsedAt: usedAt,
  };
  try {
    window.localStorage.setItem(SKILL_USAGE_STORAGE_KEY, JSON.stringify(usage));
  } catch {
    // localStorage 不可用时静默降级；不影响本次技能插入。
  }
}

/**
 * 用过的技能按最近使用倒序置顶；从未用过的技能保持服务端给出的内置顺序。
 * Array#sort 在相同时间戳下用初始序号兜底，结果稳定且可预期。
 */
export function sortSkillActionsByUsage(
  actions: readonly SkillMenuAction[],
): SkillMenuAction[] {
  const usage = readSkillUsage();
  return actions
    .map((action, initialIndex) => ({ action, initialIndex, usage: usage[action.id] }))
    .sort((left, right) => {
      if (left.usage && right.usage) {
        return right.usage.lastUsedAt - left.usage.lastUsedAt
          || left.initialIndex - right.initialIndex;
      }
      if (left.usage) return -1;
      if (right.usage) return 1;
      return left.initialIndex - right.initialIndex;
    })
    .map(({ action }) => action);
}

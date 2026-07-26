import type { WorkspaceSkills } from "@mastra/core/workspace";
import { resolve } from "node:path";
import { scanSkillHierarchy } from "./discovery.js";

/**
 * Workspace 只注册顶层技能；历史数据若携带子技能 id，则统一归一到所属顶层母技能。
 */
export async function resolveTopLevelSkillId(
  skills: WorkspaceSkills,
  skillId: string,
): Promise<string | null> {
  const id = skillId.trim();
  if (!id) return null;
  if (await skills.has(id).catch(() => false)) return id;

  const topLevelSkills = await skills.list().catch(() => []);
  const matchedParents = new Set<string>();
  for (const parent of topLevelSkills) {
    const parentPath = resolve(parent.path);
    const hierarchy = await scanSkillHierarchy(parentPath).catch(() => []);
    if (
      hierarchy.some(
        (candidate) =>
          candidate.path !== parentPath && candidate.metadata.name === id,
      )
    ) {
      matchedParents.add(parent.name);
    }
  }
  return matchedParents.size === 1 ? [...matchedParents][0]! : null;
}

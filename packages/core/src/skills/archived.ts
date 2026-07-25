// 通用内置技能归档清单；当前无归档项。所有技能发现路径仍必须过滤这份清单。
export const ARCHIVED_BUILTIN_SKILLS = new Set<string>();

export function isArchivedBuiltinSkillName(name: string): boolean {
  return ARCHIVED_BUILTIN_SKILLS.has(name);
}

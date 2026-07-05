// M1 下架入口但保留代码留档的内置技能名。所有技能发现路径都必须过滤这份清单。
export const ARCHIVED_BUILTIN_SKILLS = new Set<string>(["dingtalk-docs"]);

export function isArchivedBuiltinSkillName(name: string): boolean {
  return ARCHIVED_BUILTIN_SKILLS.has(name);
}

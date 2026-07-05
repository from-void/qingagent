export interface SkillDisplaySource {
  name: string;
  label: string;
  summary: string;
  icon: string;
  placeholder?: string;
  enabled: boolean;
  userInvocable: boolean;
}

export interface SkillDisplay {
  id: string;
  label: string;
  description: string;
  placeholder: string;
  icon: string;
}

export function skillToMenuAction(skill: SkillDisplaySource): SkillDisplay {
  return {
    id: skill.name,
    label: skill.label,
    description: skill.summary,
    placeholder: skill.placeholder ?? skill.summary,
    icon: skill.icon,
  };
}

export function invocableSkillActionsFromApi(skills: readonly SkillDisplaySource[]): SkillDisplay[] {
  return skills
    .filter((skill) => skill.enabled && skill.userInvocable)
    .map((skill) => skillToMenuAction(skill));
}

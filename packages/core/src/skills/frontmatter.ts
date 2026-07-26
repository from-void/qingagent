export const SKILL_NAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function stripSkillSourceBom(source: string): string {
  return source.replace(/^\uFEFF/, "");
}

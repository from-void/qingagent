const TRUTHY_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);

export function isTruthyFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return TRUTHY_FLAG_VALUES.has(raw.trim().toLowerCase());
}

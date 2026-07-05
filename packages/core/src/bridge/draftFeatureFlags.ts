const TRUTHY_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);

export function isTruthyFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return TRUTHY_FLAG_VALUES.has(raw.trim().toLowerCase());
}

export function isServerReanchorEnabled(): boolean {
  // PR0 server-side reanchor is a safety-gated cheap win. Default off; only an
  // explicit truthy env var enables fuzzy before-anchor relocation.
  return isTruthyFlag(process.env.QINGAGENT_SERVER_REANCHOR);
}

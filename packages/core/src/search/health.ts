import type { SearchProviderErrorKind } from "./errors.js";

export const SEARCH_PROVIDER_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
/** 403/422 短冷却；到期后的下一次搜索即作为自动恢复探测。 */
export const SEARCH_PROVIDER_AUTH_COOLDOWN_MS = 5 * 60 * 1000;
/** 冷却到期后的下一次搜索开始恢复探测；若仍失败，会按同一保守间隔重新冷却。 */
export const SEARCH_PROVIDER_AUTH_PROBE_INTERVAL_MS = SEARCH_PROVIDER_AUTH_COOLDOWN_MS;

export type SearchProviderHealthStatus = "ok" | "auth" | "quota";

export interface SearchProviderHealth {
  status: SearchProviderHealthStatus;
  authRetryAt?: number;
  quotaUntil?: number;
}

interface HealthState {
  authFailed?: boolean;
  authRetryAt?: number;
  quotaUntil?: number;
}

const state = new Map<string, HealthState>();

export function markSearchProviderAuthFailed(id: string): void {
  const current = state.get(id) ?? {};
  state.set(id, { ...current, authFailed: true, authRetryAt: undefined });
}

export function markSearchProviderAuthCooldown(
  id: string,
  cooldownMs = SEARCH_PROVIDER_AUTH_COOLDOWN_MS,
): void {
  const current = state.get(id) ?? {};
  if (current.authFailed) return;
  state.set(id, { ...current, authRetryAt: Date.now() + cooldownMs });
}

export function markSearchProviderQuota(
  id: string,
  cooldownMs = SEARCH_PROVIDER_QUOTA_COOLDOWN_MS,
): void {
  const current = state.get(id) ?? {};
  state.set(id, { ...current, quotaUntil: Date.now() + cooldownMs });
}

export function recordSearchProviderError(
  id: string,
  kind: SearchProviderErrorKind,
  status?: number,
): void {
  if (kind === "auth") {
    if (status === 403 || status === 422) markSearchProviderAuthCooldown(id);
    else markSearchProviderAuthFailed(id);
  }
  if (kind === "quota") markSearchProviderQuota(id);
}

export function clearSearchProviderHealth(id: string): void {
  state.delete(id);
}

export function getSearchProviderHealth(id: string, now = Date.now()): SearchProviderHealth {
  const current = state.get(id);
  if (!current) return { status: "ok" };
  if (current.authFailed) return { status: "auth" };
  if (current.authRetryAt && current.authRetryAt > now) {
    return { status: "auth", authRetryAt: current.authRetryAt };
  }
  if (current.authRetryAt && current.authRetryAt <= now) {
    delete current.authRetryAt;
  }
  if (current.quotaUntil && current.quotaUntil > now) {
    return { status: "quota", quotaUntil: current.quotaUntil };
  }
  if (current.quotaUntil && current.quotaUntil <= now) {
    delete current.quotaUntil;
  }
  if (!current.authFailed && !current.authRetryAt && !current.quotaUntil) state.delete(id);
  return { status: "ok" };
}

export function shouldSkipSearchProvider(id: string): boolean {
  return getSearchProviderHealth(id).status !== "ok";
}

export function __resetSearchProviderHealthForTest(): void {
  state.clear();
}

import type { SearchProviderErrorKind } from "./errors.js";

export const SEARCH_PROVIDER_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;

export type SearchProviderHealthStatus = "ok" | "auth" | "quota";

export interface SearchProviderHealth {
  status: SearchProviderHealthStatus;
  quotaUntil?: number;
}

interface HealthState {
  authFailed?: boolean;
  quotaUntil?: number;
}

const state = new Map<string, HealthState>();

export function markSearchProviderAuthFailed(id: string): void {
  const current = state.get(id) ?? {};
  state.set(id, { ...current, authFailed: true });
}

export function markSearchProviderQuota(
  id: string,
  cooldownMs = SEARCH_PROVIDER_QUOTA_COOLDOWN_MS,
): void {
  const current = state.get(id) ?? {};
  state.set(id, { ...current, quotaUntil: Date.now() + cooldownMs });
}

export function recordSearchProviderError(id: string, kind: SearchProviderErrorKind): void {
  if (kind === "auth") markSearchProviderAuthFailed(id);
  if (kind === "quota") markSearchProviderQuota(id);
}

export function clearSearchProviderHealth(id: string): void {
  state.delete(id);
}

export function getSearchProviderHealth(id: string, now = Date.now()): SearchProviderHealth {
  const current = state.get(id);
  if (!current) return { status: "ok" };
  if (current.authFailed) return { status: "auth" };
  if (current.quotaUntil && current.quotaUntil > now) {
    return { status: "quota", quotaUntil: current.quotaUntil };
  }
  if (current.quotaUntil && current.quotaUntil <= now) {
    state.delete(id);
  }
  return { status: "ok" };
}

export function shouldSkipSearchProvider(id: string): boolean {
  return getSearchProviderHealth(id).status !== "ok";
}

export function __resetSearchProviderHealthForTest(): void {
  state.clear();
}

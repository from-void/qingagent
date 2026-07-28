import {
  SETTING_SEARCH_PRIMARY,
  SETTING_SEARCH_PROVIDER_CONFIG,
  getAppSetting,
} from "@qingagent/db";
import { SearchProviderError } from "./errors.js";
import { MultiSourceSearchProvider, type SearchSource } from "./multiSource.js";
import type { SearchOptions, SearchProvider, SearchResult } from "./provider.js";
import { filterByRelevance } from "./relevanceGate.js";
import {
  SEARCH_PROVIDER_REGISTRY,
  type SearchProviderConfig,
  type SearchProviderConfigMap,
  type SearchProviderId,
} from "./registry.js";
import {
  clearSearchProviderHealth,
  getSearchProviderHealth,
  recordSearchProviderError,
  shouldSkipSearchProvider,
} from "./health.js";

const CACHE_TTL_MS = 30_000;

interface CachedConfig {
  expiresAt: number;
  config: SearchProviderConfigMap;
  signature: string;
}

export interface PrimarySearchConfig {
  enabled: boolean;
  apiKey?: string;
}

interface CachedPrimaryConfig {
  expiresAt: number;
  config: PrimarySearchConfig;
}

let cachedConfig: CachedConfig | null = null;
let lastGoodConfig: Pick<CachedConfig, "config" | "signature"> | null = null;
let cachedProvider: { signature: string; provider: SearchProvider } | null = null;
let cachedPrimaryConfig: CachedPrimaryConfig | null = null;
let lastGoodPrimaryConfig: PrimarySearchConfig | null = null;

export function invalidateManagedSearchConfig(): void {
  cachedConfig = null;
  cachedProvider = null;
}

function sanitizeKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value || value.length > 500 || !/^[\x21-\x7e]+$/.test(value)) return undefined;
  return value;
}

function sanitizeUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value || value.length > 500) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function parseSearchProviderConfig(raw: string | null): SearchProviderConfigMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const root = parsed as Record<string, unknown>;
    const out: SearchProviderConfigMap = {};
    for (const entry of SEARCH_PROVIDER_REGISTRY) {
      const value = root[entry.id];
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const config: SearchProviderConfig = {};
      if (typeof record.enabled === "boolean") config.enabled = record.enabled;
      const apiKey = sanitizeKey(record.apiKey);
      const url = sanitizeUrl(record.url);
      if (apiKey) config.apiKey = apiKey;
      if (url) config.url = url;
      out[entry.id] = config;
    }
    return out;
  } catch {
    return {};
  }
}

export function parsePrimarySearchConfig(raw: string | null): PrimarySearchConfig {
  if (!raw) return { enabled: true };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { enabled: true };
    }
    const record = parsed as Record<string, unknown>;
    const config: PrimarySearchConfig = {
      enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    };
    const apiKey = sanitizeKey(record.apiKey);
    if (apiKey) config.apiKey = apiKey;
    return config;
  } catch {
    return { enabled: true };
  }
}

export function invalidatePrimarySearchConfig(): void {
  cachedPrimaryConfig = null;
}

export async function getPrimarySearchConfig(): Promise<PrimarySearchConfig> {
  const now = Date.now();
  if (cachedPrimaryConfig && cachedPrimaryConfig.expiresAt > now) {
    return cachedPrimaryConfig.config;
  }

  try {
    const config = parsePrimarySearchConfig(await getAppSetting(SETTING_SEARCH_PRIMARY));
    cachedPrimaryConfig = { expiresAt: now + CACHE_TTL_MS, config };
    lastGoodPrimaryConfig = config;
    return config;
  } catch {
    const fallback = lastGoodPrimaryConfig ?? { enabled: true };
    cachedPrimaryConfig = { expiresAt: now + CACHE_TTL_MS, config: fallback };
    return fallback;
  }
}

export async function getSearchProviderConfig(): Promise<SearchProviderConfigMap> {
  const now = Date.now();
  if (cachedConfig && cachedConfig.expiresAt > now) return cachedConfig.config;
  try {
    const config = parseSearchProviderConfig(
      await getAppSetting(SETTING_SEARCH_PROVIDER_CONFIG),
    );
    const signature = JSON.stringify(config);
    cachedConfig = {
      expiresAt: now + CACHE_TTL_MS,
      config,
      signature,
    };
    lastGoodConfig = { config, signature };
    return config;
  } catch {
    const fallback = lastGoodConfig ?? { config: {}, signature: "{}" };
    cachedConfig = { expiresAt: now + CACHE_TTL_MS, ...fallback };
    return fallback.config;
  }
}

class ManagedApiProvider implements SearchProvider {
  constructor(
    private readonly id: SearchProviderId,
    private readonly provider: SearchProvider,
  ) {}

  async search(query: string, count: number, options?: SearchOptions): Promise<SearchResult[]> {
    try {
      return await this.provider.search(query, count, options);
    } catch (err) {
      if (options?.signal?.aborted) return [];
      if (err instanceof SearchProviderError) {
        recordSearchProviderError(this.id, err.kind, err.status);
      }
      return [];
    }
  }
}

class RelevanceGatedProvider implements SearchProvider {
  constructor(private readonly inner: SearchProvider) {}

  async search(query: string, count: number, options?: SearchOptions): Promise<SearchResult[]> {
    const results = await this.inner.search(query, count, options);
    return filterByRelevance(results, query).kept;
  }
}

function buildProviderSignature(configSignature: string): string {
  const healthSignature = SEARCH_PROVIDER_REGISTRY
    .map((entry) => {
      const health = getSearchProviderHealth(entry.id);
      return `${entry.id}:${health.status}:${health.authRetryAt ?? 0}:${health.quotaUntil ?? 0}`;
    })
    .join("|");
  return `${configSignature}::${healthSignature}`;
}

function sourceEnabled(id: SearchProviderId, config: SearchProviderConfig | undefined): boolean {
  if (id === "bing" || id === "ddg") return true;
  return config?.enabled === true;
}

function buildManagedProvider(config: SearchProviderConfigMap): SearchProvider {
  const sources: SearchSource[] = [];

  for (const entry of SEARCH_PROVIDER_REGISTRY) {
    const sourceConfig = config[entry.id];
    if (!sourceEnabled(entry.id, sourceConfig)) continue;
    if (entry.kind === "api") {
      if (!sourceConfig?.apiKey || shouldSkipSearchProvider(entry.id)) continue;
      sources.push({
        name: entry.id,
        provider: new ManagedApiProvider(entry.id, entry.buildProvider(sourceConfig)),
      });
      continue;
    }
    if (entry.id === "ddg" && shouldSkipSearchProvider("ddg")) continue;
    if (entry.id === "searxng" && !sourceConfig?.url) continue;
    sources.push({
      name: entry.id,
      provider: new RelevanceGatedProvider(entry.buildProvider(sourceConfig ?? {})),
    });
  }

  return new MultiSourceSearchProvider(sources);
}

export function __buildManagedProviderForTest(config: SearchProviderConfigMap): SearchProvider {
  return buildManagedProvider(config);
}

export async function getManagedSearchProvider(): Promise<SearchProvider> {
  const config = await getSearchProviderConfig();
  const configSignature = cachedConfig?.signature ?? JSON.stringify(config);
  const signature = buildProviderSignature(configSignature);
  if (cachedProvider?.signature === signature) return cachedProvider.provider;
  const provider = buildManagedProvider(config);
  cachedProvider = { signature, provider };
  return provider;
}

export function clearManagedSearchProviderHealth(id: SearchProviderId): void {
  clearSearchProviderHealth(id);
  cachedProvider = null;
}

import { Hono } from "hono";
import type { Context } from "hono";
import {
  SEARCH_PROVIDER_REGISTRY,
  SETTING_SEARCH_PRIMARY,
  SETTING_SEARCH_PROVIDER_CONFIG,
  SearchProviderError,
  clearManagedSearchProviderHealth,
  clearSearchCache,
  getSearchProviderHealth,
  getAppSetting,
  invalidateManagedSearchConfig,
  invalidatePrimarySearchConfig,
  isSearchProviderId,
  parsePrimarySearchConfig,
  parseSearchProviderConfig,
  recordSearchProviderError,
  patchAppSettingJsonField,
  setAppSetting,
  type SearchProviderConfig,
  type SearchProviderConfigMap,
  type SearchProviderErrorKind,
  type SearchProviderId,
  type SearchProviderRegistryEntry,
} from "@qingagent/core";
import { z } from "zod";
import { requireTrustedOrigin } from "../lib/trustedOrigin";
import { parseBody } from "../lib/validation";

export const searchSettingsRoutes = new Hono();

/** 设置类请求体外层:任意字符串键对象(具体字段/条件校验在各 PUT 内保留)。 */
const objectBodySchema = z.record(z.string(), z.unknown());

const TEST_QUERY = "测试";

function maskTail(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(-4);
}

function sanitizeApiKey(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "apiKey must be a string" };
  const value = raw.trim();
  if (!value) return { ok: true, value: "" };
  if (value.length > 500) return { ok: false, error: "apiKey is too long" };
  if (!/^[\x21-\x7e]+$/.test(value)) {
    return { ok: false, error: "apiKey contains invalid characters" };
  }
  return { ok: true, value };
}

function sanitizeUrl(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "url must be a string" };
  const value = raw.trim();
  if (!value) return { ok: true, value: "" };
  if (value.length > 500) return { ok: false, error: "url is too long" };
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, error: "url must use http or https" };
    }
    return { ok: true, value: url.toString() };
  } catch {
    return { ok: false, error: "url is invalid" };
  }
}

async function readStoredConfig(): Promise<SearchProviderConfigMap> {
  return parseSearchProviderConfig(await getAppSetting(SETTING_SEARCH_PROVIDER_CONFIG));
}

function configValueFor(entry: SearchProviderRegistryEntry, config: SearchProviderConfig | undefined): string {
  if (entry.id === "searxng") return config?.url ?? "";
  if (entry.kind === "api") return config?.apiKey ?? "";
  return "";
}

function isEffectivelyEnabled(
  entry: SearchProviderRegistryEntry,
  config: SearchProviderConfig | undefined,
): boolean {
  if (entry.id === "bing" || entry.id === "ddg") return true;
  if (entry.id === "searxng") return config?.enabled === true && Boolean(config.url);
  return config?.enabled === true && Boolean(config.apiKey);
}

async function readSearchSettingsResponse() {
  const config = await readStoredConfig();
  return {
    providers: SEARCH_PROVIDER_REGISTRY.map((entry) => {
      const sourceConfig = config[entry.id];
      const configuredValue = configValueFor(entry, sourceConfig);
      const health = getSearchProviderHealth(entry.id);
      return {
        id: entry.id,
        label: entry.label,
        kind: entry.kind,
        enabled: isEffectivelyEnabled(entry, sourceConfig),
        keyConfigured: Boolean(configuredValue),
        maskedTail: maskTail(configuredValue),
        health: {
          status: health.status,
          quotaUntil: health.quotaUntil ? new Date(health.quotaUntil).toISOString() : null,
        },
        freeQuotaNote: entry.freeQuotaNote,
        keyUrl: entry.keyUrl,
      };
    }),
  };
}

async function readPrimarySearchSettingsResponse() {
  const config = parsePrimarySearchConfig(await getAppSetting(SETTING_SEARCH_PRIMARY));
  const envKeyResult = sanitizeApiKey(process.env.DEEPSEEK_API_KEY ?? "");
  const envKey = envKeyResult.ok ? envKeyResult.value : "";
  const effectiveKey = config.apiKey ?? envKey;
  const source = config.apiKey ? "db" : envKey ? "env" : "none";
  return {
    enabled: config.enabled,
    keyConfigured: Boolean(effectiveKey),
    maskedTail: maskTail(effectiveKey),
    source,
  };
}

function findEntry(id: SearchProviderId): SearchProviderRegistryEntry {
  const entry = SEARCH_PROVIDER_REGISTRY.find((item) => item.id === id);
  if (!entry) throw new Error(`Unknown search provider: ${id}`);
  return entry;
}

async function parseObjectBody(c: Context) {
  const parsed = await parseBody(c, objectBodySchema, {
    // 保留旧文案:JSON 失败 → "Invalid JSON body";非对象 body → "Body must be an object"。
    makeErrorResponse: (ctx, body) =>
      ctx.json({ error: body.error === "Invalid JSON body" ? "Invalid JSON body" : "Body must be an object" }, 400),
  });
  if (!parsed.ok) return { ok: false as const, response: parsed.response };
  return { ok: true as const, body: parsed.data };
}

searchSettingsRoutes.get("/settings/search", async (c) => {
  return c.json(await readSearchSettingsResponse());
});

searchSettingsRoutes.get("/settings/search/primary", async (c) => {
  return c.json(await readPrimarySearchSettingsResponse());
});

searchSettingsRoutes.put("/settings/search/primary", async (c) => {
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;

  const parsed = await parseObjectBody(c);
  if (!parsed.ok) return parsed.response;

  const config = parsePrimarySearchConfig(await getAppSetting(SETTING_SEARCH_PRIMARY));
  if ("enabled" in parsed.body) {
    if (typeof parsed.body.enabled !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }
    config.enabled = parsed.body.enabled;
  }

  if ("apiKey" in parsed.body) {
    const parsedKey = sanitizeApiKey(parsed.body.apiKey);
    if (!parsedKey.ok) return c.json({ error: parsedKey.error }, 400);
    if (parsedKey.value) config.apiKey = parsedKey.value;
    else delete config.apiKey;
  }

  await setAppSetting(SETTING_SEARCH_PRIMARY, JSON.stringify(config));
  invalidatePrimarySearchConfig();
  clearSearchCache();
  return c.json(await readPrimarySearchSettingsResponse());
});

searchSettingsRoutes.put("/settings/search/:id", async (c) => {
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;

  const id = c.req.param("id");
  if (!isSearchProviderId(id)) return c.json({ error: "Unknown search provider" }, 404);
  const entry = findEntry(id);
  const parsed = await parseObjectBody(c);
  if (!parsed.ok) return parsed.response;

  const config = await readStoredConfig();
  const previousCredential = configValueFor(entry, config[id]);
  let nextCredential = previousCredential;
  const patch: Record<string, unknown> = {};
  const deleteFields: string[] = [];

  let warning: string | undefined;
  if (typeof parsed.body.enabled === "boolean") {
    if (id === "bing" || id === "ddg") {
      // R2-B:内置兜底源不可关闭——不再静默忽略,响应带 warning 让前端可提示。
      if (parsed.body.enabled === false) warning = "内置搜索源不能关闭,已保留";
    } else {
      patch.enabled = parsed.body.enabled;
    }
  }

  if ("apiKey" in parsed.body) {
    if (entry.kind !== "api") return c.json({ error: "apiKey is only supported for API providers" }, 400);
    const parsedKey = sanitizeApiKey(parsed.body.apiKey);
    if (!parsedKey.ok) return c.json({ error: parsedKey.error }, 400);
    if (parsedKey.value) patch.apiKey = parsedKey.value;
    else deleteFields.push("apiKey");
    nextCredential = parsedKey.value;
  }

  if ("url" in parsed.body) {
    if (id !== "searxng") return c.json({ error: "url is only supported for SearXNG" }, 400);
    const parsedUrl = sanitizeUrl(parsed.body.url);
    if (!parsedUrl.ok) return c.json({ error: parsedUrl.error }, 400);
    if (parsedUrl.value) patch.url = parsedUrl.value;
    else deleteFields.push("url");
    nextCredential = parsedUrl.value;
  }

  await patchAppSettingJsonField(SETTING_SEARCH_PROVIDER_CONFIG, id, patch, deleteFields);
  if (nextCredential !== previousCredential) clearManagedSearchProviderHealth(id);
  invalidateManagedSearchConfig();
  clearSearchCache();
  const response = await readSearchSettingsResponse();
  return c.json(warning ? { ...response, warning } : response);
});

searchSettingsRoutes.post("/settings/search/:id/test", async (c) => {
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;

  const id = c.req.param("id");
  if (!isSearchProviderId(id)) return c.json({ error: "Unknown search provider" }, 404);
  const entry = findEntry(id);
  const config = await readStoredConfig();
  const sourceConfig = config[id] ?? {};

  // R2-B:未配置 ≠ 认证失败——返回明确 missing_key 且不污染健康表(此前误落 auth)。
  if (entry.kind === "api" && !sourceConfig.apiKey) {
    return c.json({ ok: false, errorKind: "missing_key", error: "该源尚未配置 API key" }, 400);
  }
  if (id === "searxng" && !sourceConfig.url) {
    return c.json({ ok: false, errorKind: "missing_key", error: "尚未配置 SearXNG 实例 URL" }, 400);
  }

  try {
    const results = await entry.buildProvider(sourceConfig).search(TEST_QUERY, 3, {
      signal: c.req.raw.signal,
      strict: true,
    });
    clearManagedSearchProviderHealth(id);
    return c.json({ ok: true, resultCount: results.length });
  } catch (err) {
    const errorKind: SearchProviderErrorKind =
      err instanceof SearchProviderError ? err.kind : "network";
    recordSearchProviderError(
      id,
      errorKind,
      err instanceof SearchProviderError ? err.status : undefined,
    );
    return c.json({ ok: false, errorKind, resultCount: 0 });
  } finally {
    invalidateManagedSearchConfig();
  }
});

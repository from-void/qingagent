import {
  SEARCH_PROVIDER_REGISTRY,
  SETTING_DEEPSEEK_GLOBAL_KEY,
  SETTING_MODEL_PARAMS,
  SETTING_SEARCH_PRIMARY,
  SETTING_SEARCH_PROVIDER_CONFIG,
  browserFolderSourcesEnabled,
  getAppSetting,
  localFolderSourcesEnabled,
  parsePrimarySearchConfig,
  parseSearchProviderConfig,
  resolveIsolation,
} from "@qingagent/core";
import type { DiagSection } from "@qingagent/contract-ts";

export interface EnvSnapshot {
  runtime: "desktop" | "server";
  agentBrowser: boolean;
  localFolderSources: boolean;
  browserFolderSources: boolean;
  authTokenSet: boolean;
  deepseekKeyPresent: boolean;
  customDeepseekBaseUrl: boolean;
  sandboxIsolation: "bwrap" | "seatbelt" | "none";
  skillMutationAllowed: boolean;
  unisolatedCommandsAllowed: boolean;
  credentialInjectionAllowed: boolean;
  pyodideEnabled: boolean;
}

export interface SettingsSnapshot {
  model: {
    globalKeyConfigured: boolean;
    envKeyConfigured: boolean;
    paramsConfigured: boolean;
    params: {
      temperatureConfigured: boolean;
      topPConfigured: boolean;
      maxOutputTokensConfigured: boolean;
    };
  };
  search: {
    primaryEnabled: boolean;
    primaryKeyConfigured: boolean;
    providers: Array<{
      id: string;
      kind: "scrape" | "api";
      enabled: boolean;
      keyConfigured: boolean;
      urlConfigured: boolean;
    }>;
  };
  capabilities: {
    localFolderSources: boolean;
    browserFolderSources: boolean;
    skillMutationAllowed: boolean;
  };
}

export function makeDiagSection(
  name: string,
  files: string[],
  count: number,
  truncated = false,
): DiagSection {
  return { name, files, count, truncated };
}

export function collectEnvSnapshot(env: NodeJS.ProcessEnv = process.env): EnvSnapshot {
  const runtime = env.QINGAGENT_RUNTIME === "desktop" ? "desktop" : "server";
  return {
    runtime,
    agentBrowser: isTruthy(env.QINGAGENT_AGENT_BROWSER),
    localFolderSources: localFolderSourcesEnabled(),
    browserFolderSources: browserFolderSourcesEnabled(),
    authTokenSet: hasValue(env.QINGAGENT_AUTH_TOKEN),
    deepseekKeyPresent: hasValue(env.DEEPSEEK_API_KEY),
    customDeepseekBaseUrl: hasValue(env.QINGAGENT_DEEPSEEK_BASE_URL),
    sandboxIsolation: resolveIsolation(),
    skillMutationAllowed: isTruthy(env.QINGAGENT_ALLOW_SKILL_MUTATION),
    unisolatedCommandsAllowed: isTruthy(env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS),
    credentialInjectionAllowed: isTruthy(env.QINGAGENT_SANDBOX_INJECT_CREDENTIALS),
    pyodideEnabled: isTruthy(env.QINGAGENT_PYODIDE_ENABLED),
  };
}

export async function collectSettingsSnapshot(env: NodeJS.ProcessEnv = process.env): Promise<SettingsSnapshot> {
  const [dbKey, paramsRaw, searchPrimaryRaw, searchProvidersRaw] = await Promise.all([
    getAppSetting(SETTING_DEEPSEEK_GLOBAL_KEY).catch(() => null),
    getAppSetting(SETTING_MODEL_PARAMS).catch(() => null),
    getAppSetting(SETTING_SEARCH_PRIMARY).catch(() => null),
    getAppSetting(SETTING_SEARCH_PROVIDER_CONFIG).catch(() => null),
  ]);

  const params = parseModelParams(paramsRaw);
  const primary = parsePrimarySearchConfig(searchPrimaryRaw);
  const providers = parseSearchProviderConfig(searchProvidersRaw);
  const envDeepseekKeyConfigured = hasValue(env.DEEPSEEK_API_KEY);

  return {
    model: {
      globalKeyConfigured: hasValue(dbKey),
      envKeyConfigured: envDeepseekKeyConfigured,
      paramsConfigured: params.temperatureConfigured || params.topPConfigured || params.maxOutputTokensConfigured,
      params,
    },
    search: {
      primaryEnabled: primary.enabled,
      primaryKeyConfigured: Boolean(primary.apiKey) || envDeepseekKeyConfigured,
      providers: SEARCH_PROVIDER_REGISTRY.map((entry) => {
        const config = providers[entry.id];
        return {
          id: entry.id,
          kind: entry.kind,
          enabled: entry.id === "bing" || entry.id === "ddg"
            ? true
            : config?.enabled === true,
          keyConfigured: Boolean(config?.apiKey),
          urlConfigured: Boolean(config?.url),
        };
      }),
    },
    capabilities: {
      localFolderSources: localFolderSourcesEnabled(),
      browserFolderSources: browserFolderSourcesEnabled(),
      skillMutationAllowed: isTruthy(env.QINGAGENT_ALLOW_SKILL_MUTATION),
    },
  };
}

function parseModelParams(raw: string | null): SettingsSnapshot["model"]["params"] {
  if (!raw) {
    return {
      temperatureConfigured: false,
      topPConfigured: false,
      maxOutputTokensConfigured: false,
    };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    return {
      temperatureConfigured: typeof record.temperature === "number",
      topPConfigured: typeof record.topP === "number",
      maxOutputTokensConfigured: typeof record.maxOutputTokens === "number",
    };
  } catch {
    return {
      temperatureConfigured: false,
      topPConfigured: false,
      maxOutputTokensConfigured: false,
    };
  }
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return new Set(["1", "true", "yes", "on"]).has(value.trim().toLowerCase());
}

function hasValue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

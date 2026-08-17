import type { ModelProvider } from "./visitorKeyStore";

export interface ModelProviderConfigurationSources {
  localConfigured?: boolean;
  serverConfigured?: boolean;
}

/** 设置页与首启门共用：合并 visitor/custom 本机配置和 DB/env 服务端配置。 */
export function isModelProviderConfigured(
  sources: ModelProviderConfigurationSources,
): boolean {
  return Boolean(sources.localConfigured || sources.serverConfigured);
}

export function anyModelProviderConfigured(
  providers: readonly ModelProvider[],
  sourcesOf: (provider: ModelProvider) => ModelProviderConfigurationSources,
): boolean {
  return providers.some((provider) => isModelProviderConfigured(sourcesOf(provider)));
}

export const MODEL_DEFAULTS: Record<ModelProvider, { flash: string; pro: string }> = {
  deepseek: { flash: "deepseek-v4-flash", pro: "deepseek-v4-pro" },
  kimi: { flash: "kimi-for-coding", pro: "k3" },
};

// 首拉在途时指标副行的占位:不写任何文案(空态/错误都算结论),用不换行空格撑住行高不塌。
export const PENDING_SUB = "\u00a0";

export interface ServerModelSettings {
  provider: ModelProvider;
  providers: Record<ModelProvider, {
    apiKeyConfigured: boolean;
    maskedTail: string | null;
    source: "db" | "env" | "none";
  }>;
  params: { temperature?: number; topP?: number; maxOutputTokens?: number } | null;
}

export interface BalanceState {
  ok: boolean;
  keySource?: string;
  keyInvalid?: boolean;
  permissionDenied?: boolean;
  balanceUnsupported?: boolean;
  error?: string;
  isAvailable?: boolean | null;
  balances?: Array<{ currency: string; total: string; granted: string; toppedUp: string }>;
}

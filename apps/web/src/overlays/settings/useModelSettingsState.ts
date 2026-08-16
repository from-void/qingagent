import { useState } from "react";
import { readUsageMode, type UsageMode, type UsageRow, type UsageView } from "./modelUsage";
import { type BalanceState, type ServerModelSettings } from "./modelSettingsTypes";
import {
  type CustomProvider,
  type ModelProvider,
  type ModelTier,
  getSelectedModelTier,
  getVisitorModelKey,
  readCustomProvider,
  readOfficialModelOverride,
} from "./visitorKeyStore";

export function useModelConfigurationState({
  initialConfigProvider,
  selectedProvider,
}: {
  initialConfigProvider?: ModelProvider;
  selectedProvider: ModelProvider;
}) {
  const initialProvider = initialConfigProvider ?? selectedProvider;
  // modelProvider = 当前"使用中"的厂商;configProvider = 二级页正在配置的厂商(可以不是使用中那家)
  const [modelProvider, setModelProvider] = useState<ModelProvider>(selectedProvider);
  const [view, setView] = useState<"main" | "config">(
    initialConfigProvider ? "config" : "main",
  );
  const [configProvider, setConfigProvider] = useState<ModelProvider>(initialProvider);
  const [server, setServer] = useState<ServerModelSettings | null>(null);
  const [serverSettled, setServerSettled] = useState(false);
  const [visitorKeys, setVisitorKeys] = useState<Record<ModelProvider, string | null>>(() => ({
    deepseek: getVisitorModelKey("deepseek"),
    kimi: getVisitorModelKey("kimi"),
  }));
  const [customProviders, setCustomProviders] = useState<
    Record<ModelProvider, CustomProvider | null>
  >(() => ({
    deepseek: readCustomProvider("deepseek"),
    kimi: readCustomProvider("kimi"),
  }));
  const [kimiConnected, setKimiConnected] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [persisting, setPersisting] = useState(false);
  const initialCustom = readCustomProvider(initialProvider);
  const initialDefaults = initialProvider === "kimi"
    ? { flash: "kimi-for-coding", pro: "k3" }
    : { flash: "deepseek-v4-flash", pro: "deepseek-v4-pro" };
  const [setupMode, setSetupMode] = useState<"official" | "other">(
    () => (initialCustom ? "other" : "official"),
  );
  const [customProtocol, setCustomProtocol] = useState(() => initialCustom?.protocol ?? "openai");
  const [customBaseUrl, setCustomBaseUrl] = useState(() => initialCustom?.baseUrl ?? "");
  const [customKey, setCustomKey] = useState(() => initialCustom?.apiKey ?? "");
  const [customModelFlash, setCustomModelFlash] = useState(
    () => initialCustom?.modelFlash ?? initialDefaults.flash,
  );
  const [customModelPro, setCustomModelPro] = useState(
    () => initialCustom?.modelPro ?? initialDefaults.pro,
  );
  const [customTesting, setCustomTesting] = useState(false);
  const [officialFlash, setOfficialFlash] = useState(
    () => readOfficialModelOverride(initialProvider)?.flash ?? "",
  );
  const [officialPro, setOfficialPro] = useState(
    () => readOfficialModelOverride(initialProvider)?.pro ?? "",
  );
  const [tiers, setTiers] = useState<Record<ModelProvider, ModelTier>>(() => ({
    deepseek: getSelectedModelTier("deepseek"),
    kimi: getSelectedModelTier("kimi"),
  }));
  const [verifyStatus, setVerifyStatus] = useState<"idle" | "verifying" | "ok" | "fail">("idle");
  const [verifyMsg, setVerifyMsg] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [balance, setBalance] = useState<BalanceState | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  return {
    modelProvider, setModelProvider, view, setView, configProvider, setConfigProvider,
    server, setServer, serverSettled, setServerSettled, visitorKeys, setVisitorKeys,
    customProviders, setCustomProviders, kimiConnected, setKimiConnected,
    keyInput, setKeyInput, persisting, setPersisting, setupMode, setSetupMode,
    customProtocol, setCustomProtocol, customBaseUrl, setCustomBaseUrl,
    customKey, setCustomKey, customModelFlash, setCustomModelFlash,
    customModelPro, setCustomModelPro, customTesting, setCustomTesting,
    officialFlash, setOfficialFlash, officialPro, setOfficialPro, tiers, setTiers,
    verifyStatus, setVerifyStatus, verifyMsg, setVerifyMsg, message, setMessage,
    balance, setBalance, balanceLoading, setBalanceLoading,
  };
}
export function useModelUsageState() {
  const [usageView, setUsageView] = useState<UsageView>("day");
  const [usageMode, setUsageMode] = useState<UsageMode>(() => readUsageMode());
  const [expandedUsageGroups, setExpandedUsageGroups] = useState<Set<string>>(() => new Set());
  const [usage, setUsage] = useState<UsageRow[] | null>(null);
  const [usageSettled, setUsageSettled] = useState(false);
  const [usageStatus, setUsageStatus] = useState<"loading" | "ready" | "error">("loading");
  const [usageDate, setUsageDate] = useState("");
  const [excludedModels, setExcludedModels] = useState<ReadonlySet<string>>(() => new Set());
  const [dayUsage, setDayUsage] = useState<UsageRow[] | null>(null);
  const [totalUsage, setTotalUsage] = useState<UsageRow[] | null>(null);
  const [docStats, setDocStats] = useState<{ docs: number; words: number } | null>(null);
  const [scheduleRevision, setScheduleRevision] = useState("");
  const [dashboardSettled, setDashboardSettled] = useState({
    day: false,
    total: false,
    docs: false,
  });

  return {
    usageView, setUsageView, usageMode, setUsageMode,
    expandedUsageGroups, setExpandedUsageGroups, usage, setUsage,
    usageSettled, setUsageSettled, usageStatus, setUsageStatus,
    usageDate, setUsageDate, excludedModels, setExcludedModels,
    dayUsage, setDayUsage, totalUsage, setTotalUsage, docStats, setDocStats,
    scheduleRevision, setScheduleRevision,
    dashboardSettled, setDashboardSettled,
  };
}

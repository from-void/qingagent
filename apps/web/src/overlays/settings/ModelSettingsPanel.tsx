import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UsageSummaryResponse, UsageSummaryRow } from "@qingagent/contract-ts";
import { useToast } from "../../system/ToastProvider";
import { useConfirm } from "../../system";
import { CalendarDatePicker } from "../../system/CalendarDatePicker";
import { SkinSelect } from "../../system/SkinSelect";
import { SkinMultiSelect } from "../../system/SkinMultiSelect";
import { useDelayedVisible } from "../../system/useDelayedVisible";
import "./modelDashboard.css";
import { ModelTierChip } from "./ModelTierChip";
import {
  MODEL_VENDORS,
  VENDOR_INTRO,
  VENDOR_META,
  providerWfKey,
  vendorName,
} from "./modelVendorMeta";
import { SecretInput } from "./SecretInput";
import { ensureSettingsDialogA11y } from "./settingsDialogA11y";
import {
  type CustomProvider,
  type ModelProvider,
  type ModelTier,
  clearCustomProvider,
  clearVisitorModelKey,
  getSelectedModelProvider,
  getSelectedModelTier,
  getStoredModelProvider,
  getVisitorModelKey,
  maskKey,
  readCustomProvider,
  readOfficialModelOverride,
  readPersistedModelState,
  setSelectedModelProvider,
  setSelectedModelTier,
  setVisitorModelKey,
  writeCustomProvider,
  writeOfficialModelOverride,
} from "./visitorKeyStore";
import { repairBaseUrlScheme } from "./visionProviderStore";

ensureSettingsDialogA11y();

const MODEL_DEFAULTS: Record<ModelProvider, { flash: string; pro: string }> = {
  deepseek: { flash: "deepseek-v4-flash", pro: "deepseek-v4-pro" },
  kimi: { flash: "kimi-for-coding", pro: "k3" },
};

// 余额/连通检测始终按 DeepSeek 自己的配置发,不跟随"使用中"的厂商——
// 两张卡并列时,即使当前用的是 Kimi,DeepSeek 卡照样要显示余额。
// 不带 key 时服务端按 DB > env 兜底解析,与既有多源 key 优先级一致。
function deepseekBalanceHeaders(keyOverride?: string): Record<string, string> {
  const key = keyOverride?.trim() || getVisitorModelKey("deepseek");
  return {
    "x-model-provider": "deepseek",
    ...(key ? { "x-model-key": key, "x-deepseek-key": key } : {}),
  };
}

function modelPersistFailureMessage(): string {
  return window.electron?.isDesktop
    ? "系统无安全存储或本机写入失败，未保存"
    : "浏览器存储不可用，未保存";
}

// F1 模型设置面板。两层 key:本浏览器(visitor,localStorage) / 站点全局兜底(global-db)。
// 未配置态 = 小白引导 + 粘贴 key;已配置态 = 看板(进入即自动加载余额+用量,不再手动点按钮)。
// 进阶:其他云厂商(custom_provider)整体覆盖 baseURL+key+别名;官方模型前缀(official_model)仅覆盖模型名。

interface ServerModelSettings {
  provider?: ModelProvider;
  apiKeyConfigured: boolean;
  maskedTail: string | null;
  source: "db" | "env" | "none";
  providers?: Record<ModelProvider, {
    apiKeyConfigured: boolean;
    maskedTail: string | null;
    source: "db" | "env" | "none";
  }>;
  params: { temperature?: number; topP?: number; maxOutputTokens?: number } | null;
}

type UsageRow = UsageSummaryRow;

type UsageView = "day" | "session" | "total";
type UsageMode = "simple" | "expert";

const USAGE_MODE_STORAGE_KEY = "qingagent:model-usage-mode";

// 首拉在途时指标副行的占位:不写任何文案(空态/错误都算结论),用不换行空格撑住行高不塌。
const PENDING_SUB = "\u00a0";

interface BalanceState {
  ok: boolean;
  keySource?: string;
  keyInvalid?: boolean;
  permissionDenied?: boolean;
  balanceUnsupported?: boolean;
  error?: string;
  isAvailable?: boolean | null;
  balances?: Array<{ currency: string; total: string; granted: string; toppedUp: string }>;
}

export function ModelSettingsPanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const initialProvider = getSelectedModelProvider();
  // modelProvider = 当前"使用中"的厂商;configProvider = 二级页正在配置的厂商(可以不是使用中那家)
  const [modelProvider, setModelProvider] = useState<ModelProvider>(initialProvider);
  const [view, setView] = useState<"main" | "config">("main");
  const [configProvider, setConfigProvider] = useState<ModelProvider>(initialProvider);
  const [server, setServer] = useState<ServerModelSettings | null>(null);
  // 首拉是否已 settled(成功/失败都算)。口径:数据未定时一律不渲染空态/错误文案,
  // 否则切到本 tab 的头几十毫秒会闪出"加载失败或暂不可用""还没有可用的模型"等错误信息。
  const [serverSettled, setServerSettled] = useState(false);
  // 两张卡并列,两家的 key / 自定义配置都要在主视图上显示,故各存一份
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
  // Kimi 无余额体系,连通性只能靠用户在二级页手动测一次;测通后卡内状态行升级为"已连通"
  const [kimiConnected, setKimiConnected] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [persisting, setPersisting] = useState(false);
  // 配置方式:官方 DeepSeek(默认)/ 其他云厂商;已配自定义则默认停在"其他"
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
  // 官方模型前缀覆盖(仅已配置厂商的二级页可改;防官方升级改名)
  const [officialFlash, setOfficialFlash] = useState(
    () => readOfficialModelOverride(initialProvider)?.flash ?? "",
  );
  const [officialPro, setOfficialPro] = useState(
    () => readOfficialModelOverride(initialProvider)?.pro ?? "",
  );
  // 档位每厂商各记一份(DeepSeek Flash/Pro、Kimi K2.7/K3)
  const [tiers, setTiers] = useState<Record<ModelProvider, ModelTier>>(() => ({
    deepseek: getSelectedModelTier("deepseek"),
    kimi: getSelectedModelTier("kimi"),
  }));
  // 官方 key 输入即自动验证的状态
  const [verifyStatus, setVerifyStatus] = useState<"idle" | "verifying" | "ok" | "fail">("idle");
  const [verifyMsg, setVerifyMsg] = useState("");
  // 明细表的视图切换(看板的趋势/分布图用独立的 day/total 数据,不受这里影响)
  const [usageView, setUsageView] = useState<UsageView>("day");
  const [usageMode, setUsageMode] = useState<UsageMode>(() => readUsageMode());
  const [expandedUsageGroups, setExpandedUsageGroups] = useState<Set<string>>(() => new Set());
  const [usage, setUsage] = useState<UsageRow[] | null>(null);
  const [usageSettled, setUsageSettled] = useState(false);
  const [usageStatus, setUsageStatus] = useState<"loading" | "ready" | "error">("loading");
  const [usageDate, setUsageDate] = useState("");
  // 模型多选筛选:记"被取消勾选的模型",这样用量里新出现的模型天然算已勾选(默认全选)。
  const [excludedModels, setExcludedModels] = useState<ReadonlySet<string>>(() => new Set());
  // 看板专用:按天(趋势 + 近 7 天消耗)与总计(按模型分布)
  const [dayUsage, setDayUsage] = useState<UsageRow[] | null>(null);
  const [totalUsage, setTotalUsage] = useState<UsageRow[] | null>(null);
  const [docStats, setDocStats] = useState<{ docs: number; words: number } | null>(null);
  // 看板三份数据(按天 / 总计 / 文档统计)首拉是否都已 settled
  const [dashboardSettled, setDashboardSettled] = useState<{
    day: boolean;
    total: boolean;
    docs: boolean;
  }>({ day: false, total: false, docs: false });
  const [message, setMessage] = useState<string | null>(null);
  const [balance, setBalance] = useState<BalanceState | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const mountedRef = useRef(true);
  const balanceControllerRef = useRef<AbortController | null>(null);
  const customTestRevisionRef = useRef(0);
  const customTestControllerRef = useRef<AbortController | null>(null);
  const kimiVerifyRevisionRef = useRef(0);
  const kimiVerifyControllerRef = useRef<AbortController | null>(null);
  const kimiVerificationInputRef = useRef({
    provider: configProvider,
    key: keyInput.trim(),
    tier: tiers[configProvider],
  });
  const persistRevisionRef = useRef(0);
  kimiVerificationInputRef.current = {
    provider: configProvider,
    key: keyInput.trim(),
    tier: tiers[configProvider],
  };

  const invalidatePersistence = () => {
    persistRevisionRef.current += 1;
    setPersisting(false);
  };

  const invalidateKimiVerification = useCallback(() => {
    kimiVerifyRevisionRef.current += 1;
    kimiVerifyControllerRef.current?.abort();
    kimiVerifyControllerRef.current = null;
    setVerifyStatus("idle");
    setVerifyMsg("");
  }, []);

  const invalidateCustomTest = () => {
    invalidatePersistence();
    customTestRevisionRef.current += 1;
    customTestControllerRef.current?.abort();
    customTestControllerRef.current = null;
    setCustomTesting(false);
  };

  const showPersistFailure = useCallback((message = modelPersistFailureMessage()) => {
    toast.show({
      message,
      tone: "warn",
      dedupeKey: "model-persist-failure",
    });
  }, [toast]);

  const resyncPersistedModelState = useCallback((provider: ModelProvider): boolean => {
    try {
      const persisted = readPersistedModelState(provider);
      if (!persisted) return false;
      setVisitorKeys((current) => ({ ...current, [provider]: persisted.visitorKey }));
      setCustomProviders((current) => ({ ...current, [provider]: persisted.customProvider }));
      setSetupMode(persisted.customProvider ? "other" : "official");
      setCustomProtocol(
        provider === "kimi" ? "openai" : persisted.customProvider?.protocol ?? "openai",
      );
      setCustomBaseUrl(persisted.customProvider?.baseUrl ?? "");
      setCustomKey(persisted.customProvider?.apiKey ?? "");
      setCustomModelFlash(
        persisted.customProvider?.modelFlash ?? MODEL_DEFAULTS[provider].flash,
      );
      setCustomModelPro(persisted.customProvider?.modelPro ?? MODEL_DEFAULTS[provider].pro);
      setOfficialFlash(persisted.officialModel?.flash ?? "");
      setOfficialPro(persisted.officialModel?.pro ?? "");
      setKeyInput("");
      setVerifyStatus("idle");
      setVerifyMsg("");
      setMessage(null);
      return true;
    } catch {
      return false;
    }
  }, []);

  const settlePersistFailure = useCallback((
    provider: ModelProvider,
    resyncedMessage?: string,
  ) => {
    setPersisting(false);
    const resynced = resyncPersistedModelState(provider);
    showPersistFailure(resynced ? resyncedMessage : undefined);
  }, [resyncPersistedModelState, showPersistFailure]);

  // 「启 用」= 切换 modelProvider(两家配置各自保留,不互相清除)
  const handleProviderChange = async (provider: ModelProvider, silent = false) => {
    if (provider === modelProvider) return true;
    const revision = persistRevisionRef.current;
    setPersisting(true);
    const saved = await setSelectedModelProvider(provider);
    if (!mountedRef.current || persistRevisionRef.current !== revision) return false;
    setPersisting(false);
    if (!saved) {
      showPersistFailure();
      return false;
    }
    setModelProvider(provider);
    if (!silent) {
      toast.show({
        message: `已启用 ${vendorName(provider)}`,
        tone: "success",
        dedupeKey: "model-provider",
      });
    }
    return true;
  };

  // 进二级配置页:把该厂商已存的配置读进表单(与"使用中"那家无关)
  const openConfig = (provider: ModelProvider) => {
    invalidateCustomTest();
    invalidateKimiVerification();
    const custom = readCustomProvider(provider);
    const official = readOfficialModelOverride(provider);
    setConfigProvider(provider);
    setSetupMode(custom ? "other" : "official");
    setCustomProtocol(provider === "kimi" ? "openai" : custom?.protocol ?? "openai");
    setCustomBaseUrl(custom?.baseUrl ?? "");
    setCustomKey(custom?.apiKey ?? "");
    setCustomModelFlash(custom?.modelFlash ?? MODEL_DEFAULTS[provider].flash);
    setCustomModelPro(custom?.modelPro ?? MODEL_DEFAULTS[provider].pro);
    setOfficialFlash(official?.flash ?? "");
    setOfficialPro(official?.pro ?? "");
    setKeyInput("");
    setMessage(null);
    setView("config");
  };

  const closeConfig = () => {
    invalidateCustomTest();
    invalidateKimiVerification();
    setKeyInput("");
    setMessage(null);
    setView("main");
  };

  const loadServer = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/v1/settings/model", { signal });
      if (res.ok) {
        const body = (await res.json()) as ServerModelSettings;
        if (mountedRef.current && !signal?.aborted) setServer(body);
      }
    } catch {
      if (mountedRef.current && !signal?.aborted) setServer(null);
    } finally {
      if (mountedRef.current && !signal?.aborted) setServerSettled(true);
    }
  }, []);

  const loadUsage = useCallback(async (view: UsageView, signal?: AbortSignal) => {
    setUsage(null);
    setUsageStatus("loading");
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await fetch(
        `/api/v1/usage/summary?view=${view}&timeZone=${encodeURIComponent(timeZone)}`,
        { signal },
      );
      if (!res.ok) {
        if (mountedRef.current && !signal?.aborted) setUsageStatus("error");
        return;
      }
      const body = (await res.json()) as Partial<UsageSummaryResponse>;
      if (mountedRef.current && !signal?.aborted) {
        setUsage(body.rows ?? []);
        setUsageStatus("ready");
      }
    } catch {
      if (mountedRef.current && !signal?.aborted) setUsageStatus("error");
    } finally {
      if (mountedRef.current && !signal?.aborted) setUsageSettled(true);
    }
  }, []);

  // 看板用:按天 / 总计两份数据一次性拉取(图表始终展示这两份,与明细视图解耦)
  const loadDashboardUsage = useCallback(async (view: "day" | "total", signal?: AbortSignal) => {
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await fetch(
        `/api/v1/usage/summary?view=${view}&timeZone=${encodeURIComponent(timeZone)}`,
        { signal },
      );
      const rows = res.ok ? (((await res.json()) as Partial<UsageSummaryResponse>).rows ?? []) : [];
      if (mountedRef.current && !signal?.aborted) {
        if (view === "day") setDayUsage(rows);
        else setTotalUsage(rows);
      }
    } catch {
      if (mountedRef.current && !signal?.aborted) {
        if (view === "day") setDayUsage(null);
        else setTotalUsage(null);
      }
    } finally {
      if (mountedRef.current && !signal?.aborted) {
        setDashboardSettled((current) => ({ ...current, [view]: true }));
      }
    }
  }, []);

  const loadDocStats = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/v1/usage/docstats?days=7", { signal });
      const body = res.ok ? ((await res.json()) as { docs: number; words: number }) : null;
      if (mountedRef.current && !signal?.aborted) setDocStats(body);
    } catch {
      if (mountedRef.current && !signal?.aborted) setDocStats(null);
    } finally {
      if (mountedRef.current && !signal?.aborted) {
        setDashboardSettled((current) => ({ ...current, docs: true }));
      }
    }
  }, []);

  // 余额查询兼 key 有效性测试(DeepSeek /user/balance;401=key无效)。
  // 既被进入主视图时的自动 useEffect 调用,也被二级页「测试连接」手动调用。
  // keyOverride:二级页里用刚粘上、还没保存的 key 先测一把。
  const checkBalance = useCallback(async (signal?: AbortSignal, keyOverride?: string) => {
    // 手动触发时取消上一次在途请求;自动触发(传入外部 signal)时沿用调用方的 controller
    let controller = balanceControllerRef.current;
    if (!signal) {
      balanceControllerRef.current?.abort();
      controller = new AbortController();
      balanceControllerRef.current = controller;
      signal = controller.signal;
    }
    const active = controller;
    setBalanceLoading(true);
    setBalance(null);
    const canCommit = () => mountedRef.current && !signal!.aborted;
    try {
      const res = await fetch("/api/v1/settings/model/balance", {
        headers: deepseekBalanceHeaders(keyOverride),
        signal,
      });
      const body = (await res.json()) as BalanceState;
      if (canCommit()) setBalance(body);
    } catch {
      if (canCommit()) setBalance({ ok: false, error: "查询失败,请重试" });
    } finally {
      if (canCommit()) {
        if (active && balanceControllerRef.current === active) balanceControllerRef.current = null;
        setBalanceLoading(false);
      }
    }
  }, []);

  // R8-B 审计:卸载/切视图时 abort 在途请求,避免对已卸载组件 setState。
  useEffect(() => {
    const controller = new AbortController();
    void loadServer(controller.signal);
    return () => controller.abort();
  }, [loadServer]);
  useEffect(() => {
    // 本机从未选过 provider 时，设置页首开跟随 server DB/env；之后用户选择优先。
    // 旧版已有 DeepSeek 本地 key/中转/别名也属于访客显式配置，继续优先于 server。
    if (
      !server?.provider ||
      getStoredModelProvider() ||
      getVisitorModelKey("deepseek") ||
      readCustomProvider("deepseek") ||
      readOfficialModelOverride("deepseek")
    ) return;
    // server 默认厂商自己没配置时不跟随——那正是"使用中指向未配置家"非法态的病根之一。
    if (!vendorConfigured(server.provider)) return;
    void handleProviderChange(server.provider, true);
  }, [server]);
  useEffect(() => {
    const controller = new AbortController();
    void loadUsage(usageView, controller.signal);
    return () => controller.abort();
  }, [loadUsage, usageView]);
  useEffect(() => {
    // StrictMode 会 mount→unmount→remount,setup 阶段必须重置,否则 ref 残留 false 永久拦截 setState
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      balanceControllerRef.current?.abort();
      customTestRevisionRef.current += 1;
      customTestControllerRef.current?.abort();
      customTestControllerRef.current = null;
      kimiVerifyRevisionRef.current += 1;
      kimiVerifyControllerRef.current?.abort();
      kimiVerifyControllerRef.current = null;
    };
  }, []);

  // 官方 key:输入即自动验证(debounce)。只要非空就实测，不把厂商随时可能调整的格式当成拦截条件。
  useEffect(() => {
    const trimmed = keyInput.trim();
    if (!trimmed) {
      setVerifyStatus("idle");
      setVerifyMsg("");
      return;
    }
    // Kimi 连接测试会产生一次最短模型调用，禁止输入 debounce 自动触发；只允许用户点按钮。
    if (configProvider === "kimi") {
      setVerifyStatus("idle");
      setVerifyMsg("");
      return;
    }
    setVerifyStatus("verifying");
    setVerifyMsg("");
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch("/api/v1/settings/model/balance", {
            headers: {
              "x-model-provider": configProvider,
              "x-model-key": trimmed,
              ...(configProvider === "deepseek" ? { "x-deepseek-key": trimmed } : {}),
            },
            signal: ctrl.signal,
          });
          const body = (await res.json()) as BalanceState;
          if (ctrl.signal.aborted) return;
          if (body.ok) {
            setVerifyStatus("ok");
            setVerifyMsg("key 有效,已连通");
          } else if (body.keyInvalid) {
            setVerifyStatus("fail");
            setVerifyMsg("这个 Key 不正确或已失效");
          } else if (body.permissionDenied) {
            setVerifyStatus("fail");
            setVerifyMsg("Kimi 返回权限不足；请核对套餐与模型权限");
          } else {
            setVerifyStatus("fail");
            setVerifyMsg(body.error ?? "验证失败,请重试");
          }
        } catch {
          if (!ctrl.signal.aborted) {
            setVerifyStatus("fail");
            setVerifyMsg("验证失败:网络错误");
          }
        }
      })();
    }, 600);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [keyInput, configProvider]);

  // —— 每厂商各自的配置状态(visitor / 站点全局 / env / 自定义模型 四源合一)——
  const serverStateOf = (provider: ModelProvider) =>
    server?.providers?.[provider] ??
    (server?.provider === undefined || server.provider === provider ? server : null);
  const vendorConfigured = (provider: ModelProvider) =>
    Boolean(visitorKeys[provider]) ||
    Boolean(serverStateOf(provider)?.apiKeyConfigured) ||
    Boolean(customProviders[provider]);
  // 本机就能确定"已配置"的那部分(不依赖 server 首拉),用于首拉在途时先渲染确定为真的卡面
  const locallyConfigured = (provider: ModelProvider) =>
    Boolean(visitorKeys[provider]) || Boolean(customProviders[provider]);
  // server 首拉未回来前,只有本机已配置的厂商配置态是确定的;其余厂商先不渲染卡内主体,
  // 免得「去配置 / 还没有可用的模型」闪一帧再被服务端 key 顶掉。
  const vendorStateKnown = (provider: ModelProvider) =>
    serverSettled || locallyConfigured(provider);
  const customProvider = customProviders[configProvider];
  const visitorKey = visitorKeys[configProvider];
  const serverProviderState = serverStateOf(configProvider);
  const configProviderConfigured = vendorConfigured(configProvider);
  const configuredVendors = MODEL_VENDORS.filter((provider) => vendorConfigured(provider));
  const anyConfigured = configuredVendors.length > 0;
  // 「使用中」不变式:只要存在已配置的厂商,就必须恰好有一家在使用中。
  // 当前 active 那家没有有效配置时(清掉了该家 key / 旧数据残留 / server 默认指向未配置家),
  // 渲染立刻回落到有配置的那家(MODEL_VENDORS 顺序 = DeepSeek 优先),落盘由下方 effect 补。
  const effectiveProvider = vendorConfigured(modelProvider)
    ? modelProvider
    : configuredVendors[0] ?? modelProvider;
  const deepseekAutoBalance =
    view === "main" && vendorConfigured("deepseek") && !customProviders.deepseek;

  // 归一化落盘:渲染层已用 effectiveProvider 保证"恰有一家在使用中",这里把结果写回持久化,
  // 走的是与「启 用」按钮同一条通道(setSelectedModelProvider),不另造第二套写入路径。
  // 时机:面板挂载后 server 首拉 settled 时跑一次;之后任何配置变更(存/清 key、存/清自定义)
  // 改变 effectiveProvider 时再跑——两个时机都被 deps 覆盖。
  useEffect(() => {
    if (!serverSettled) return;
    if (effectiveProvider === modelProvider) return;
    void handleProviderChange(effectiveProvider, true);
    // handleProviderChange 每次渲染重建,放进 deps 会自激;它只依赖下面三个值的当前快照。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSettled, effectiveProvider, modelProvider]);

  // 主视图上 DeepSeek 卡要显示余额:进主视图自动查一次连通性 + 余额(与"使用中"哪家无关)。
  // 其他云厂商不查(DeepSeek 余额接口测不了)。
  useEffect(() => {
    if (!deepseekAutoBalance) return;
    const controller = new AbortController();
    balanceControllerRef.current = controller;
    void checkBalance(controller.signal);
    return () => {
      controller.abort();
      if (balanceControllerRef.current === controller) balanceControllerRef.current = null;
    };
  }, [deepseekAutoBalance, checkBalance, visitorKeys.deepseek]);

  const handleVerifyKimiKey = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed || verifyStatus === "verifying") return;
    const requestSnapshot = {
      provider: configProvider,
      key: trimmed,
      tier: tiers[configProvider],
    };
    kimiVerifyRevisionRef.current += 1;
    const revision = kimiVerifyRevisionRef.current;
    kimiVerifyControllerRef.current?.abort();
    const controller = new AbortController();
    kimiVerifyControllerRef.current = controller;
    const canCommit = () =>
      mountedRef.current &&
      !controller.signal.aborted &&
      kimiVerifyRevisionRef.current === revision &&
      kimiVerificationInputRef.current.provider === requestSnapshot.provider &&
      kimiVerificationInputRef.current.key === requestSnapshot.key &&
      kimiVerificationInputRef.current.tier === requestSnapshot.tier;
    setVerifyStatus("verifying");
    setVerifyMsg("");
    try {
      const res = await fetch("/api/v1/settings/model/balance", {
        headers: {
          "x-model-provider": "kimi",
          "x-model-key": trimmed,
          "x-model-tier": tiers.kimi,
        },
        signal: controller.signal,
      });
      const body = (await res.json()) as BalanceState;
      if (!canCommit()) return;
      if (body.ok) {
        setVerifyStatus("ok");
        setVerifyMsg("Kimi 短对话测试已连通");
        setKimiConnected(true);
      } else {
        setVerifyStatus("fail");
        setVerifyMsg(
          body.permissionDenied
            ? "Kimi 返回权限不足；请核对套餐与模型权限"
            : body.error ?? "验证失败,请重试",
        );
      }
    } catch {
      if (canCommit()) {
        setVerifyStatus("fail");
        setVerifyMsg("验证失败:网络错误");
      }
    } finally {
      if (canCommit()) kimiVerifyControllerRef.current = null;
    }
  };

  // 进入主视图:自动加载按天 + 总计两份用量,喂给趋势图与按模型分布。
  useEffect(() => {
    if (view !== "main") return;
    const controller = new AbortController();
    void loadDashboardUsage("day", controller.signal);
    void loadDashboardUsage("total", controller.signal);
    void loadDocStats(controller.signal);
    return () => controller.abort();
  }, [view, loadDashboardUsage, loadDocStats, visitorKeys]);

  // 验证是输入时自动做的(见上方 useEffect)。保存:验证过→直接存;没过→二次确认(可能失效)。
  const handleSave = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) {
      setMessage("请填写 API key");
      return;
    }
    if (verifyStatus !== "ok") {
      const proceed = await confirm({
        title: "仍要保存这个 key？",
        message: "这个 key 还没验证通过，保存后可能无法正常使用。",
        confirmLabel: "仍要保存",
      });
      if (!proceed) return;
    }
    const target = configProvider;
    const activeConfigured = vendorConfigured(effectiveProvider);
    const revision = persistRevisionRef.current;
    const canCommit = () => mountedRef.current && persistRevisionRef.current === revision;
    setPersisting(true);
    const savedKey = await setVisitorModelKey(target, trimmed);
    if (!canCommit()) return;
    if (!savedKey) {
      settlePersistFailure(target);
      return;
    }
    // 互斥:切回官方,清掉其他云厂商配置;写官方模型前缀覆盖(首配为空=清除,已配可改)
    const clearedCustom = await clearCustomProvider(target);
    if (!canCommit()) return;
    if (!clearedCustom) {
      settlePersistFailure(target, "key 已保存，但旧的自定义模型配置未清除，请重试");
      return;
    }
    const savedOfficialOverride = await writeOfficialModelOverride(
      { flash: officialFlash, pro: officialPro },
      target,
    );
    if (!canCommit()) return;
    setPersisting(false);
    if (!savedOfficialOverride) {
      settlePersistFailure(target, "key 已保存，但模型别名未保存，请重试");
      return;
    }
    setVisitorKeys((current) => ({ ...current, [target]: trimmed }));
    setCustomProviders((current) => ({ ...current, [target]: null }));
    setKeyInput("");
    setMessage(null);
    setView("main");
    toast.show(verifyStatus === "ok" ? "key 已验证并保存到本机" : "key 已保存到本机，尚未验证通过");
    // 原来那家还没配好时,刚配好的这家直接成为"使用中",省掉一次多余的「启 用」
    if (!activeConfigured && target !== effectiveProvider) {
      void handleProviderChange(target, true);
    }
    // 保存后回到主视图:滚到顶 + 主动查一次连通性(否则可能停在"暂时无法连接",需手动重测)
    requestAnimationFrame(() => {
      document.querySelector(".qj-sheet-body")?.scrollTo({ top: 0, behavior: "auto" });
      if (target === "deepseek") void checkBalance();
    });
  };

  const handleClearVisitor = async () => {
    // 二次确认:清除 key 是破坏性操作,误点会丢配置导致无法发起模型请求(e2e E3/E4)。
    const proceed = await confirm({
      title: "清除已保存的 API key？",
      message: "清除后如果没有其它可用配置，后续模型请求将无法发起；需重新填入 key 才能继续使用。",
      confirmLabel: "清除 key",
    });
    if (!proceed) {
      return false;
    }
    const revision = persistRevisionRef.current;
    const canCommit = () => mountedRef.current && persistRevisionRef.current === revision;
    setPersisting(true);
    const cleared = await clearVisitorModelKey(configProvider);
    if (!canCommit()) return false;
    setPersisting(false);
    if (!cleared) {
      showPersistFailure("本机配置清除失败，请重试");
      return false;
    }
    setVisitorKeys((current) => ({ ...current, [configProvider]: null }));
    if (configProvider === "kimi") setKimiConnected(false);
    setMessage("已清除已保存的 key");
    return true;
  };

  const handleClearCustom = async () => {
    const proceed = await confirm({
      title: "清除自定义模型配置？",
      message: "清除后将切回未配置状态，后续模型请求将无法发起；需重新填写接口地址与 key。",
      confirmLabel: "清除配置",
    });
    if (!proceed) {
      return false;
    }
    const revision = persistRevisionRef.current;
    const canCommit = () => mountedRef.current && persistRevisionRef.current === revision;
    setPersisting(true);
    const cleared = await clearCustomProvider(configProvider);
    if (!canCommit()) return false;
    setPersisting(false);
    if (!cleared) {
      showPersistFailure("本机配置清除失败，请重试");
      return false;
    }
    setCustomProviders((current) => ({ ...current, [configProvider]: null }));
    setMessage("已清除自定义模型配置");
    return true;
  };

  // 档位切换:每厂商各记各的,选完立即生效
  const handleModelTierChange = useCallback(async (
    provider: ModelProvider,
    tier: ModelTier,
  ) => {
    if (tier === tiers[provider]) return;
    invalidateKimiVerification();
    const revision = persistRevisionRef.current;
    setPersisting(true);
    const saved = await setSelectedModelTier(tier, provider);
    if (!mountedRef.current || persistRevisionRef.current !== revision) return;
    setPersisting(false);
    if (!saved) {
      showPersistFailure();
      return;
    }
    setTiers((current) => ({ ...current, [provider]: tier }));
    toast.show({
      message: `已切换到 ${VENDOR_META[provider].tiers[tier].name} 档`,
      tone: "success",
      dedupeKey: "model-tier",
    });
  }, [invalidateKimiVerification, showPersistFailure, tiers, toast]);

  // 其他云厂商(进阶):先调后端测试接口(代理避免 CORS),通了再保存并启用
  const handleSaveCustom = async () => {
    const target = configProvider;
    const activeConfigured = vendorConfigured(effectiveProvider);
    const rawBaseUrl = customBaseUrl.trim();
    const apiKey = customKey.trim();
    if (!rawBaseUrl || !apiKey) {
      setMessage("请填写:API 地址、API key");
      return;
    }
    // 可修复的格式错误(只漏 scheme)不再一口回绝:补 https:// 后照常去测,通了就按修复值保存。
    const baseUrl = repairBaseUrlScheme(rawBaseUrl);
    if (!baseUrl) {
      setMessage("API 地址格式不对:需以 http(s):// 开头");
      return;
    }
    const schemeRepaired = baseUrl !== rawBaseUrl;
    const modelFlash = customModelFlash.trim() || MODEL_DEFAULTS[target].flash;
    const modelPro = customModelPro.trim() || MODEL_DEFAULTS[target].pro;
    customTestControllerRef.current?.abort();
    const revision = ++customTestRevisionRef.current;
    setCustomTesting(true);
    setMessage(
      schemeRepaired
        ? `将按 ${baseUrl} 测试并保存,正在测试接口连通性…`
        : "正在测试接口连通性…",
    );
    // 超时保护:测连接打的是用户填的第三方 baseUrl,不可信(可能不通/极慢)。
    // 无 AbortController 时 fetch 会无限挂起,按钮永远卡"测试中…"=整页假死(e2e E1-h2)。
    const testCtrl = new AbortController();
    customTestControllerRef.current = testCtrl;
    const testTimer = setTimeout(() => testCtrl.abort(), 25_000);
    const persistRevision = persistRevisionRef.current;
    const canCommit = () =>
      mountedRef.current &&
      customTestRevisionRef.current === revision &&
      customTestControllerRef.current === testCtrl &&
      persistRevisionRef.current === persistRevision;
    try {
      const res = await fetch("/api/v1/settings/model/test-custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: target,
          baseUrl,
          apiKey,
          model: modelFlash,
          protocol: target === "kimi" ? "openai" : customProtocol,
        }),
        signal: testCtrl.signal,
      });
      const body = (await res.json()) as {
        ok: boolean;
        keyInvalid?: boolean;
        permissionDenied?: boolean;
        error?: string;
        // 服务端归一化后的 canonical 地址(补 /v1、剥多填的 endpoint 段、去 query/hash)
        normalizedBaseUrl?: string;
      };
      if (!canCommit()) return;
      if (!body.ok) {
        setMessage(
          body.keyInvalid
            ? "key 无效或无权限,请检查"
            : body.permissionDenied
              ? "Kimi 返回权限不足；请核对套餐与模型权限"
            : `接口不通:${body.error ?? "请检查 API 地址与 key"}`,
        );
        return;
      }
      // 存的必须是"实际会被请求的那个地址":服务端测连接用的就是它归一化后的值,
      // 前端不自造第二套归一化逻辑,直接采信服务端回传的 canonical 值(缺字段才退回本地已修复值)。
      const savedBaseUrl = body.normalizedBaseUrl?.trim() || baseUrl;
      const provider: CustomProvider = {
        protocol: target === "kimi" ? "openai" : customProtocol,
        baseUrl: savedBaseUrl,
        apiKey,
        modelFlash,
        modelPro,
      };
      setPersisting(true);
      const savedProvider = await writeCustomProvider(provider, target);
      if (!canCommit()) return;
      if (!savedProvider) {
        showPersistFailure();
        return;
      }
      // 互斥:切到其他云厂商,清官方 visitor key
      const clearedVisitorKey = await clearVisitorModelKey(target);
      if (!canCommit()) return;
      if (!clearedVisitorKey) {
        showPersistFailure("自定义模型已保存，但旧的官方 key 未清除，请重试");
        return;
      }
      setCustomProviders((current) => ({ ...current, [target]: provider }));
      setVisitorKeys((current) => ({ ...current, [target]: null }));
      // 回填:让用户看到的就是真正存下来的地址,别留着原始输入造成"存的和显示的不一样"。
      setCustomBaseUrl(savedBaseUrl);
      setMessage(null);
      setView("main");
      toast.show(
        savedBaseUrl === rawBaseUrl
          ? "接口测试通过,已保存并启用自定义模型"
          : `已自动修正为标准地址 ${savedBaseUrl},接口测试通过并已保存启用`,
      );
      if (!activeConfigured && target !== effectiveProvider) {
        void handleProviderChange(target, true);
      }
    } catch (e) {
      if (canCommit()) {
        setMessage(
          e instanceof DOMException && e.name === "AbortError"
            ? "测试超时:接口 25 秒无响应,请检查 API 地址是否可达"
            : "测试失败:网络错误,请重试",
        );
      }
    } finally {
      clearTimeout(testTimer);
      if (canCommit()) {
        customTestControllerRef.current = null;
        setCustomTesting(false);
        setPersisting(false);
      }
    }
  };

  // —— 派生数据:近 7 天消耗、按模型分布、按天趋势 ——
  const recent = useMemo(() => summarizeRecentDays(dayUsage, 7), [dayUsage]);
  const modelDist = useMemo(() => buildModelDistribution(totalUsage), [totalUsage]);
  const trend = useMemo(() => buildDailyTrend(dayUsage, 15), [dayUsage]);
  // 看板 / 明细的首拉判定:未 settled 一律不下"没有数据 / 加载失败"的结论,
  // 只有拖过 250ms 才显形一个中性「加载中…」——快请求全程无占位。
  const dashboardReady = dashboardSettled.day && dashboardSettled.total && dashboardSettled.docs;
  const showDashboardLoading = useDelayedVisible(!dashboardReady);
  const showUsageLoading = useDelayedVisible(!usageSettled);
  const todayYmd = useMemo(() => toYMD(new Date()), []);
  const usageDates = useMemo(
    () => new Set(
      (dayUsage ?? [])
        .filter((row) => row.inputTokens > 0 || row.outputTokens > 0)
        .map((row) => row.bucket),
    ),
    [dayUsage],
  );
  const visibleUsage = useMemo(() => {
    if (usage === null) return null;
    if (usageDate && usageView === "day") return usage.filter((row) => row.bucket === usageDate);
    return usage;
  }, [usage, usageDate, usageView]);
  const usageDateUnsupported = usageDate !== "" && usageView !== "day";
  // 明细卡的模型多选:选项动态取自当前视图数据里真实出现过的模型(含 DeepSeek / Kimi 各档)。
  const usageModelIds = useMemo(
    () => Array.from(new Set((usage ?? []).map((row) => row.modelId))).sort(),
    [usage],
  );
  const selectedModelIds = useMemo(
    () => usageModelIds.filter((modelId) => !excludedModels.has(modelId)),
    [usageModelIds, excludedModels],
  );
  const allModelsSelected =
    usageModelIds.length > 0 && selectedModelIds.length === usageModelIds.length;
  // 模型筛选落在明细卡内部:明细表、分组聚合、请求覆盖都跟着变成局部口径;
  // 上方用量看板是另一张卡、另一份数据源,不受这里影响。
  const filteredUsage = useMemo(() => {
    if (visibleUsage === null) return null;
    if (allModelsSelected || selectedModelIds.length === 0) return visibleUsage;
    const keep = new Set(selectedModelIds);
    return visibleUsage.filter((row) => keep.has(row.modelId));
  }, [visibleUsage, allModelsSelected, selectedModelIds]);
  const usageGroups = useMemo(
    () => filteredUsage === null ? null : buildUsageGroups(filteredUsage, usageView),
    [filteredUsage, usageView],
  );
  const toggleUsageModel = useCallback((modelId: string) => {
    setExcludedModels((current) => {
      const next = new Set(current);
      if (next.has(modelId)) {
        next.delete(modelId);
        return next;
      }
      // 至少保留一个模型:全部取消等于空表,没有意义,末一个不让取消。
      const remaining = usageModelIds.filter((id) => id !== modelId && !next.has(id));
      if (remaining.length === 0) return current;
      next.add(modelId);
      return next;
    });
  }, [usageModelIds]);
  const selectAllUsageModels = useCallback(() => setExcludedModels(new Set()), []);

  const toggleUsageMode = () => {
    const nextMode: UsageMode = usageMode === "simple" ? "expert" : "simple";
    setUsageMode(nextMode);
    setExpandedUsageGroups(new Set());
    persistUsageMode(nextMode);
  };

  const switchUsageView = (nextView: UsageView) => {
    if (nextView === usageView) return;
    // 点击当帧先撤掉旧口径数据，避免 effect 发起新请求前按新视图解释旧 rows。
    setUsage(null);
    setUsageStatus("loading");
    setExpandedUsageGroups(new Set());
    setUsageView(nextView);
  };

  const toggleUsageGroup = (key: string) => {
    setExpandedUsageGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // —— 连通性状态:自动 checkBalance 结果 → 色点 + 文案 ——
  // 首次探测通常几十毫秒就回来,「正在检测连接…」一闪而过反而像抖动;
  // 250ms 内先按中性「已配置」显示,超过 250ms 才显形为检测中。
  const showConnectivityProbe = useDelayedVisible(balance === null || balanceLoading);
  const deepseekStatus = deriveConnectivity(
    balance,
    balanceLoading,
    "deepseek",
    showConnectivityProbe,
  );
  const balanceVal = balance?.ok ? balance.balances?.[0] : undefined;
  const lowBalance = balanceVal != null && balance?.isAvailable === false;

  // —— 4 指标派生:平均每篇花费 / 每 10 元可建 / 余额预估还可建 ——
  const cost7 = recent?.cost ?? 0;
  const docs7 = docStats?.docs ?? 0;
  const words7 = docStats?.words ?? 0;
  const avgPerDoc = docs7 > 0 && cost7 > 0 ? cost7 / docs7 : null;
  const docsPer10 = avgPerDoc != null ? 10 / avgPerDoc : null;
  const balanceNum = balanceVal ? Number(balanceVal.total) : null;
  const estDocs = avgPerDoc != null && balanceNum != null ? balanceNum / avgPerDoc : null;

  // 官方 DeepSeek key 表单(未配置态官方 tab 与 editing 态共用)。配置只存本机,无 scope 选择。
  const keyFormatOk = keyInput.trim() === "" ? null : true;
  // 只漏 scheme 属于"可修复",不判非法(点击时会补 https:// 再测),否则按钮被禁死、修复无从发生。
  const customBaseUrlValid =
    customBaseUrl.trim() === "" ? null : repairBaseUrlScheme(customBaseUrl.trim()) !== null;
  const officialKeyForm = (
    <>
      <div className="sm-keyrow">
        <SecretInput
          autoComplete="off"
          spellCheck={false}
          className="sm-keyinput"
          placeholder={configProvider === "kimi" ? "粘贴 Kimi API key" : "粘贴 DeepSeek API key(sk-…)"}
          value={keyInput}
          disabled={persisting}
          onChange={(e) => {
            invalidatePersistence();
            invalidateKimiVerification();
            setKeyInput(e.target.value);
          }}
          data-wf="ModelKeyInput"
        />
        <button
          type="button"
          className="sm-btn"
          onClick={() => void handleSave()}
          disabled={persisting || !keyInput.trim()}
          title={!keyInput.trim() ? "请先填入 API key" : undefined}
        >
          保存
        </button>
        {configProvider === "kimi" ? (
          <button
            type="button"
            className="sm-btn"
            onClick={() => void handleVerifyKimiKey()}
            disabled={persisting || verifyStatus === "verifying" || !keyInput.trim()}
            title="发起 Kimi 请求"
            data-wf="KimiVerifyBtn"
          >
            {verifyStatus === "verifying" ? "测试中…" : "测试连接"}
          </button>
        ) : (
          /* DeepSeek:「重新检测」与「测试连接」合并成一个动作——
             填了新 key 就测新 key,没填就重测已保存的配置。 */
          <button
            type="button"
            className="sm-btn"
            onClick={() => void checkBalance(undefined, keyInput.trim() || undefined)}
            disabled={persisting || balanceLoading || (!keyInput.trim() && !configProviderConfigured)}
            title="查询 DeepSeek 连通性与余额"
            data-wf="BalanceCheckBtn"
          >
            {balanceLoading ? "检测中…" : "测试连接"}
          </button>
        )}
        <button
          type="button"
          className="sm-btn"
          onClick={closeConfig}
          disabled={persisting}
        >
          取消
        </button>
      </div>
      {keyFormatOk && verifyStatus === "verifying" && <p className="sm-verify sm-verify--ing">正在验证 key…</p>}
      {verifyStatus === "ok" && (
        <p className="sm-verify sm-verify--ok">
          <span className="md-dot md-dot--ok" aria-hidden="true" />
          {verifyMsg}
        </p>
      )}
      {verifyStatus === "fail" && (
        <p className="sm-verify sm-verify--fail">
          <span className="md-dot md-dot--bad" aria-hidden="true" />
          {verifyMsg}
        </p>
      )}
      {configProviderConfigured && configProvider === "deepseek" && (
        <div className="sm-model-prefix">
          <div className="sm-field">
            <span className="sm-field-label">V4 Flash 模型名（一般无需修改）</span>
            <input
              className="sm-field-input"
              placeholder="deepseek-v4-flash"
              value={officialFlash}
              disabled={persisting}
              onChange={(e) => {
                invalidatePersistence();
                setOfficialFlash(e.target.value);
              }}
            />
          </div>
          <div className="sm-field">
            <span className="sm-field-label">V4 PRO 模型名</span>
            <input
              className="sm-field-input"
              placeholder="deepseek-v4-pro"
              value={officialPro}
              disabled={persisting}
              onChange={(e) => {
                invalidatePersistence();
                setOfficialPro(e.target.value);
              }}
            />
          </div>
          <p className="sm-keyhint">留空即用官方默认模型名;仅当官方升级换名导致报错时才需要改。</p>
        </div>
      )}
      <p className="sm-keyhint">Key 只保存在本机，用于发起模型请求。</p>
    </>
  );

  // 配置编辑器(官方 / 其他厂商两 tab):二级页主体。
  // 未配置的厂商显示官方注册步骤;已配置的厂商改显示模型名前缀与清除入口。
  const configSection = (
    <div className="sm-config">
      <div className="sm-faq-q">
        {configProviderConfigured
          ? `切换 / 修改模型配置 · ${vendorName(configProvider)}`
          : `如何配置 ${vendorName(configProvider)}?`}
      </div>
      <div className="sm-setup-tabs" role="tablist" aria-label="配置方式">
        <button
          type="button"
          role="tab"
          aria-selected={setupMode === "official"}
          className={`sm-setup-tab${setupMode === "official" ? " sm-active" : ""}`}
          onClick={() => {
            invalidateCustomTest();
            setSetupMode("official");
          }}
          disabled={persisting}
        >
          <span>接入 {vendorName(configProvider)} 官方 API</span>
          <small>推荐方式（步骤简单）</small>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={setupMode === "other"}
          className={`sm-setup-tab${setupMode === "other" ? " sm-active" : ""}`}
          onClick={() => {
            invalidateCustomTest();
            setSetupMode("other");
          }}
          disabled={persisting}
        >
          <span>接入其他云厂商 / 模型</span>
          <small>进阶设置</small>
        </button>
      </div>

      {setupMode === "official" ? (
        <div className="sm-official">
          {!configProviderConfigured && (
            <ol className="sm-steps">
              <li>
                前往{" "}
                <a
                  href={configProvider === "kimi" ? "https://www.kimi.com/code" : "https://platform.deepseek.com/"}
                  target="_blank"
                  rel="noreferrer"
                >
                  {configProvider === "kimi" ? "Kimi Code" : "platform.deepseek.com"}
                </a>{" "}
                完成注册登录
              </li>
              <li>{configProvider === "kimi" ? "确认套餐已开通 K3 / K2.7 Code 权限" : "可先小额充值试用"}</li>
              <li>
                创建并复制 API key
              </li>
              <li>粘贴到下方输入框,点保存</li>
            </ol>
          )}
          {officialKeyForm}
        </div>
      ) : (
        <div className="sm-other">
          <p className="sm-other-note">
            接入任意兼容 OpenAI 协议的云厂商或自部署模型。<strong>进阶操作</strong>,不熟悉请用官方 API。
          </p>
          <div className="sm-field">
            <span className="sm-field-label">API 协议类型</span>
            <SkinSelect
              className="sm-field-select"
              value={configProvider === "kimi" ? "openai" : customProtocol}
              disabled={persisting || configProvider === "kimi"}
              ariaLabel="API 协议类型"
              skin="ink"
              options={[
                { value: "openai", label: "OpenAI 兼容" },
                ...(configProvider === "deepseek"
                  ? [{ value: "anthropic", label: "Anthropic 兼容" }]
                  : []),
              ]}
              onChange={(value) => {
                invalidateCustomTest();
                setCustomProtocol(value);
              }}
            />
          </div>
          <div className="sm-field">
            <span className="sm-field-label">API 地址(Base URL)</span>
            <input
              className={`sm-field-input${customBaseUrlValid === false ? " sm-field-input--invalid" : ""}`}
              placeholder="https://your-endpoint/v1"
              value={customBaseUrl}
              disabled={persisting}
              aria-invalid={customBaseUrlValid === false}
              aria-describedby={customBaseUrlValid === false ? "model-custom-base-url-error" : undefined}
              onChange={(e) => {
                invalidateCustomTest();
                setCustomBaseUrl(e.target.value);
              }}
            />
            {customBaseUrlValid === false && (
              <p className="sm-field-err" id="model-custom-base-url-error">
                请输入完整地址,需以 http(s):// 开头,如 https://your-endpoint/v1
              </p>
            )}
          </div>
          <div className="sm-field">
            <span className="sm-field-label">API key</span>
            <SecretInput
              autoComplete="off"
              spellCheck={false}
              className="sm-field-input"
              placeholder="sk-…"
              value={customKey}
              disabled={persisting}
              onChange={(e) => {
                invalidateCustomTest();
                setCustomKey(e.target.value);
              }}
            />
          </div>
          <div className="sm-field">
            <span className="sm-field-label">
              {configProvider === "kimi" ? "K2.7 Code（Flash）模型别名" : "V4 Flash 模型别名(可选)"}
            </span>
            <input
              className="sm-field-input"
              placeholder={MODEL_DEFAULTS[configProvider].flash}
              value={customModelFlash}
              disabled={persisting}
              onChange={(e) => {
                invalidateCustomTest();
                setCustomModelFlash(e.target.value);
              }}
            />
          </div>
          <div className="sm-field">
            <span className="sm-field-label">
              {configProvider === "kimi" ? "K3（Pro）模型别名" : "V4 PRO 模型别名(可选)"}
            </span>
            <input
              className="sm-field-input"
              placeholder={MODEL_DEFAULTS[configProvider].pro}
              value={customModelPro}
              disabled={persisting}
              onChange={(e) => {
                invalidateCustomTest();
                setCustomModelPro(e.target.value);
              }}
            />
          </div>
          <p className="sm-other-note">
            {configProvider === "kimi"
              ? "档位固定映射 Flash → kimi-for-coding、Pro → k3；第三方中转别名不同时可在上方修改。"
              : "默认适配 DeepSeek 模型。其他模型可在上面改成对应别名自行尝试(效果不保证);两者留空则默认用 deepseek-v4-flash。"}
          </p>
          <button
            type="button"
            className="sm-btn"
            onClick={() => void handleSaveCustom()}
            // baseURL 非法(非空但格式错)时 proactive 禁用,别等点击才报错——更早阻止无效提交(e2e #15增强)。
            // 空值仍可点(handleSaveCustom 给"请填写 API 地址"就近提示)。
            disabled={customTesting || persisting || customBaseUrlValid === false}
            aria-disabled={customTesting || persisting || customBaseUrlValid === false}
            title={customBaseUrlValid === false ? "需以 http(s):// 开头" : undefined}
          >
            {customTesting ? "测试中…" : "测试并保存"}
          </button>
        </div>
      )}
    </div>
  );

  // 二级页里的 key 概览:不再外露"本机 / 站点全局 / 环境变量"分层,统一「已配置密钥」语义。
  const keySourceLabel = customProvider ? "自定义模型" : "已配置密钥";
  const keySourceDetail = customProvider
    ? customProvider.baseUrl
    : visitorKey
      ? maskKey(visitorKey)
      : serverProviderState?.maskedTail
        ? `••••${serverProviderState.maskedTail}`
        : "";

  // —— 厂商卡:一个强调信号(金描边 + 卡底金面「使用中」)+ 一个主动作 ——
  const renderVendorCard = (provider: ModelProvider) => {
    const meta = VENDOR_META[provider];
    const wf = providerWfKey(provider);
    const stateKnown = vendorStateKnown(provider);
    const configuredVendor = vendorConfigured(provider);
    // 使用中按 effectiveProvider 判定:配置了模型却没有任何一家在使用是非法态,
    // 只配了一家时那家必然「使用中」,不会出现无处可切的「启 用」按钮。
    const isActive = configuredVendor && effectiveProvider === provider;
    const vendorCustom = customProviders[provider];
    const balanceText = balanceVal
      ? balanceVal.currency === "CNY"
        ? fmtMoney(Number(balanceVal.total))
        : `${balanceVal.currency} ${Number(balanceVal.total).toFixed(2)}`
      : null;
    // 卡内状态行:DeepSeek 走自动余额检测;Kimi 无余额体系,连通只在二级页手动测。
    const cardStatus = vendorCustom
      ? { tone: "ok" as const, text: "已接入自定义模型" }
      : provider === "deepseek"
        ? deepseekStatus
        : { tone: "ok" as const, text: kimiConnected ? "已连通" : "已配置" };

    return (
      <div
        key={provider}
        className={`md-card vd-card${isActive ? " vd-card--on" : ""}`}
        data-wf={`ModelVendorCard${wf}`}
        aria-busy={stateKnown ? undefined : true}
      >
        <div className="vd-head">
          <img
            className={`vd-logo${meta.logoBoxed ? " vd-logo--boxed" : ""}`}
            src={meta.logo}
            alt=""
            aria-hidden="true"
          />
          <span className="md-card-title">{meta.name}</span>
          {!stateKnown ? null : configuredVendor ? (
            <ModelTierChip
              provider={provider}
              tier={tiers[provider]}
              disabled={persisting}
              onChange={(tier) => void handleModelTierChange(provider, tier)}
            />
          ) : meta.recommended ? (
            <i className="sk-card-tag">推 荐</i>
          ) : null}
        </div>

        {/* server 首拉未回来且本机也判不出配置态时,卡内主体先留空——
            宁可空 30ms,也不闪一帧「去配置 / 未配置介绍」再被服务端 key 顶掉。 */}
        {!stateKnown ? null : configuredVendor ? (
          <>
            <div className="md-status-row">
              <span className={`md-dot md-dot--${cardStatus.tone}`} aria-hidden="true" />
              <span className="md-status-text">
                {cardStatus.text}
                {meta.hasBalance && !vendorCustom && balanceText ? (
                  <>
                    {" · 余额 "}
                    <span className="font-mono">{balanceText}</span>
                  </>
                ) : null}
              </span>
            </div>
            {meta.hasBalance && !vendorCustom && lowBalance && (
              <span className="md-metric-warn">
                <span className="md-dot md-dot--warn" aria-hidden="true" />
                余额偏低，建议及时充值
              </span>
            )}
            {meta.hasBalance && !vendorCustom && estDocs != null && (
              <span className="vd-note">按当前均价,余额约还能写 {Math.floor(estDocs)} 篇</span>
            )}
          </>
        ) : (
          <p className="vd-intro">{VENDOR_INTRO[provider]}</p>
        )}

        {!stateKnown ? null : configuredVendor ? (
          isActive ? (
            <button
              type="button"
              className="sm-btn vd-cta vd-cta--using"
              disabled
              data-wf={`ModelUsing${wf}`}
            >
              使用中
            </button>
          ) : (
            <button
              type="button"
              className="sm-btn vd-cta"
              onClick={() => void handleProviderChange(provider)}
              disabled={persisting}
              data-wf={`ModelEnable${wf}`}
            >
              启 用
            </button>
          )
        ) : (
          <button
            type="button"
            className={`sm-btn vd-cta${meta.recommended ? " vd-cta--rec" : ""}`}
            onClick={() => openConfig(provider)}
            disabled={persisting}
            data-wf={`ModelConfig${wf}`}
          >
            去配置
          </button>
        )}

        {stateKnown && configuredVendor && (
          <span className="md-keyops vd-cfg">
            <button
              type="button"
              className="md-mini-btn"
              onClick={() => openConfig(provider)}
              disabled={persisting}
              data-wf={`ModelConfig${wf}`}
            >
              配 置
            </button>
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="settings-model" data-wf="ModelSettingsPanel">
      {view === "config" ? (
        /* —— 二级配置页:同弹层内的视图切换,现「切换 / 修改模型配置」全套元素平移 —— */
        <section className="sm-setup vd-subpage" data-wf="ModelConfigPage">
          <div className="sm-guide">
            <button
              type="button"
              className="sm-back"
              onClick={closeConfig}
              disabled={persisting}
              data-wf="ModelConfigBack"
            >
              ← 返回
            </button>
            {!anyConfigured && (
              <div className="sm-faq">
                <div className="sm-faq-item">
                  <div className="sm-faq-q">青简是什么?</div>
                  <p className="sm-faq-a">
                    青简是一款<strong>免费、开源</strong>的中文写作工具，能搜索资料、读取网页、解析文件，帮你完成各类文稿写作。
                  </p>
                </div>
                <div className="sm-faq-item">
                  <div className="sm-faq-q">数据会存储在哪里?</div>
                  <p className="sm-faq-a">
                    青简是<strong>本地软件</strong>，你的文档和对话数据保存在本机；使用模型或联网功能时，相关内容会发送给你配置的服务处理。
                  </p>
                </div>
                <div className="sm-faq-item">
                  <div className="sm-faq-q">如何收费?</div>
                  <p className="sm-faq-a">
                    青简<strong>本身不收基础费用</strong>；使用模型服务时，费用按模型服务商的账单计算。
                  </p>
                </div>
              </div>
            )}
            {configProviderConfigured && (
              <div className="vd-keyline">
                <span className="md-keysrc">
                  当前使用 <strong>{keySourceLabel}</strong>
                  {keySourceDetail ? (
                    <>
                      {" · "}
                      <span className="md-keysrc-detail font-mono" title={keySourceDetail}>
                        {keySourceDetail}
                      </span>
                    </>
                  ) : null}
                </span>
                <span className="md-keyops">
                  {visitorKey && (
                    <button
                      type="button"
                      className="md-mini-btn"
                      onClick={() => void handleClearVisitor()}
                      disabled={persisting}
                      data-wf="ModelClearKey"
                    >
                      清除密钥
                    </button>
                  )}
                  {customProvider && (
                    <button
                      type="button"
                      className="md-mini-btn"
                      onClick={() => void handleClearCustom()}
                      disabled={persisting}
                      data-wf="ModelClearCustom"
                    >
                      清除自定义配置
                    </button>
                  )}
                </span>
              </div>
            )}
            {configSection}
          </div>
          {message && <p className="sm-message">{message}</p>}
        </section>
      ) : (
        <section className="sm-configured">
          {/* 「还没有可用的模型」只在 server 首拉 settled 后才敢下结论——
              否则站点全局 / env 配的 key 还没回来就先闪一条错误引导(真机闪帧实证)。 */}
          {serverSettled && !anyConfigured && (
            <div className="vd-onboard" data-wf="ModelOnboardHint">
              还没有可用的模型。<b>推荐先接 DeepSeek</b>——写作最便宜;需要模型看图再接 Kimi。配置任意一家即可开始写作。
            </div>
          )}

          <div className="vd-grid" data-wf="ModelVendorCards">
            {MODEL_VENDORS.map((provider) => renderVendorCard(provider))}
          </div>
          {/* —— 用量看板:三瓦片 + 按模型分布 + 按天趋势 —— */}
          <div className="md-card md-usage">
            <h3 className="md-card-title">用量看板</h3>
            <div className="md-metrics md-metrics--3">
              <div className="md-metric">
                <div className="md-metric-label">近 7 天花费</div>
                <div className="md-metric-value md-value-accent font-mono">
                  {recent?.hasPriced
                    ? <AnimatedNumber value={recent.cost} format={fmtMoney} />
                    : "—"}
                </div>
                <div className="md-metric-sub">
                  {!dashboardReady ? PENDING_SUB : recent ? `${formatTokens(recent.tokens)} tokens` : "暂无记录"}
                </div>
              </div>

              <div className="md-metric">
                <div className="md-metric-label">近 7 天产出</div>
                <div className="md-metric-value font-mono">
                  {docStats ? <AnimatedNumber value={docs7} format={(n) => `${Math.round(n)} 篇`} /> : "—"}
                </div>
                <div className="md-metric-sub">
                  {!dashboardReady ? PENDING_SUB : docStats ? fmtWords(words7) : "暂无记录"}
                </div>
              </div>

              <div className="md-metric">
                <div className="md-metric-label">平均每篇</div>
                <div className="md-metric-value font-mono">
                  {avgPerDoc != null ? <AnimatedNumber value={avgPerDoc} format={fmtMoney} /> : "—"}
                </div>
                <div className="md-metric-sub">
                  {!dashboardReady
                    ? PENDING_SUB
                    : docsPer10 != null
                      ? `每 10 元约可写 ${Math.floor(docsPer10)} 篇`
                      : "需有消耗与文档"}
                </div>
              </div>
            </div>

            <div className="md-row">
              <div className="md-block md-col">
                <div className="md-block-head">
                  <span className="md-block-title">按模型分布</span>
                  <span className="md-block-sub">累计费用占比</span>
                </div>
                {!dashboardReady ? (
                  showDashboardLoading ? <p className="md-empty">加载中…</p> : null
                ) : modelDist === null ? (
                  <p className="md-empty">加载失败或暂不可用</p>
                ) : modelDist.length === 0 ? (
                  <p className="md-empty">还没有用量记录,对话后出现</p>
                ) : (
                  <div className="md-pie-wrap">
                    <div className="md-pie" style={{ background: pieGradient(modelDist) }} aria-hidden="true" />
                    <ul className="md-pie-legend">
                      {modelDist.map((m, i) => (
                        <li
                          className="md-legend-item"
                          key={m.name}
                          title={`${formatTokens(m.tokens)} tokens`}
                        >
                          <span className="md-legend-dot" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                          <span className="md-legend-name">{m.name}</span>
                          <span className="md-legend-num">
                            {m.pct.toFixed(0)}% · <span className="md-model-cost">{fmtMoney(m.cost)}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="md-block md-col">
                <div className="md-block-head">
                  <span className="md-block-title">按天趋势</span>
                  <span className="md-block-sub">近 {trend?.days.length ?? 15} 天</span>
                </div>
                {!dashboardReady ? (
                  showDashboardLoading ? <p className="md-empty">加载中…</p> : null
                ) : trend === null ? (
                  <p className="md-empty">加载失败或暂不可用</p>
                ) : trend.days.length === 0 ? (
                  <p className="md-empty">还没有用量记录,对话后出现</p>
                ) : (
                  <>
                    <div className="md-trend">
                      {trend.days.map((d, i) => {
                        const h = trend.max > 0 ? Math.round((d.cost / trend.max) * 100) : 0;
                        const title = `${d.date} · ¥${d.cost.toFixed(3)} · ${formatTokens(d.tokens)} tokens`;
                        return (
                          <div className="md-trend-col" key={d.date} title={title} aria-label={title}>
                            <div
                              className={`md-trend-bar${d.cost > 0 ? "" : " md-trend-bar--empty"}`}
                              style={{ height: d.cost > 0 ? `${Math.max(4, h)}%` : "2px", animationDelay: `${i * 25}ms` }}
                            />
                          </div>
                        );
                      })}
                    </div>
                    <div className="md-trend-axis">
                      <span>{trend.days[0]?.label}</span>
                      <span>{trend.days[trend.days.length - 1]?.label}</span>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* —— 用量明细:单独卡片,筛选器在右上 —— */}
          <div className="md-card md-detail-card">
            <div className="md-block-head">
              <button
                type="button"
                className="md-usage-mode-toggle"
                aria-label={`用量明细，当前${usageMode === "expert" ? "专家" : "小白"}模式，点击切换`}
                aria-pressed={usageMode === "expert"}
                onClick={toggleUsageMode}
                data-wf="UsageModeToggle"
              >
                <span className="md-card-title">用量明细</span>
              </button>
              <span className="md-detail-filters">
                {/* 日期只对「按天」有意义:按文档 / 总计是服务端聚合结果,整控件隐藏。
                    清除语义并入日历浮层内部的「清除日期」,头部不再另放清除钮。 */}
                {usageView === "day" && (
                  <span className="md-date-filter" data-wf="UsageDateFilter">
                    <CalendarDatePicker
                      value={usageDate}
                      max={todayYmd}
                      markedDates={usageDates}
                      onlyMarkedDatesSelectable
                      title="仅筛选已加载的按天用量"
                      ariaLabel="筛选用量日期"
                      skin="ink"
                      onChange={setUsageDate}
                    />
                  </span>
                )}
                {/* 模型多选:选项动态取自统计里出现过的模型,默认全选,三种视图都保留 */}
                <SkinMultiSelect
                  className="md-model-filter"
                  ariaLabel="筛选用量模型"
                  skin="ink"
                  allLabel="全部"
                  disabled={usageModelIds.length === 0}
                  options={usageModelIds.map((modelId) => ({
                    value: modelId,
                    label: modelLabel(modelId),
                  }))}
                  selected={selectedModelIds}
                  onToggle={toggleUsageModel}
                  onSelectAll={selectAllUsageModels}
                  summaryLabel={
                    allModelsSelected || usageModelIds.length === 0
                      ? "全部"
                      : `${selectedModelIds.length} 个模型`
                  }
                  dataWf="UsageModelFilter"
                />
                <span className="md-views md-views--right">
                  {(["day", "session", "total"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={usageView === v}
                      className={`md-view-btn${usageView === v ? " md-active" : ""}`}
                      onClick={() => switchUsageView(v)}
                    >
                      {v === "day" ? "按天" : v === "session" ? "按文档" : "总计"}
                    </button>
                  ))}
                </span>
              </span>
              </div>
              {usageDateUnsupported && (
                <p className="md-filter-note">日期筛选仅支持按天视图;按文档和总计是服务端聚合结果,不会按日期裁剪。</p>
              )}
              {!usageSettled ? (
                showUsageLoading ? <p className="md-empty">加载中…</p> : null
              ) : usageStatus === "loading" ? (
                <p className="md-empty">正在加载用量数据</p>
              ) : usageStatus === "error" || filteredUsage === null ? (
                <p className="md-empty">用量数据暂时无法加载，请稍后重试</p>
              ) : usageGroups?.length === 0 ? (
                <p className="md-empty">
                  {usageDate && usageView === "day"
                    ? "该日期暂无用量记录"
                    : allModelsSelected || usageModelIds.length === 0
                      ? "还没有用量记录,开始一次对话后这里会出现消耗明细"
                      : "所选模型暂无用量记录"}
                </p>
              ) : (
                <div className="md-table-scroll">
                  <table className={`md-table md-table--${usageMode}`} data-wf="UsageDetailTable">
                  <thead>
                    <tr>
                      <th>
                        <span className="md-th-label">
                          {usageView === "day" ? "日期" : usageView === "session" ? "文档" : "范围"}
                          <HelpMark label="范围" text="当前行统计覆盖的日期、文档或总计范围。" />
                        </span>
                      </th>
                      {usageMode === "expert" && (
                        <th>
                          <span className="md-th-label">
                            模型
                            <HelpMark label="模型" text="按模型名聚合后的用量分组。" />
                          </span>
                        </th>
                      )}
                      {usageMode === "expert" && (
                        <>
                          <th>
                            <span className="md-th-label">
                              调用点
                              <HelpMark label="调用点" text="产生这笔模型请求的功能入口；missing 请求也计入该组调用数和覆盖率。" />
                            </span>
                          </th>
                          <th>
                            <span className="md-th-label">
                              请求覆盖
                              <HelpMark label="请求覆盖" text="有 usage 的请求数 / 全部真实请求数；缺失请求仍计入分母。" />
                            </span>
                          </th>
                        </>
                      )}
                      <th>
                        <span className="md-th-label">
                          输入
                          <HelpMark label="输入 token" text="该范围内发送给模型的输入 token 总量。" />
                        </span>
                      </th>
                      <th>
                        <span className="md-th-label">
                          输出
                          <HelpMark label="输出 token" text="该范围内模型生成的输出 token 总量。" />
                        </span>
                      </th>
                      <th>
                        <span className="md-th-label">
                          缓存命中率
                          <HelpMark label="缓存命中率" text="命中缓存的输入 token 占总输入的比例;命中部分通常按更低单价估算。" />
                        </span>
                      </th>
                      <th>
                        <span className="md-th-label">
                          估算费用
                          <HelpMark label="估算费用" text="按各厂商已核实的公开单价估算；未收录价目的自定义模型只记 token。" />
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageGroups?.flatMap((group) => {
                      const isExpanded = expandedUsageGroups.has(group.key);
                      const groupRow = (
                        <UsageTableRow
                          key={group.key}
                          row={group.summary}
                          label={group.label}
                          mode={usageMode}
                          kind="group"
                          expanded={isExpanded}
                          childCount={new Set(group.rows.map((row) => row.callSite)).size}
                          onToggle={() => toggleUsageGroup(group.key)}
                        />
                      );
                      if (usageMode === "simple" || !isExpanded) return [groupRow];
                      if (usageView === "day" && group.children) {
                        return [
                          groupRow,
                          ...group.children.flatMap((documentGroup) => {
                            const isDocumentExpanded = expandedUsageGroups.has(documentGroup.key);
                            const documentRow = (
                              <UsageTableRow
                                key={documentGroup.key}
                                row={documentGroup.summary}
                                label={documentGroup.label}
                                mode={usageMode}
                                kind="document"
                                expanded={isDocumentExpanded}
                                childCount={new Set(documentGroup.rows.map((row) => row.callSite)).size}
                                onToggle={() => toggleUsageGroup(documentGroup.key)}
                              />
                            );
                            if (!isDocumentExpanded) return [documentRow];
                            return [
                              documentRow,
                              ...documentGroup.rows.map((row, index) => (
                                <UsageTableRow
                                  key={`${documentGroup.key}:${row.callSite}:${row.modelId}:${index}`}
                                  row={row}
                                  label=""
                                  mode={usageMode}
                                  kind="detail"
                                />
                              )),
                            ];
                          }),
                        ];
                      }
                      return [
                        groupRow,
                        ...group.rows.map((row, index) => (
                          <UsageTableRow
                            key={`${group.key}:${row.callSite}:${row.modelId}:${index}`}
                            row={row}
                            label=""
                            mode={usageMode}
                            kind="detail"
                          />
                        )),
                      ];
                    })}
                  </tbody>
                  </table>
                </div>
              )}
            <p className="md-foot-note">费用按各厂商已核实的公开单价估算；未收录价目的自定义模型只记录 token，不估算金额。</p>
          </div>
        </section>
      )}
    </div>
  );
}

interface UsageGroup {
  key: string;
  label: string;
  rows: UsageRow[];
  summary: UsageRow;
  children?: UsageGroup[];
}

function readUsageMode(): UsageMode {
  if (typeof window === "undefined") return "simple";
  try {
    return window.localStorage.getItem(USAGE_MODE_STORAGE_KEY) === "expert" ? "expert" : "simple";
  } catch {
    return "simple";
  }
}

function persistUsageMode(mode: UsageMode): void {
  try {
    window.localStorage.setItem(USAGE_MODE_STORAGE_KEY, mode);
  } catch {
    // 浏览器禁用存储时仍允许本次会话内切换，不用 toast 打断查看。
  }
}

function buildUsageGroups(rows: UsageRow[], view: UsageView): UsageGroup[] {
  const buckets = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const key = view === "total" ? "total" : row.bucket;
    const bucketRows = buckets.get(key);
    if (bucketRows) bucketRows.push(row);
    else buckets.set(key, [row]);
  }

  return Array.from(buckets, ([key, bucketRows]) => {
    const groupKey = `${view}:${key}`;
    return {
      key: groupKey,
      label: view === "session"
        ? bucketRows.find((row) => row.label)?.label || "未命名草稿"
        : view === "total"
          ? "全部用量"
          : key,
      rows: bucketRows,
      summary: aggregateUsageRows(key, bucketRows),
      ...(view === "day"
        ? { children: buildDayDocumentGroups(groupKey, bucketRows) }
        : {}),
    };
  });
}

function buildDayDocumentGroups(dayKey: string, rows: UsageRow[]): UsageGroup[] {
  const documents = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const key = row.documentId ?? `legacy:${row.documentTitle ?? "unknown"}`;
    const documentRows = documents.get(key);
    if (documentRows) documentRows.push(row);
    else documents.set(key, [row]);
  }
  return Array.from(documents, ([documentId, documentRows]) => ({
    key: `${dayKey}:document:${documentId}`,
    label: documentRows.find((row) => row.documentTitle)?.documentTitle || "未命名草稿",
    rows: documentRows,
    summary: aggregateUsageRows(documentRows[0]?.bucket ?? "", documentRows),
  }));
}

function aggregateUsageRows(bucket: string, rows: UsageRow[]): UsageRow {
  const sum = (select: (row: UsageRow) => number) =>
    rows.reduce((total, row) => total + select(row), 0);
  const knownCacheRows = rows.filter((row) => row.cacheHitRate !== null);
  const cacheHitTokens = sum((row) => row.cacheHitTokens);
  const cacheMissTokens = sum((row) => row.cacheMissTokens);
  const knownCacheTotal = knownCacheRows.reduce(
    (total, row) => total + row.cacheHitTokens + row.cacheMissTokens,
    0,
  );
  const calls = sum((row) => row.calls);
  const recordedCalls = sum((row) => row.recordedCalls);
  const models = new Set(rows.map((row) => row.modelId));
  const pricedRows = rows.filter((row) => row.costCny !== undefined);

  return {
    bucket,
    label: rows.find((row) => row.label)?.label,
    callSite: "",
    modelId: models.size === 1 ? rows[0]?.modelId ?? "" : "__multiple__",
    inputTokens: sum((row) => row.inputTokens),
    outputTokens: sum((row) => row.outputTokens),
    cacheHitTokens,
    cacheMissTokens,
    cacheCreationTokens: sum((row) => row.cacheCreationTokens),
    cacheHitRate: knownCacheTotal > 0
      ? knownCacheRows.reduce((total, row) => total + row.cacheHitTokens, 0) / knownCacheTotal
      : null,
    calls,
    recordedCalls,
    missingCalls: sum((row) => row.missingCalls),
    coverageRate: calls > 0 ? recordedCalls / calls : 0,
    ...(pricedRows.length > 0
      ? { costCny: pricedRows.reduce((total, row) => total + (row.costCny ?? 0), 0) }
      : {}),
  };
}

function UsageTableRow({
  row,
  label,
  mode,
  kind,
  expanded = false,
  childCount = 0,
  onToggle,
}: {
  row: UsageRow;
  label: string;
  mode: UsageMode;
  kind: "group" | "document" | "detail";
  expanded?: boolean;
  childCount?: number;
  onToggle?: () => void;
}) {
  const hitRate = row.cacheHitRate == null ? null : Math.round(row.cacheHitRate * 100);
  const isExpandable = mode === "expert" && kind !== "detail";
  const rowClass = kind === "detail"
    ? "md-usage-detail-row"
    : kind === "document"
      ? "md-usage-document-row"
      : "md-usage-group-row";
  const dataWf = kind === "detail"
    ? "UsageDetailRow"
    : kind === "document"
      ? "UsageDocumentRow"
      : "UsageGroupRow";

  return (
    <tr
      className={rowClass}
      data-wf={dataWf}
    >
      <td className={kind === "detail" ? "md-detail-spacer" : `md-cell-title md-cell-title--${kind}`}>
        {isExpandable ? (
          <button
            type="button"
            className={`md-usage-group-toggle${kind === "document" ? " md-usage-group-toggle--document" : ""}`}
            aria-expanded={expanded}
            onClick={onToggle}
          >
            <span className="md-usage-group-arrow" aria-hidden="true">›</span>
            <span className="md-usage-group-label">{label}</span>
          </button>
        ) : label}
      </td>
      {mode === "expert" && (
        <td>{row.modelId === "__multiple__" ? "多模型" : modelLabel(row.modelId)}</td>
      )}
      {mode === "expert" && (
        <td className={kind === "detail" ? "font-mono md-callsite-detail" : "md-callsite-summary"}>
          {kind === "detail" ? row.callSite : `${childCount} 个调用点`}
        </td>
      )}
      {mode === "expert" && (
        <td
          className="font-mono"
          title={`共 ${row.calls} 次，usage 缺失 ${row.missingCalls} 次`}
        >
          {`${Math.round(row.coverageRate * 100)}% · ${row.recordedCalls}/${row.calls}`}
        </td>
      )}
      <td className="font-mono">{formatTokens(row.inputTokens)}</td>
      <td className="font-mono">{formatTokens(row.outputTokens)}</td>
      <td className="font-mono">{hitRate === null ? "未知" : `${hitRate}%`}</td>
      <td className="font-mono">{row.costCny != null ? `¥${row.costCny.toFixed(3)}` : "—"}</td>
    </tr>
  );
}

function HelpMark({ label, text }: { label: string; text: string }) {
  return (
    <button type="button" className="md-th-help" aria-label={`${label}:${text}`} title={text}>
      ?
    </button>
  );
}

// 数字 count-up:从上一个值平滑涨到目标(easeOutCubic);尊重 prefers-reduced-motion。
function AnimatedNumber({
  value,
  format,
  durationMs = 900,
}: {
  value: number;
  format: (n: number) => string;
  durationMs?: number;
}) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const from = fromRef.current;
    const to = value;
    if (reduce || from === to) {
      fromRef.current = to;
      setDisplay(to);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (to - from) * eased);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
        setDisplay(to);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value, durationMs]);
  return <>{format(display)}</>;
}

// 金额降级:小额 3 位 / 个位 2 位 / 过百 1 位 / 过万切"万",窄区域不溢出。
function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 10000) return `¥${(n / 10000).toFixed(2)}万`;
  if (n >= 100) return `¥${n.toFixed(1)}`;
  if (n >= 1) return `¥${n.toFixed(2)}`;
  return `¥${n.toFixed(3)}`;
}

// 字数降级:过万切"万字"
function fmtWords(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万字`;
  return `${Math.round(n).toLocaleString()} 字`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// 只给已知的官方档位起中文短名;不认识的模型(第三方中转别名等)原样显示 id——
// 猜成「V4 Flash」会让模型多选里两个不同模型顶着同一个名字,分不清也点不明白。
function modelLabel(modelId: string): string {
  switch (modelId) {
    case "deepseek-v4-flash":
      return "V4 Flash";
    case "deepseek-v4-pro":
      return "V4 PRO";
    case "kimi-for-coding":
      return "K2.7 Code";
    case "k3":
      return "K3";
    default:
      return modelId;
  }
}

// 按模型分布饼图:conic-gradient 分段 + 图例配色
const PIE_COLORS = ["var(--qj-cinnabar)", "#7e9e8e", "#d8a657", "#9a8cb5"];
function pieGradient(dist: Array<{ pct: number }>): string {
  let acc = 0;
  const stops = dist.map((m, i) => {
    const start = acc;
    acc += m.pct;
    return `${PIE_COLORS[i % PIE_COLORS.length]} ${start.toFixed(2)}% ${acc.toFixed(2)}%`;
  });
  return `conic-gradient(${stops.join(", ")})`;
}
function toYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 连通性:自动 checkBalance 的结果 → 色点色调 + 中文文案(无 emoji)。
function deriveConnectivity(
  balance: BalanceState | null,
  loading: boolean,
  provider: ModelProvider,
  probeVisible = true,
): { tone: "ok" | "bad" | "idle"; text: string } {
  // probeVisible=false:首拉在途且还没超过延迟阈值,先给中性「已配置」,别闪"正在检测连接…"
  const probing = { tone: "idle" as const, text: probeVisible ? "正在检测连接…" : "已配置" };
  if (loading) return probing;
  if (balance === null) {
    return provider === "kimi"
      ? { tone: "idle", text: "已配置 · Kimi 连接测试需手动触发" }
      : probing;
  }
  if (balance.permissionDenied) return { tone: "bad", text: "Kimi 套餐或模型权限不足" };
  if (balance.keyInvalid) return { tone: "bad", text: "key 无效,请检查" };
  if (balance.ok) return { tone: "ok", text: "已连通" };
  return { tone: "idle", text: balance.error ? `暂时无法连接 · ${balance.error}` : "暂时无法连接" };
}

// 近 N 天消耗:从 day 数据汇总 costCny / tokens / calls。
function summarizeRecentDays(
  rows: UsageRow[] | null,
  days: number,
): { cost: number; tokens: number; calls: number; hasPriced: boolean } | null {
  if (rows === null) return null;
  if (rows.length === 0) return { cost: 0, tokens: 0, calls: 0, hasPriced: false };
  // bucket 是本地日历日 YYYY-MM-DD；窗口固定为“今天及之前 N-1 天”，不按有数据日期倒推。
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  start.setDate(start.getDate() - Math.max(0, days - 1));
  const startYmd = toYMD(start);
  const endYmd = toYMD(today);
  let cost = 0;
  let tokens = 0;
  let calls = 0;
  let hasPriced = false;
  for (const r of rows) {
    if (r.bucket < startYmd || r.bucket > endYmd) continue;
    cost += r.costCny ?? 0;
    if (r.costCny != null) hasPriced = true;
    tokens += r.inputTokens + r.outputTokens;
    calls += r.calls;
  }
  return { cost, tokens, calls, hasPriced };
}

// 按模型分布:total 数据按 modelId 聚合,算**费用**占比(降序)。
// 钱是用户真正关心的口径;没有价目表(费用为 0)的模型不进饼,tokens 降级成注脚。
function buildModelDistribution(
  rows: UsageRow[] | null,
): Array<{ name: string; tokens: number; cost: number; pct: number }> | null {
  if (rows === null) return null;
  const map = new Map<string, { tokens: number; cost: number }>();
  for (const r of rows) {
    const prev = map.get(r.modelId) ?? { tokens: 0, cost: 0 };
    prev.tokens += r.inputTokens + r.outputTokens;
    prev.cost += r.costCny ?? 0;
    map.set(r.modelId, prev);
  }
  const priced = Array.from(map.entries()).filter(([, m]) => m.cost > 0);
  const total = priced.reduce((sum, [, m]) => sum + m.cost, 0);
  return priced
    .map(([modelId, m]) => ({
      name: modelLabel(modelId),
      tokens: m.tokens,
      cost: m.cost,
      pct: total > 0 ? (m.cost / total) * 100 : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
}

// 按天趋势:day 数据按日期聚合(各模型相加),取最近 N 天,补齐日期序列;返回升序便于柱状从左到右。
function buildDailyTrend(
  rows: UsageRow[] | null,
  days: number,
): { days: Array<{ date: string; label: string; cost: number; tokens: number }>; max: number } | null {
  if (rows === null) return null;
  const map = new Map<string, { cost: number; tokens: number }>();
  for (const r of rows) {
    if (r.bucket === "total" || !r.bucket) continue;
    const prev = map.get(r.bucket) ?? { cost: 0, tokens: 0 };
    prev.cost += r.costCny ?? 0;
    prev.tokens += r.inputTokens + r.outputTokens;
    map.set(r.bucket, prev);
  }
  // 固定生成"今天往前 days 天"的完整序列(升序),无数据的天补 0(空条占位)
  const today = new Date();
  const series: Array<{ date: string; label: string; cost: number; tokens: number }> = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const date = toYMD(d);
    const m = map.get(date);
    series.push({ date, label: date.slice(5), cost: m?.cost ?? 0, tokens: m?.tokens ?? 0 });
  }
  const max = series.reduce((mx, d) => Math.max(mx, d.cost), 0);
  return { days: series, max };
}

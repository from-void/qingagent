import { useCallback, useEffect, useMemo, useRef } from "react";
import type { UsageSummaryResponse } from "@qingagent/contract-ts";
import { useConfirm } from "../../system";
import { useDelayedVisible } from "../../system/useDelayedVisible";
import { useToast } from "../../system/ToastProvider";
import { MODEL_VENDORS, VENDOR_META, vendorName } from "./modelVendorMeta";
import {
  buildDailyTrend,
  buildModelDistribution,
  buildUsageGroups,
  deriveConnectivity,
  persistUsageMode,
  summarizeRecentDays,
  toYMD,
  type UsageMode,
  type UsageRow,
  type UsageView,
} from "./modelUsage";
import {
  MODEL_DEFAULTS,
  type BalanceState,
  type ServerModelSettings,
} from "./modelSettingsTypes";
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
import { useModelConfigurationState, useModelUsageState } from "./useModelSettingsState";

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

export function useModelSettingsPanel(initialConfigProvider?: ModelProvider) {
  const toast = useToast();
  const confirm = useConfirm();
  const selectedProvider = getSelectedModelProvider();
  const {
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
  } = useModelConfigurationState({ initialConfigProvider, selectedProvider });
  const {
    usageView, setUsageView, usageMode, setUsageMode,
    expandedUsageGroups, setExpandedUsageGroups, usage, setUsage,
    usageSettled, setUsageSettled, usageStatus, setUsageStatus,
    usageDate, setUsageDate, excludedModels, setExcludedModels,
    dayUsage, setDayUsage, totalUsage, setTotalUsage, docStats, setDocStats,
    dashboardSettled, setDashboardSettled,
  } = useModelUsageState();
  const mountedRef = useRef(true);
  const usageTimeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );
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
      const res = await fetch(
        `/api/v1/usage/summary?view=${view}&timeZone=${encodeURIComponent(usageTimeZone)}`,
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
  }, [usageTimeZone]);

  // 看板用:按天 / 总计两份数据一次性拉取(图表始终展示这两份,与明细视图解耦)
  const loadDashboardUsage = useCallback(async (view: "day" | "total", signal?: AbortSignal) => {
    try {
      const res = await fetch(
        `/api/v1/usage/summary?view=${view}&timeZone=${encodeURIComponent(usageTimeZone)}`,
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
  }, [usageTimeZone]);

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
  return {
    view,
    configProvider,
    serverSettled,
    visitorKeys,
    customProviders,
    kimiConnected,
    keyInput,
    setKeyInput,
    persisting,
    setupMode,
    setSetupMode,
    customProtocol,
    setCustomProtocol,
    customBaseUrl,
    setCustomBaseUrl,
    customKey,
    setCustomKey,
    customModelFlash,
    setCustomModelFlash,
    customModelPro,
    setCustomModelPro,
    customTesting,
    officialFlash,
    setOfficialFlash,
    officialPro,
    setOfficialPro,
    tiers,
    verifyStatus,
    verifyMsg,
    usageView,
    usageMode,
    expandedUsageGroups,
    usageSettled,
    usageStatus,
    usageDate,
    setUsageDate,
    message,
    balanceLoading,
    invalidatePersistence,
    invalidateKimiVerification,
    invalidateCustomTest,
    handleProviderChange,
    openConfig,
    closeConfig,
    checkBalance,
    vendorConfigured,
    vendorStateKnown,
    customProvider,
    visitorKey,
    serverProviderState,
    configProviderConfigured,
    anyConfigured,
    effectiveProvider,
    handleVerifyKimiKey,
    handleSave,
    handleClearVisitor,
    handleClearCustom,
    handleModelTierChange,
    handleSaveCustom,
    recent,
    usageTimeZone,
    docStats,
    modelDist,
    trend,
    dashboardReady,
    showDashboardLoading,
    showUsageLoading,
    todayYmd,
    usageDates,
    usageDateUnsupported,
    usageModelIds,
    selectedModelIds,
    allModelsSelected,
    filteredUsage,
    usageGroups,
    toggleUsageModel,
    selectAllUsageModels,
    toggleUsageMode,
    switchUsageView,
    toggleUsageGroup,
    deepseekStatus,
    balanceVal,
    lowBalance,
    docs7,
    words7,
    avgPerDoc,
    docsPer10,
    estDocs,
    keyFormatOk,
    customBaseUrlValid,
  };
}

export type ModelSettingsController = ReturnType<typeof useModelSettingsPanel>;

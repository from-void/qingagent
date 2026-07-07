import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "../../system/ToastProvider";
import { useConfirm } from "../../system";
import "./modelDashboard.css";
import { SecretInput } from "./SecretInput";
import { ensureSettingsDialogA11y } from "./settingsDialogA11y";
import {
  type CustomProvider,
  type ModelTier,
  clearCustomProvider,
  clearVisitorDeepseekKey,
  getSelectedModelTier,
  getVisitorDeepseekKey,
  maskKey,
  readCustomProvider,
  readOfficialModelOverride,
  setSelectedModelTier,
  setVisitorDeepseekKey,
  visitorKeyHeaders,
  writeCustomProvider,
  writeOfficialModelOverride,
} from "./visitorKeyStore";
import { isHttpUrl } from "./visionProviderStore";

ensureSettingsDialogA11y();

// F1 模型设置面板。两层 key:本浏览器(visitor,localStorage) / 站点全局兜底(global-db)。
// 未配置态 = 小白引导 + 粘贴 key;已配置态 = 看板(进入即自动加载余额+用量,不再手动点按钮)。
// 进阶:其他云厂商(custom_provider)整体覆盖 baseURL+key+别名;官方模型前缀(official_model)仅覆盖模型名。

interface ServerModelSettings {
  apiKeyConfigured: boolean;
  maskedTail: string | null;
  source: "db" | "env" | "none";
  params: { temperature?: number; topP?: number; maxOutputTokens?: number } | null;
}

interface UsageRow {
  bucket: string;
  /** 会话视图:bucket(sessionId)对应的文档标题,由服务端注入。 */
  label?: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  calls: number;
  costCny?: number;
}

type UsageView = "day" | "session" | "total";

interface BalanceState {
  ok: boolean;
  keySource?: string;
  keyInvalid?: boolean;
  error?: string;
  isAvailable?: boolean | null;
  balances?: Array<{ currency: string; total: string; granted: string; toppedUp: string }>;
}

export function ModelSettingsPanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const [server, setServer] = useState<ServerModelSettings | null>(null);
  const [visitorKey, setVisitorKey] = useState<string | null>(() => getVisitorDeepseekKey());
  const [editing, setEditing] = useState(false);
  // 临时回到未配置引导流程(不删后端 .env key,刷新即恢复;方便预览/重配)
  const [forceSetup, setForceSetup] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  // 其他云厂商配置(进阶):存在即表示当前用自定义模型,覆盖 baseURL+key+别名
  const [customProvider, setCustomProvider] = useState<CustomProvider | null>(() => readCustomProvider());
  // 配置方式:官方 DeepSeek(默认)/ 其他云厂商;已配自定义则默认停在"其他"
  const [setupMode, setSetupMode] = useState<"official" | "other">(() => (readCustomProvider() ? "other" : "official"));
  const [customProtocol, setCustomProtocol] = useState(() => readCustomProvider()?.protocol ?? "openai");
  const [customBaseUrl, setCustomBaseUrl] = useState(() => readCustomProvider()?.baseUrl ?? "");
  const [customKey, setCustomKey] = useState(() => readCustomProvider()?.apiKey ?? "");
  // 只接 DeepSeek 模型,但中转厂商的别名可能不同 → 两个可选别名,默认填官方名
  const [customModelFlash, setCustomModelFlash] = useState(() => readCustomProvider()?.modelFlash ?? "deepseek-v4-flash");
  const [customModelPro, setCustomModelPro] = useState(() => readCustomProvider()?.modelPro ?? "deepseek-v4-pro");
  const [customTesting, setCustomTesting] = useState(false);
  // 官方模型前缀覆盖(仅 editing 态可改;防官方升级改名)
  const [officialFlash, setOfficialFlash] = useState(() => readOfficialModelOverride()?.flash ?? "");
  const [officialPro, setOfficialPro] = useState(() => readOfficialModelOverride()?.pro ?? "");
  const [modelTier, setModelTier] = useState<ModelTier>(() => getSelectedModelTier());
  // 官方 key 输入即自动验证的状态
  const [verifyStatus, setVerifyStatus] = useState<"idle" | "verifying" | "ok" | "fail">("idle");
  const [verifyMsg, setVerifyMsg] = useState("");
  // 明细表的视图切换(看板的趋势/分布图用独立的 day/total 数据,不受这里影响)
  const [usageView, setUsageView] = useState<UsageView>("day");
  const [usage, setUsage] = useState<UsageRow[] | null>(null);
  const [usageDate, setUsageDate] = useState("");
  // 看板专用:按天(趋势 + 近 7 天消耗)与总计(按模型分布)
  const [dayUsage, setDayUsage] = useState<UsageRow[] | null>(null);
  const [totalUsage, setTotalUsage] = useState<UsageRow[] | null>(null);
  const [docStats, setDocStats] = useState<{ docs: number; words: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [balance, setBalance] = useState<BalanceState | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const mountedRef = useRef(true);
  const balanceControllerRef = useRef<AbortController | null>(null);

  const loadServer = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/v1/settings/model", { signal });
      if (res.ok) {
        const body = (await res.json()) as ServerModelSettings;
        if (mountedRef.current && !signal?.aborted) setServer(body);
      }
    } catch {
      if (mountedRef.current && !signal?.aborted) setServer(null);
    }
  }, []);

  // 桌面客户端没有「浏览器 / 站点」概念:key 存本机、只认用户自带 key。文案/按钮据此调整。
  const isDesktop = typeof window !== "undefined" && window.electron?.isDesktop === true;

  const loadUsage = useCallback(async (view: UsageView, signal?: AbortSignal) => {
    try {
      const res = await fetch(`/api/v1/usage/summary?view=${view}`, { signal });
      if (res.ok) {
        const body = (await res.json()) as { rows?: UsageRow[] };
        if (mountedRef.current && !signal?.aborted) setUsage(body.rows ?? []);
      }
    } catch {
      if (mountedRef.current && !signal?.aborted) setUsage(null);
    }
  }, []);

  // 看板用:按天 / 总计两份数据一次性拉取(图表始终展示这两份,与明细视图解耦)
  const loadDashboardUsage = useCallback(async (view: "day" | "total", signal?: AbortSignal) => {
    try {
      const res = await fetch(`/api/v1/usage/summary?view=${view}`, { signal });
      const rows = res.ok ? (((await res.json()) as { rows?: UsageRow[] }).rows ?? []) : [];
      if (mountedRef.current && !signal?.aborted) {
        if (view === "day") setDayUsage(rows);
        else setTotalUsage(rows);
      }
    } catch {
      if (mountedRef.current && !signal?.aborted) {
        if (view === "day") setDayUsage(null);
        else setTotalUsage(null);
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
    }
  }, []);

  // 余额查询兼 key 有效性测试(DeepSeek /user/balance;401=key无效)。
  // 既被进入看板时的自动 useEffect 调用,也被"重新检测"按钮手动调用。
  const checkBalance = useCallback(async (signal?: AbortSignal) => {
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
        headers: visitorKeyHeaders(),
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
    };
  }, []);

  // 官方 key:输入即自动验证(debounce)。格式满足就实测一次 DeepSeek 接口,有问题立即提示。
  useEffect(() => {
    const trimmed = keyInput.trim();
    if (!/^sk-[A-Za-z0-9]{32}$/.test(trimmed)) {
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
            headers: { "x-deepseek-key": trimmed },
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
  }, [keyInput]);

  const usingCustom = Boolean(customProvider);
  const configured = Boolean(visitorKey) || Boolean(server?.apiKeyConfigured) || usingCustom;
  const dashboardVisible = configured && !editing && !forceSetup;

  // 进入已配置看板:自动查一次连通性 + 余额。其他云厂商不查(DeepSeek 余额接口测不了)。
  useEffect(() => {
    if (!dashboardVisible || usingCustom) return;
    const controller = new AbortController();
    void checkBalance(controller.signal);
    return () => controller.abort();
  }, [dashboardVisible, usingCustom, checkBalance, visitorKey]);

  // 进入已配置看板:自动加载按天 + 总计两份用量,喂给趋势图与按模型分布。
  useEffect(() => {
    if (!dashboardVisible) return;
    const controller = new AbortController();
    void loadDashboardUsage("day", controller.signal);
    void loadDashboardUsage("total", controller.signal);
    void loadDocStats(controller.signal);
    return () => controller.abort();
  }, [dashboardVisible, loadDashboardUsage, loadDocStats, visitorKey]);

  // 验证是输入时自动做的(见上方 useEffect)。保存:验证过→直接存;没过→二次确认(可能失效)。
  const handleSave = async () => {
    const trimmed = keyInput.trim();
    if (!/^sk-[A-Za-z0-9]{32}$/.test(trimmed)) {
      setMessage("key 格式不对:需以 sk- 开头,后接 32 位字符");
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
    setVisitorDeepseekKey(trimmed);
    setVisitorKey(trimmed);
    // 互斥:切回官方,清掉其他云厂商配置;写官方模型前缀覆盖(setup 态为空=清除,editing 态可改)
    clearCustomProvider();
    setCustomProvider(null);
    writeOfficialModelOverride({ flash: officialFlash, pro: officialPro });
    setKeyInput("");
    setEditing(false);
    setForceSetup(false);
    setMessage(null);
    toast.show("key 已验证并保存到本机");
    // 保存后回到用量看板:滚到顶 + 主动查一次连通性(否则可能停在"暂时无法连接",需手动重测)
    requestAnimationFrame(() => {
      document.querySelector(".qj-sheet-body")?.scrollTo({ top: 0, behavior: "auto" });
      void checkBalance();
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
    clearVisitorDeepseekKey();
    setVisitorKey(null);
    setMessage(window.electron?.isDesktop ? "已清除本机的 key" : "已清除本浏览器的 key");
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
    clearCustomProvider();
    setCustomProvider(null);
    setMessage("已清除自定义模型配置");
    return true;
  };

  const handleModelTierChange = useCallback((tier: ModelTier) => {
    if (tier === modelTier) return;
    setSelectedModelTier(tier);
    setModelTier(tier);
    toast.show({
      message: tier === "pro" ? "已切换到 Pro 档,生成会更慢" : "已切换到 Flash 档",
      tone: "success",
      dedupeKey: "model-tier",
    });
  }, [modelTier, toast]);

  // 其他云厂商(进阶):先调后端测试接口(代理避免 CORS),通了再保存并启用
  const handleSaveCustom = async () => {
    const baseUrl = customBaseUrl.trim();
    const apiKey = customKey.trim();
    if (!baseUrl || !apiKey) {
      setMessage("请填写:API 地址、API key");
      return;
    }
    if (!isHttpUrl(baseUrl)) {
      setMessage("API 地址格式不对:需以 http(s):// 开头");
      return;
    }
    const modelFlash = customModelFlash.trim() || "deepseek-v4-flash";
    const modelPro = customModelPro.trim() || "deepseek-v4-pro";
    setCustomTesting(true);
    setMessage("正在测试接口连通性…");
    // 超时保护:测连接打的是用户填的第三方 baseUrl,不可信(可能不通/极慢)。
    // 无 AbortController 时 fetch 会无限挂起,按钮永远卡"测试中…"=整页假死(e2e E1-h2)。
    const testCtrl = new AbortController();
    const testTimer = setTimeout(() => testCtrl.abort(), 25_000);
    try {
      const res = await fetch("/api/v1/settings/model/test-custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, apiKey, model: modelFlash, protocol: customProtocol }),
        signal: testCtrl.signal,
      });
      const body = (await res.json()) as { ok: boolean; keyInvalid?: boolean; error?: string };
      if (!body.ok) {
        setMessage(
          body.keyInvalid
            ? "key 无效或无权限,请检查"
            : `接口不通:${body.error ?? "请检查 API 地址与 key"}`,
        );
        return;
      }
      const provider: CustomProvider = { protocol: customProtocol, baseUrl, apiKey, modelFlash, modelPro };
      writeCustomProvider(provider);
      setCustomProvider(provider);
      // 互斥:切到其他云厂商,清官方 visitor key
      clearVisitorDeepseekKey();
      setVisitorKey(null);
      setEditing(false);
      setForceSetup(false);
      setMessage(null);
      toast.show("接口测试通过,已保存并启用自定义模型");
    } catch (e) {
      setMessage(
        e instanceof DOMException && e.name === "AbortError"
          ? "测试超时:接口 25 秒无响应,请检查 API 地址是否可达"
          : "测试失败:网络错误,请重试",
      );
    } finally {
      clearTimeout(testTimer);
      setCustomTesting(false);
    }
  };

  // —— 派生数据:近 7 天消耗、按模型分布、按天趋势 ——
  const recent = useMemo(() => summarizeRecentDays(dayUsage, 7), [dayUsage]);
  const modelDist = useMemo(() => buildModelDistribution(totalUsage), [totalUsage]);
  const trend = useMemo(() => buildDailyTrend(dayUsage, 15), [dayUsage]);
  const todayYmd = useMemo(() => toYMD(new Date()), []);
  const visibleUsage = useMemo(() => {
    if (usage === null) return null;
    if (usageDate && usageView === "day") return usage.filter((row) => row.bucket === usageDate);
    return usage;
  }, [usage, usageDate, usageView]);
  const usageDateUnsupported = usageDate !== "" && usageView !== "day";

  // —— 连通性状态:自动 checkBalance 结果 → 色点 + 文案 ——
  const status = deriveConnectivity(balance, balanceLoading);
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
  const keyFormatOk = keyInput.trim() === "" ? null : /^sk-[A-Za-z0-9]{32}$/.test(keyInput.trim());
  const customBaseUrlValid = customBaseUrl.trim() === "" ? null : isHttpUrl(customBaseUrl.trim());
  const modelTierSection = (
    <div className="sm-tier-row" data-wf="ModelTierSelector">
      <div className="sm-tier-copy">
        <span className="sm-tier-title">模型档位</span>
        <span className="sm-tier-note">默认 Flash;Pro 更强但更慢</span>
      </div>
      <div className="sm-tier-control" role="radiogroup" aria-label="模型档位">
        {(["flash", "pro"] as const).map((tier) => (
          <button
            key={tier}
            type="button"
            role="radio"
            aria-checked={modelTier === tier}
            aria-pressed={modelTier === tier}
            className={`sm-tier-option${modelTier === tier ? " sm-active" : ""}`}
            onClick={() => handleModelTierChange(tier)}
            data-wf={tier === "flash" ? "ModelTierFlash" : "ModelTierPro"}
          >
            <span>{tier === "flash" ? "Flash" : "Pro"}</span>
            <small>{tier === "flash" ? "快" : "更强更慢"}</small>
          </button>
        ))}
      </div>
    </div>
  );
  const officialKeyForm = (
    <>
      <div className="sm-keyrow">
        <SecretInput
          autoComplete="off"
          spellCheck={false}
          className="sm-keyinput"
          placeholder="粘贴 DeepSeek API key(sk-…)"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          data-wf="ModelKeyInput"
        />
        <button
          type="button"
          className="sm-btn"
          onClick={() => void handleSave()}
          // 未测试通过(verifyStatus!=="ok")前不可保存:必须先验证 key 有效
          disabled={verifyStatus !== "ok"}
          title={verifyStatus !== "ok" ? "请先填入有效 key 并等待验证通过" : undefined}
        >
          保存
        </button>
        {editing && (
          <button type="button" className="sm-btn" onClick={() => setEditing(false)}>
            取消
          </button>
        )}
      </div>
      {keyFormatOk === false && (
        <p className="sm-field-err">key 格式不对:需以 sk- 开头,后接 32 位字符</p>
      )}
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
      {editing && (
        <div className="sm-model-prefix">
          <div className="sm-field">
            <span className="sm-field-label">V4 Flash 模型名（一般无需修改）</span>
            <input
              className="sm-field-input"
              placeholder="deepseek-v4-flash"
              value={officialFlash}
              onChange={(e) => setOfficialFlash(e.target.value)}
            />
          </div>
          <div className="sm-field">
            <span className="sm-field-label">V4 PRO 模型名</span>
            <input
              className="sm-field-input"
              placeholder="deepseek-v4-pro"
              value={officialPro}
              onChange={(e) => setOfficialPro(e.target.value)}
            />
          </div>
          <p className="sm-keyhint">留空即用官方默认模型名;仅当官方升级换名导致报错时才需要改。</p>
        </div>
      )}
      <p className="sm-keyhint">
        {isDesktop ? "Key 只保存在本机，用于发起模型请求。" : "Key 会保存在这台电脑的浏览器中，用于发起模型请求。"}
      </p>
    </>
  );

  // 配置编辑器(官方 / 其他厂商两 tab);setup 与 editing 共用,editing 不显示官方步骤、改显示模型前缀。
  const configSection = (
    <div className="sm-config">
      <div className="sm-faq-q">{editing ? "切换 / 修改模型配置" : "如何配置 DeepSeek?"}</div>
      {modelTierSection}
      <div className="sm-setup-tabs" role="tablist" aria-label="配置方式">
        <button
          type="button"
          role="tab"
          aria-selected={setupMode === "official"}
          className={`sm-setup-tab${setupMode === "official" ? " sm-active" : ""}`}
          onClick={() => setSetupMode("official")}
        >
          <span>接入 DeepSeek 官方 API</span>
          <small>推荐方式（步骤简单）</small>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={setupMode === "other"}
          className={`sm-setup-tab${setupMode === "other" ? " sm-active" : ""}`}
          onClick={() => setSetupMode("other")}
        >
          <span>接入其他云厂商 / 模型</span>
          <small>进阶设置</small>
        </button>
      </div>

      {setupMode === "official" ? (
        <div className="sm-official">
          {!editing && (
            <ol className="sm-steps">
              <li>
                前往{" "}
                <a href="https://platform.deepseek.com/" target="_blank" rel="noreferrer">
                  platform.deepseek.com
                </a>{" "}
                完成注册登录
              </li>
              <li>可先小额充值试用</li>
              <li>
                创建并复制 API key(以 <code>sk-</code> 开头)
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
            <select
              className="sm-field-input"
              value={customProtocol}
              onChange={(e) => setCustomProtocol(e.target.value)}
            >
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic 兼容</option>
            </select>
          </div>
          <div className="sm-field">
            <span className="sm-field-label">API 地址(Base URL)</span>
            <input
              className={`sm-field-input${customBaseUrlValid === false ? " sm-field-input--invalid" : ""}`}
              placeholder="https://your-endpoint/v1"
              value={customBaseUrl}
              aria-invalid={customBaseUrlValid === false}
              aria-describedby={customBaseUrlValid === false ? "model-custom-base-url-error" : undefined}
              onChange={(e) => setCustomBaseUrl(e.target.value)}
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
              onChange={(e) => setCustomKey(e.target.value)}
            />
          </div>
          <div className="sm-field">
            <span className="sm-field-label">V4 Flash 模型别名(可选)</span>
            <input
              className="sm-field-input"
              placeholder="deepseek-v4-flash"
              value={customModelFlash}
              onChange={(e) => setCustomModelFlash(e.target.value)}
            />
          </div>
          <div className="sm-field">
            <span className="sm-field-label">V4 PRO 模型别名(可选)</span>
            <input
              className="sm-field-input"
              placeholder="deepseek-v4-pro"
              value={customModelPro}
              onChange={(e) => setCustomModelPro(e.target.value)}
            />
          </div>
          <p className="sm-other-note">
            默认适配 DeepSeek 模型。其他模型可在上面改成对应别名自行尝试(效果不保证);两者留空则默认用 deepseek-v4-flash。
          </p>
          <button
            type="button"
            className="sm-btn"
            onClick={() => void handleSaveCustom()}
            // baseURL 非法(非空但格式错)时 proactive 禁用,别等点击才报错——更早阻止无效提交(e2e #15增强)。
            // 空值仍可点(handleSaveCustom 给"请填写 API 地址"就近提示)。
            disabled={customTesting || customBaseUrlValid === false}
            aria-disabled={customTesting || customBaseUrlValid === false}
            title={customBaseUrlValid === false ? "API 地址格式不对,需以 http(s):// 开头" : undefined}
          >
            {customTesting ? "测试中…" : "测试并保存"}
          </button>
        </div>
      )}
    </div>
  );

  const keySourceLabel = customProvider
    ? "自定义模型"
    : visitorKey
      ? isDesktop
        ? "本机"
        : "本浏览器"
      : server?.source === "db"
        ? isDesktop
          ? "本机配置"
          : "站点全局"
        : isDesktop
          ? "本机环境变量"
          : "环境变量";
  const keySourceDetail = customProvider
    ? customProvider.baseUrl
    : visitorKey
      ? maskKey(visitorKey)
      : server?.source === "db"
        ? server.maskedTail
          ? `••••${server.maskedTail}`
          : ""
        : isDesktop
          ? ".env"
          : "站点默认";

  return (
    <div className="settings-model" data-wf="ModelSettingsPanel">
      {!dashboardVisible ? (
        <section className="sm-setup">
          <div className="sm-guide">
            {configured && (forceSetup || editing) && (
              <button
                type="button"
                className="sm-back"
                onClick={() => {
                  setForceSetup(false);
                  setEditing(false);
                }}
              >
                ← 返回看板
              </button>
            )}
            {(!configured || forceSetup) && (
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
            {configSection}
          </div>
        </section>
      ) : (
        <section className="sm-configured">
          {/* —— 账户卡片:连通性状态 + 余额 + 近 7 天消耗 + key 管理 —— */}
          <div className="md-card md-account">
            <div className="md-status-row">
              {usingCustom ? (
                <>
                  <span className="md-dot md-dot--ok" aria-hidden="true" />
                  <span className="md-status-text">已接入自定义模型</span>
                </>
              ) : (
                <>
                  <span className={`md-dot md-dot--${status.tone}`} aria-hidden="true" />
                  <span className="md-status-text">{status.text}</span>
                  <button
                    type="button"
                    className="md-recheck"
                    disabled={balanceLoading}
                    onClick={() => void checkBalance()}
                    data-wf="BalanceCheckBtn"
                  >
                    {balanceLoading ? "检测中…" : "重新检测"}
                  </button>
                </>
              )}
            </div>

            {modelTierSection}

            <div className={`md-metrics${usingCustom ? " md-metrics--3" : ""}`}>
              <div className="md-metric">
                <div className="md-metric-label">近 7 天消耗</div>
                <div className="md-metric-value md-value-accent font-mono">
                  {recent ? <AnimatedNumber value={recent.cost} format={fmtMoney} /> : "—"}
                </div>
                <div className="md-metric-sub">
                  {recent ? `${formatTokens(recent.tokens)} tokens` : "暂无记录"}
                </div>
              </div>

              <div className="md-metric">
                <div className="md-metric-label">近 7 天文档</div>
                <div className="md-metric-value font-mono">
                  {docStats ? <AnimatedNumber value={docs7} format={(n) => `${Math.round(n)} 篇`} /> : "—"}
                </div>
                <div className="md-metric-sub">{docStats ? fmtWords(words7) : "暂无记录"}</div>
              </div>

              <div className="md-metric">
                <div className="md-metric-label">平均每篇</div>
                <div className="md-metric-value font-mono">
                  {avgPerDoc != null ? <AnimatedNumber value={avgPerDoc} format={fmtMoney} /> : "—"}
                </div>
                <div className="md-metric-sub">
                  {docsPer10 != null ? `每 10 元约 ${Math.floor(docsPer10)} 篇` : "需有消耗与文档"}
                </div>
              </div>

              {!usingCustom && (
                <div className="md-metric">
                  <div className="md-metric-label">账户余额</div>
                  <div className={`md-metric-value${lowBalance ? "" : " md-value-accent"} font-mono`}>
                    {balanceVal ? (
                      <AnimatedNumber
                        value={Number(balanceVal.total)}
                        format={(n) =>
                          balanceVal.currency === "CNY" ? fmtMoney(n) : `${balanceVal.currency} ${n.toFixed(2)}`
                        }
                      />
                    ) : (
                      "—"
                    )}
                  </div>
                  <div className="md-metric-sub">
                    {estDocs != null
                      ? `预估还可建 ${Math.floor(estDocs)} 篇`
                      : balanceVal
                        ? `充值 ${balanceVal.toppedUp}`
                        : "暂无"}
                  </div>
                  {lowBalance && (
                    <div className="md-metric-warn">
                      <span className="md-dot md-dot--warn" aria-hidden="true" />
                      余额偏低，建议及时充值
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="md-keyline">
              <span className="md-keysrc">
                当前使用 <strong>{keySourceLabel}</strong> 的 key
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
                <button type="button" className="md-mini-btn" onClick={() => setEditing(true)} data-wf="ModelKeyEdit">
                  修改配置
                </button>
                {visitorKey && (
                  <button type="button" className="md-mini-btn" onClick={() => void handleClearVisitor()}>
                    {isDesktop ? "清除本机 key" : "清除本浏览器 key"}
                  </button>
                )}
                {customProvider && (
                  <button type="button" className="md-mini-btn" onClick={() => void handleClearCustom()}>
                    清除自定义配置
                  </button>
                )}
                {/* 客户端只认本机自带 key、无 env/站点兜底,「清除·重新配置」无意义,仅 web 版显示 */}
                {!isDesktop && (
                  <button
                    type="button"
                    className="md-mini-btn"
                    title="临时回到未配置的引导/配置流程(不删后端 .env key,刷新即恢复)"
                    onClick={async () => {
                      if (visitorKey && !(await handleClearVisitor())) return;
                      if (customProvider && !(await handleClearCustom())) return;
                      setForceSetup(true);
                    }}
                  >
                    清除·重新配置
                  </button>
                )}
              </span>
            </div>
          </div>

          {/* —— 用量看板:按模型分布 + 按天趋势(并排) —— */}
          <div className="md-card md-usage">
            <h3 className="md-card-title">用量看板</h3>
            <div className="md-row">
              <div className="md-block md-col">
                <div className="md-block-head">
                  <span className="md-block-title">按模型分布</span>
                  <span className="md-block-sub">累计 tokens 占比</span>
                </div>
                {modelDist === null ? (
                  <p className="md-empty">加载失败或暂不可用</p>
                ) : modelDist.length === 0 ? (
                  <p className="md-empty">还没有用量记录,对话后出现</p>
                ) : (
                  <div className="md-pie-wrap">
                    <div className="md-pie" style={{ background: pieGradient(modelDist) }} aria-hidden="true" />
                    <ul className="md-pie-legend">
                      {modelDist.map((m, i) => (
                        <li className="md-legend-item" key={m.name}>
                          <span className="md-legend-dot" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                          <span className="md-legend-name">{m.name}</span>
                          <span className="md-legend-num">
                            {m.pct.toFixed(0)}% · {formatTokens(m.tokens)}
                            {m.cost > 0 && <> · <span className="md-model-cost">¥{m.cost.toFixed(3)}</span></>}
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
                {trend === null ? (
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
              <span className="md-card-title">用量明细</span>
              <span className="md-detail-filters">
                <label className="md-date-filter">
                  <span>日期</span>
                  <input
                    type="date"
                    value={usageDate}
                    max={todayYmd}
                    disabled={usageView !== "day"}
                    title={usageView === "day" ? "仅筛选已加载的按天用量" : "日期筛选仅支持按天视图"}
                    onChange={(e) => setUsageDate(e.target.value)}
                  />
                </label>
                {usageDate && (
                  <button type="button" className="md-date-clear" onClick={() => setUsageDate("")}>
                    清除
                  </button>
                )}
                <span className="md-views md-views--right">
                  {(["day", "session", "total"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={usageView === v}
                      className={`md-view-btn${usageView === v ? " md-active" : ""}`}
                      onClick={() => setUsageView(v)}
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
              {visibleUsage === null ? (
                <p className="md-empty">用量数据加载失败或暂不可用</p>
              ) : visibleUsage.length === 0 ? (
                <p className="md-empty">
                  {usageDate && usageView === "day" ? "该日期暂无用量记录" : "还没有用量记录,开始一次对话后这里会出现消耗明细"}
                </p>
              ) : (
                <table className="md-table">
                  <thead>
                    <tr>
                      <th>
                        <span className="md-th-label">
                          {usageView === "day" ? "日期" : usageView === "session" ? "文档" : "范围"}
                          <HelpMark label="范围" text="当前行统计覆盖的日期、文档或总计范围。" />
                        </span>
                      </th>
                      {/* 模型列:仅「总计」视图展示(按文档/按天不展示) */}
                      {usageView === "total" && (
                        <th>
                          <span className="md-th-label">
                            模型
                            <HelpMark label="模型" text="按模型名聚合后的用量分组。" />
                          </span>
                        </th>
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
                          <HelpMark label="估算费用" text="按 DeepSeek 公开单价估算,实际费用以服务商账单为准。" />
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleUsage.map((row, i) => {
                      // 缓存命中率 = 缓存命中 token / 输入 token(DeepSeek 输入分命中+未命中)。
                      const hitRate =
                        row.inputTokens > 0
                          ? Math.round((row.cacheHitTokens / row.inputTokens) * 100)
                          : 0;
                      return (
                        <tr key={i}>
                          <td className={usageView === "session" ? "md-cell-title" : "font-mono"}>
                            {usageView === "session"
                              ? row.label || "未命名草稿"
                              : row.bucket === "total"
                                ? "—"
                                : row.bucket}
                          </td>
                          {usageView === "total" && (
                            <td>{row.modelId.includes("pro") ? "V4 PRO" : "V4 Flash"}</td>
                          )}
                          <td className="font-mono">{formatTokens(row.inputTokens)}</td>
                          <td className="font-mono">{formatTokens(row.outputTokens)}</td>
                          <td className="font-mono">{hitRate}%</td>
                          <td className="font-mono">{row.costCny != null ? `¥${row.costCny.toFixed(3)}` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            <p className="md-foot-note">费用为按 DeepSeek 官方单价的估算,实际以 DeepSeek 账单为准;价格可能变化。</p>
          </div>
        </section>
      )}
      {message && <p className="sm-message">{message}</p>}
    </div>
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

function modelLabel(modelId: string): string {
  return modelId.includes("pro") ? "V4 PRO" : "V4 Flash";
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
): { tone: "ok" | "bad" | "idle"; text: string } {
  if (loading || balance === null) return { tone: "idle", text: "正在检测连接…" };
  if (balance.keyInvalid) return { tone: "bad", text: "key 无效,请检查" };
  if (balance.ok) return { tone: "ok", text: "已连通" };
  return { tone: "idle", text: balance.error ? `暂时无法连接 · ${balance.error}` : "暂时无法连接" };
}

// 近 N 天消耗:从 day 数据汇总 costCny / tokens / calls。
function summarizeRecentDays(
  rows: UsageRow[] | null,
  days: number,
): { cost: number; tokens: number; calls: number } | null {
  if (rows === null) return null;
  if (rows.length === 0) return { cost: 0, tokens: 0, calls: 0 };
  // bucket 是 YYYY-MM-DD;取按日期倒序后最近 N 天涉及的所有行
  const dates = Array.from(new Set(rows.map((r) => r.bucket))).sort().reverse().slice(0, days);
  const keep = new Set(dates);
  let cost = 0;
  let tokens = 0;
  let calls = 0;
  for (const r of rows) {
    if (!keep.has(r.bucket)) continue;
    cost += r.costCny ?? 0;
    tokens += r.inputTokens + r.outputTokens;
    calls += r.calls;
  }
  return { cost, tokens, calls };
}

// 按模型分布:total 数据按 modelId 聚合,算 tokens 占比(降序)。
function buildModelDistribution(
  rows: UsageRow[] | null,
): Array<{ name: string; tokens: number; cost: number; pct: number }> | null {
  if (rows === null) return null;
  const map = new Map<string, { tokens: number; cost: number }>();
  for (const r of rows) {
    const name = modelLabel(r.modelId);
    const prev = map.get(name) ?? { tokens: 0, cost: 0 };
    prev.tokens += r.inputTokens + r.outputTokens;
    prev.cost += r.costCny ?? 0;
    map.set(name, prev);
  }
  const total = Array.from(map.values()).reduce((s, m) => s + m.tokens, 0);
  return Array.from(map.entries())
    .map(([name, m]) => ({ name, tokens: m.tokens, cost: m.cost, pct: total > 0 ? (m.tokens / total) * 100 : 0 }))
    .sort((a, b) => b.tokens - a.tokens);
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

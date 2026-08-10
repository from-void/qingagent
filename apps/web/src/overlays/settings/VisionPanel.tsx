import { useEffect, useRef, useState } from "react";
import { useToast } from "../../system/ToastProvider";
import { useConfirm } from "../../system";
import { SecretInput } from "./SecretInput";
import {
  clearVisionProvider,
  isHttpUrl,
  readVisionProvider,
  writeVisionProvider,
  type VisionProvider,
} from "./visionProviderStore";
import {
  getVisitorModelKey,
  readCustomProvider,
  resolveModelRequestProvider,
  type ModelProvider,
} from "./visitorKeyStore";

// 设置·技能·图像识别:副基模(多模态)配置面板。
// 顶部 DeepSeek 原生项先 disable 占位(暂不支持多模态,开通后复用主模型 key);
// 下方接入第三方多模态模型——复刻"其他云厂商"表单(协议/BaseURL/key/模型名)+ 测试并保存。
// 配置只存本浏览器(visionProviderStore),随对话请求以 x-vision-* header 透传,服务端不落盘。

type VisionTestErrorKind =
  | "missing_key"
  | "invalid_config"
  | "auth"
  | "network"
  | "timeout"
  | "ssrf_blocked"
  | "unsupported_media"
  | "model_error";

interface VisionModelSettingsResponse {
  provider: ModelProvider;
  providers: Record<ModelProvider, { apiKeyConfigured: boolean }>;
}

function testErrorLabel(kind: VisionTestErrorKind | undefined): string {
  switch (kind) {
    case "missing_key":
      return "未填写 API key";
    case "invalid_config":
      return "配置无效";
    case "auth":
      return "key 无效";
    case "network":
      return "网络异常";
    case "timeout":
      return "请求超时";
    case "ssrf_blocked":
      return "地址被安全策略拦截";
    case "unsupported_media":
      return "模型不支持图像输入";
    case "model_error":
      return "模型返回错误";
    default:
      return "测试失败";
  }
}

function maskTail(key: string): string {
  return key.length > 4 ? `••••${key.slice(-4)}` : "••••";
}

function visionPersistFailureMessage(): string {
  return window.electron?.isDesktop
    ? "系统无安全存储或本机写入失败，未保存"
    : "浏览器存储不可用，未保存";
}

export function VisionPanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const [serverModelSettings, setServerModelSettings] =
    useState<VisionModelSettingsResponse | null>(null);
  const modelProvider = resolveModelRequestProvider(serverModelSettings?.provider);
  const kimiNativeVision = modelProvider === "kimi";
  const serverKimiKeyConfigured =
    serverModelSettings?.providers.kimi.apiKeyConfigured ?? false;
  const kimiKeyConfigured =
    Boolean(getVisitorModelKey("kimi")) ||
    Boolean(readCustomProvider("kimi")) ||
    serverKimiKeyConfigured;
  const kimiNativeVisionReady = kimiNativeVision && kimiKeyConfigured;
  const [saved, setSaved] = useState<VisionProvider | null>(() => readVisionProvider());
  const [protocol, setProtocol] = useState<"openai" | "anthropic">(
    () => readVisionProvider()?.protocol ?? "openai",
  );
  const [baseUrl, setBaseUrl] = useState(() => readVisionProvider()?.baseUrl ?? "");
  // 安全:不把已存的明文 key 回填进可编辑输入框(防肩窥/截屏泄漏)。留空=沿用已存 key。
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(() => readVisionProvider()?.model ?? "");
  const [testing, setTesting] = useState(false);
  const [persisting, setPersisting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const testRevisionRef = useRef(0);
  const testControllerRef = useRef<AbortController | null>(null);

  const invalidateTest = () => {
    testRevisionRef.current += 1;
    testControllerRef.current?.abort();
    testControllerRef.current = null;
    setTesting(false);
    setPersisting(false);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      testRevisionRef.current += 1;
      testControllerRef.current?.abort();
      testControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/v1/settings/model", { signal: controller.signal });
        if (!res.ok) return;
        const body = (await res.json()) as VisionModelSettingsResponse;
        if (mountedRef.current && !controller.signal.aborted) setServerModelSettings(body);
      } catch {
        // 服务端状态暂不可用时保留本地显式配置判断，不把可用状态误写成失败。
      }
    })();
    return () => controller.abort();
  }, []);

  // 测试并保存:先调后端 test 路由(代理避免 CORS、做真实 image part 连通性检查),通了再落本机。
  const handleTestAndSave = async () => {
    const rawBase = baseUrl.trim();
    // 留空则沿用已存 key(不要求每次重输);只有从未存过 key 才报"缺 key"。
    const key = apiKey.trim() || saved?.apiKey || "";
    const mdl = model.trim();
    if (!rawBase || !key || !mdl) {
      setMessage("请填写 API 地址、API key 与模型名");
      return;
    }
    // 注:这里维持严格 scheme 校验(模型设置页的"补 https:// 再测"暂未推广到视觉配置)。
    if (!isHttpUrl(rawBase)) {
      setMessage("API 地址格式不对:需以 http(s):// 开头");
      return;
    }
    const base = rawBase;
    testControllerRef.current?.abort();
    const revision = ++testRevisionRef.current;
    setTesting(true);
    setMessage(null);
    // 超时保护:测的是用户填的第三方 baseUrl,不可信;无 AbortController 时 fetch 会无限挂起,
    // 按钮永远卡"测试中…"=整页假死(e2e E1-h2)。
    const testCtrl = new AbortController();
    testControllerRef.current = testCtrl;
    const testTimer = setTimeout(() => testCtrl.abort(), 25_000);
    const canCommit = () =>
      mountedRef.current &&
      testRevisionRef.current === revision &&
      testControllerRef.current === testCtrl;
    let phase: "testing" | "saving" = "testing";
    try {
      const res = await fetch("/api/v1/settings/vision/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol, baseUrl: base, apiKey: key, model: mdl }),
        signal: testCtrl.signal,
      });
      if (!canCommit()) return;
      if (res.status === 400) {
        setMessage("配置无效,请检查 API 地址 / 模型名格式");
        return;
      }
      const body = (await res.json()) as {
        ok?: boolean;
        errorKind?: VisionTestErrorKind;
        // 服务端归一化后的 canonical 地址(测连接实际打的就是它)
        normalizedBaseUrl?: string;
      };
      if (!canCommit()) return;
      if (!body.ok) {
        setMessage(`测试失败:${testErrorLabel(body.errorKind)}`);
        return;
      }
      // 存"实际会被请求的地址",而非用户原始输入(前端不自造第二套归一化)。
      const savedBase = body.normalizedBaseUrl?.trim() || base;
      const next: VisionProvider = {
        enabled: true,
        protocol,
        baseUrl: savedBase,
        apiKey: key,
        model: mdl,
      };
      phase = "saving";
      setPersisting(true);
      const persisted = await writeVisionProvider(next);
      if (!canCommit()) return;
      if (!persisted) {
        setMessage(visionPersistFailureMessage());
        return;
      }
      setSaved(next);
      setBaseUrl(savedBase);
      setMessage(null);
      toast.show(
        savedBase === rawBase
          ? "测试通过,图像识别已启用"
          : `已自动修正为标准地址 ${savedBase},测试通过并已启用`,
      );
    } catch (e) {
      if (canCommit())
        setMessage(
          e instanceof DOMException && e.name === "AbortError"
            ? "测试超时:接口 25 秒无响应,请检查 API 地址是否可达"
            : phase === "saving"
              ? "接口测试已通过，但配置保存未完成，请重试"
              : "接口测试未完成，请重试",
        );
    } finally {
      clearTimeout(testTimer);
      if (canCommit()) {
        testControllerRef.current = null;
        setTesting(false);
        setPersisting(false);
      }
    }
  };

  const handleToggle = async () => {
    if (!saved) return;
    invalidateTest();
    const revision = testRevisionRef.current;
    const canCommit = () => mountedRef.current && testRevisionRef.current === revision;
    const next = { ...saved, enabled: !saved.enabled };
    setPersisting(true);
    const persisted = await writeVisionProvider(next);
    if (!canCommit()) return;
    setPersisting(false);
    if (!persisted) {
      setMessage(visionPersistFailureMessage());
      return;
    }
    setSaved(next);
    setMessage(next.enabled ? "已启用图像识别" : "已停用图像识别");
  };

  const handleClear = async () => {
    // 二次确认:清除是破坏性操作,误点会丢图像识别配置(e2e E3/E4)。
    const proceed = await confirm({
      title: "清除图像识别配置？",
      message: "清除后识图功能将停用，后续图像识别模型请求将无法发起；需重新填写接口地址与 key 才能恢复。",
      confirmLabel: "清除配置",
    });
    if (!proceed) {
      return;
    }
    invalidateTest();
    const revision = testRevisionRef.current;
    const canCommit = () => mountedRef.current && testRevisionRef.current === revision;
    setPersisting(true);
    const persisted = await clearVisionProvider();
    if (!canCommit()) return;
    setPersisting(false);
    if (!persisted) {
      setMessage("本机配置清除失败，请重试");
      return;
    }
    setSaved(null);
    setBaseUrl("");
    setApiKey("");
    setModel("");
    setProtocol("openai");
    setMessage("已清除图像识别配置");
  };

  const baseUrlValid = baseUrl.trim() === "" ? null : isHttpUrl(baseUrl.trim());

  return (
    <div className="settings-vision" data-wf="VisionPanel">
      <p className="sm-note" style={{ marginTop: 0 }}>
        {kimiNativeVision
          ? kimiKeyConfigured
            ? "当前 Kimi 主模型原生支持图片识别，默认复用当前档位、API 地址与 key。"
            : "当前已选择 Kimi，但尚未配置 key；配置后可自动复用主模型进行图片识别。"
          : "主模型 DeepSeek 暂不支持图片识别,需要单独接入一个视觉模型。"}
        {" "}下方独立视觉配置保存在
        {typeof window !== "undefined" && window.electron?.isDesktop ? "本机" : "本浏览器"}，
        启用后会优先于主模型复用配置。
      </p>

      <section className={`ss-card${kimiNativeVision ? "" : " sm-disabled"}`}>
        <div className="ss-head">
          <div className="ss-titleline">
            <h3 className="sm-title">
              {kimiNativeVision ? "Kimi 原生图像识别" : "DeepSeek 原生图像识别"}
            </h3>
            <span className={`ss-badge ${kimiNativeVisionReady ? "ss-ok" : "ss-quota"}`}>
              {kimiNativeVision ? (kimiKeyConfigured ? "自动启用" : "未配置") : "暂未支持"}
            </span>
          </div>
          {!kimiNativeVision && (
            <button type="button" className="sm-btn" disabled aria-disabled="true">
              即将支持
            </button>
          )}
        </div>
        <p className="ss-meta">
          {kimiNativeVision
            ? kimiKeyConfigured
              ? "识图请求直接走当前 K2.7 Code / K3 主模型，无需重复配置；下方显式配置仍可覆盖。"
              : "请先在模型设置中填写 Kimi key；下方也可显式配置独立视觉模型。"
            : "DeepSeek 暂不支持多模态;开通后将自动复用主模型 key,无需在此重复配置。"}
        </p>
      </section>

      {/* 接入第三方多模态模型 */}
      <section className="ss-card">
        <div className="ss-head">
          <div className="ss-titleline">
            <h3 className="sm-title">接入第三方多模态模型</h3>
            {saved && (
              <span className={`ss-badge ${saved.enabled ? "ss-ok" : "ss-quota"}`}>
                {saved.enabled ? "已启用" : "已停用"}
              </span>
            )}
          </div>
          {saved && (
            <button
              type="button"
              className={`sk-toggle${saved.enabled ? " sk-on" : ""}`}
              onClick={handleToggle}
              disabled={persisting}
              aria-pressed={saved.enabled}
            >
              <span className="sk-toggle-dot" aria-hidden="true" />
              {saved.enabled ? "已启用" : "已停用"}
            </button>
          )}
        </div>
        <p className="ss-meta">
          接入任意兼容 OpenAI / Anthropic 协议的多模态模型(如视觉模型)。
          {saved ? (
            <>
              {" · 当前 "}
              <span className="ss-meta-url" title={saved.baseUrl}>
                {saved.baseUrl}
              </span>
              {" · key "}
              {maskTail(saved.apiKey)}
            </>
          ) : null}
        </p>

        <div className="sm-field">
          <span className="sm-field-label">API 协议类型</span>
          <select
            className="sm-field-input"
            value={protocol}
            disabled={persisting}
            onChange={(e) => {
              invalidateTest();
              setProtocol(e.target.value === "anthropic" ? "anthropic" : "openai");
            }}
          >
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic 兼容</option>
          </select>
        </div>
        <div className="sm-field">
          <span className="sm-field-label">API 地址(Base URL)</span>
          <input
            className={`sm-field-input${baseUrlValid === false ? " sm-field-input--invalid" : ""}`}
            placeholder="https://your-endpoint/v1"
            value={baseUrl}
            disabled={persisting}
            aria-invalid={baseUrlValid === false}
            aria-describedby={baseUrlValid === false ? "vision-base-url-error" : undefined}
            onChange={(e) => {
              invalidateTest();
              setBaseUrl(e.target.value);
            }}
          />
          {baseUrlValid === false && (
            <p className="sm-field-err" id="vision-base-url-error">
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
            placeholder={saved?.apiKey ? `已存 ${maskTail(saved.apiKey)}，留空沿用` : "sk-…"}
            value={apiKey}
            disabled={persisting}
            onChange={(e) => {
              invalidateTest();
              setApiKey(e.target.value);
            }}
          />
        </div>
        <div className="sm-field">
          <span className="sm-field-label">多模态模型名</span>
          <input
            className="sm-field-input"
            placeholder="如 qwen-vl-max / gpt-4o / claude-3-5-sonnet"
            value={model}
            disabled={persisting}
            onChange={(e) => {
              invalidateTest();
              setModel(e.target.value);
            }}
          />
        </div>

        <div className="sm-keyops">
          <button type="button" className="sm-btn" onClick={() => void handleTestAndSave()} disabled={testing || persisting}>
            {testing ? "测试中…" : "测试并保存"}
          </button>
          {saved && (
            <button type="button" className="sm-btn" onClick={() => void handleClear()} disabled={persisting}>
              清除
            </button>
          )}
        </div>
      </section>

      {message && <p className="sm-message">{message}</p>}
    </div>
  );
}

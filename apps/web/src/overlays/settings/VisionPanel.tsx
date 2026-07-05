import { useRef, useState } from "react";
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

export function VisionPanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const [saved, setSaved] = useState<VisionProvider | null>(() => readVisionProvider());
  const [protocol, setProtocol] = useState<"openai" | "anthropic">(
    () => readVisionProvider()?.protocol ?? "openai",
  );
  const [baseUrl, setBaseUrl] = useState(() => readVisionProvider()?.baseUrl ?? "");
  // 安全:不把已存的明文 key 回填进可编辑输入框(防肩窥/截屏泄漏)。留空=沿用已存 key。
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(() => readVisionProvider()?.model ?? "");
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // 测试并保存:先调后端 test 路由(代理避免 CORS、做真实 image part 连通性检查),通了再落本机。
  const handleTestAndSave = async () => {
    const base = baseUrl.trim();
    // 留空则沿用已存 key(不要求每次重输);只有从未存过 key 才报"缺 key"。
    const key = apiKey.trim() || saved?.apiKey || "";
    const mdl = model.trim();
    if (!base || !key || !mdl) {
      setMessage("请填写 API 地址、API key 与模型名");
      return;
    }
    if (!isHttpUrl(base)) {
      setMessage("API 地址格式不对:需以 http(s):// 开头");
      return;
    }
    setTesting(true);
    setMessage(null);
    // 超时保护:测的是用户填的第三方 baseUrl,不可信;无 AbortController 时 fetch 会无限挂起,
    // 按钮永远卡"测试中…"=整页假死(e2e E1-h2)。
    const testCtrl = new AbortController();
    const testTimer = setTimeout(() => testCtrl.abort(), 25_000);
    try {
      const res = await fetch("/api/v1/settings/vision/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol, baseUrl: base, apiKey: key, model: mdl }),
        signal: testCtrl.signal,
      });
      if (res.status === 400) {
        if (mountedRef.current) setMessage("配置无效,请检查 API 地址 / 模型名格式");
        return;
      }
      const body = (await res.json()) as { ok?: boolean; errorKind?: VisionTestErrorKind };
      if (!body.ok) {
        if (mountedRef.current) setMessage(`测试失败:${testErrorLabel(body.errorKind)}`);
        return;
      }
      const next: VisionProvider = { enabled: true, protocol, baseUrl: base, apiKey: key, model: mdl };
      writeVisionProvider(next);
      if (mountedRef.current) {
        setSaved(next);
        setMessage(null);
        toast.show("测试通过,图像识别已启用");
      }
    } catch (e) {
      if (mountedRef.current)
        setMessage(
          e instanceof DOMException && e.name === "AbortError"
            ? "测试超时:接口 25 秒无响应,请检查 API 地址是否可达"
            : "测试失败:网络异常",
        );
    } finally {
      clearTimeout(testTimer);
      if (mountedRef.current) setTesting(false);
    }
  };

  const handleToggle = () => {
    if (!saved) return;
    const next = { ...saved, enabled: !saved.enabled };
    writeVisionProvider(next);
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
    clearVisionProvider();
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
        主模型 DeepSeek 暂不支持图片识别,需要单独接入一个视觉模型。配置保存在
        {typeof window !== "undefined" && window.electron?.isDesktop ? "本机" : "本浏览器"}
        ,使用识图时会随请求发送给该模型。
      </p>

      {/* DeepSeek 原生多模态:暂不可用,占位 disable;待官方支持后复用主模型 key */}
      <section className="ss-card sm-disabled">
        <div className="ss-head">
          <div className="ss-titleline">
            <h3 className="sm-title">DeepSeek 原生图像识别</h3>
            <span className="ss-badge ss-quota">暂未支持</span>
          </div>
          <button type="button" className="sm-btn" disabled aria-disabled="true">
            即将支持
          </button>
        </div>
        <p className="ss-meta">DeepSeek 暂不支持多模态;开通后将自动复用主模型 key,无需在此重复配置。</p>
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
            onChange={(e) => setProtocol(e.target.value === "anthropic" ? "anthropic" : "openai")}
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
            aria-invalid={baseUrlValid === false}
            aria-describedby={baseUrlValid === false ? "vision-base-url-error" : undefined}
            onChange={(e) => setBaseUrl(e.target.value)}
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
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div className="sm-field">
          <span className="sm-field-label">多模态模型名</span>
          <input
            className="sm-field-input"
            placeholder="如 qwen-vl-max / gpt-4o / claude-3-5-sonnet"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>

        <div className="sm-keyops">
          <button type="button" className="sm-btn" onClick={() => void handleTestAndSave()} disabled={testing}>
            {testing ? "测试中…" : "测试并保存"}
          </button>
          {saved && (
            <button type="button" className="sm-btn" onClick={() => void handleClear()} disabled={testing}>
              清除
            </button>
          )}
        </div>
      </section>

      {message && <p className="sm-message">{message}</p>}
    </div>
  );
}

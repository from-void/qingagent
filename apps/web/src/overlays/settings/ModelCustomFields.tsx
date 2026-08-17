import { SkinSelect } from "../../system/SkinSelect";
import type { KeyboardEventHandler } from "react";
import { MODEL_DEFAULTS } from "./modelSettingsTypes";
import { SecretInput } from "./SecretInput";
import type { ModelProvider } from "./visitorKeyStore";

export interface ModelCustomFieldValues {
  protocol: string;
  baseUrl: string;
  apiKey: string;
  modelFlash: string;
  modelPro: string;
}

export function ModelCustomFields({
  provider,
  values,
  disabled,
  baseUrlValid,
  errorId = "model-custom-base-url-error",
  onApiKeyKeyDown,
  onChange,
}: {
  provider: ModelProvider;
  values: ModelCustomFieldValues;
  disabled: boolean;
  baseUrlValid: boolean | null;
  errorId?: string;
  onApiKeyKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  onChange: <K extends keyof ModelCustomFieldValues>(
    key: K,
    value: ModelCustomFieldValues[K],
  ) => void;
}) {
  return (
    <>
      <div className="sm-field">
        <span className="sm-field-label">API 协议类型</span>
        <SkinSelect
          className="sm-field-select"
          value={provider === "kimi" ? "openai" : values.protocol}
          disabled={disabled || provider === "kimi"}
          ariaLabel="API 协议类型"
          skin="ink"
          options={[
            { value: "openai", label: "OpenAI 兼容" },
            ...(provider === "deepseek"
              ? [{ value: "anthropic", label: "Anthropic 兼容" }]
              : []),
          ]}
          onChange={(value) => onChange("protocol", value)}
        />
      </div>
      <label className="sm-field">
        <span className="sm-field-label">API 地址(Base URL)</span>
        <input
          className={`sm-field-input${baseUrlValid === false ? " sm-field-input--invalid" : ""}`}
          placeholder="https://your-endpoint/v1"
          value={values.baseUrl}
          disabled={disabled}
          aria-invalid={baseUrlValid === false}
          aria-describedby={baseUrlValid === false ? errorId : undefined}
          onChange={(event) => onChange("baseUrl", event.target.value)}
        />
        {baseUrlValid === false && (
          <span className="sm-field-err" id={errorId}>
            请输入完整地址,需以 http(s):// 开头,如 https://your-endpoint/v1
          </span>
        )}
      </label>
      <label className="sm-field">
        <span className="sm-field-label">API key</span>
        <SecretInput
          autoComplete="off"
          spellCheck={false}
          className="sm-field-input"
          placeholder="sk-…"
          value={values.apiKey}
          disabled={disabled}
          onChange={(event) => onChange("apiKey", event.target.value)}
          onKeyDown={onApiKeyKeyDown}
        />
      </label>
      <label className="sm-field">
        <span className="sm-field-label">
          {provider === "kimi" ? "K2.7 Code（Flash）模型别名" : "V4 Flash 模型别名(可选)"}
        </span>
        <input
          className="sm-field-input"
          placeholder={MODEL_DEFAULTS[provider].flash}
          value={values.modelFlash}
          disabled={disabled}
          onChange={(event) => onChange("modelFlash", event.target.value)}
        />
      </label>
      <label className="sm-field">
        <span className="sm-field-label">
          {provider === "kimi" ? "K3（Pro）模型别名" : "V4 PRO 模型别名(可选)"}
        </span>
        <input
          className="sm-field-input"
          placeholder={MODEL_DEFAULTS[provider].pro}
          value={values.modelPro}
          disabled={disabled}
          onChange={(event) => onChange("modelPro", event.target.value)}
        />
      </label>
      <p className="sm-other-note">
        {provider === "kimi"
          ? "档位固定映射 Flash → kimi-for-coding、Pro → k3；第三方中转别名不同时可在上方修改。"
          : "默认适配 DeepSeek 模型。其他模型可在上面改成对应别名自行尝试(效果不保证);两者留空则默认用 deepseek-v4-flash。"}
      </p>
    </>
  );
}

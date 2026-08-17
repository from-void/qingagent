import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@qingagent/ui-kit";
import { ModelCustomFields, type ModelCustomFieldValues } from "../../overlays/settings/ModelCustomFields";
import {
  testCustomModelConnection,
  testOfficialModelKey,
} from "../../overlays/settings/modelConnectionClient";
import { MODEL_DEFAULTS, type BalanceState } from "../../overlays/settings/modelSettingsTypes";
import { SecretInput } from "../../overlays/settings/SecretInput";
import {
  clearCustomProvider,
  clearVisitorModelKey,
  setSelectedModelProvider,
  setVisitorModelKey,
  writeCustomProvider,
  writeOfficialModelOverride,
  type ModelProvider,
} from "../../overlays/settings/visitorKeyStore";
import { useOnboardingSettings } from "../../system/onboarding/OnboardingSettingsContext";
import { CheckIcon } from "../../system/icons";
import { DeepSeekColorIcon, KimiColorIcon } from "./ProviderBrandIcons";
import "./onboarding.css";

type SetupMode = "official" | "custom";
type ValidationStatus = "idle" | "checking" | "ok" | "fail";

interface ValidationState {
  status: ValidationStatus;
  message: string;
  fingerprint: string;
  normalizedBaseUrl?: string;
}

interface ProviderFormState {
  mode: SetupMode;
  officialKey: string;
  custom: ModelCustomFieldValues;
  officialValidation: ValidationState;
  customValidation: ValidationState;
}

const EMPTY_VALIDATION: ValidationState = { status: "idle", message: "", fingerprint: "" };
const PROVIDERS: readonly ModelProvider[] = ["deepseek", "kimi"];
const PROVIDER_META: Record<ModelProvider, {
  name: string;
  description: string;
  keyLabel: string;
  keyPlaceholder: string;
}> = {
  deepseek: {
    name: "DeepSeek",
    description: "基于 V4 模型驱动,又快又省",
    keyLabel: "DeepSeek 官方 API Key",
    keyPlaceholder: "粘贴 sk- 开头的密钥",
  },
  kimi: {
    name: "Kimi",
    description: "基于 K3 / 2.7 code 驱动,国产最强模型",
    keyLabel: "Kimi 官方 API Key",
    keyPlaceholder: "粘贴 Kimi API key",
  },
};

function createProviderForm(provider: ModelProvider): ProviderFormState {
  return {
    mode: "official",
    officialKey: "",
    custom: {
      protocol: "openai",
      baseUrl: "",
      apiKey: "",
      modelFlash: MODEL_DEFAULTS[provider].flash,
      modelPro: MODEL_DEFAULTS[provider].pro,
    },
    officialValidation: { ...EMPTY_VALIDATION },
    customValidation: { ...EMPTY_VALIDATION },
  };
}

function validHttpBaseUrl(value: string): boolean | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function officialKeyError(value: string): string | null {
  const key = value.trim();
  if (!key.startsWith("sk-")) return "格式不正确：密钥应以 sk- 开头";
  if (key.length < 16) return "格式不完整：请粘贴完整密钥";
  return null;
}

function officialFingerprint(form: ProviderFormState): string {
  return form.officialKey.trim();
}

function customFingerprint(form: ProviderFormState): string {
  const value = form.custom;
  return JSON.stringify([
    value.protocol,
    value.baseUrl.trim(),
    value.apiKey.trim(),
    value.modelFlash.trim(),
    value.modelPro.trim(),
  ]);
}

function validationFor(form: ProviderFormState, mode: SetupMode): ValidationState {
  return mode === "official" ? form.officialValidation : form.customValidation;
}

function currentFingerprint(form: ProviderFormState, mode: SetupMode): string {
  return mode === "official" ? officialFingerprint(form) : customFingerprint(form);
}

function isValidationCurrent(form: ProviderFormState, mode: SetupMode): boolean {
  const validation = validationFor(form, mode);
  return validation.status === "ok" && validation.fingerprint === currentFingerprint(form, mode);
}

function deepseekSuccessMessage(body: BalanceState): string {
  const balance = body.balances?.find((item) => item.currency.toUpperCase() === "CNY")
    ?? body.balances?.[0];
  return balance?.total
    ? `密钥可用 · 余额 ¥${balance.total}`
    : "密钥可用";
}

export function OnboardingPage() {
  const onboarding = useOnboardingSettings();
  const [selectedProvider, setSelectedProvider] = useState<ModelProvider>("deepseek");
  const [forms, setForms] = useState<Record<ModelProvider, ProviderFormState>>(() => ({
    deepseek: createProviderForm("deepseek"),
    kimi: createProviderForm("kimi"),
  }));
  const formsRef = useRef(forms);
  formsRef.current = forms;
  const validationRevisionRef = useRef(0);
  const validationControllerRef = useRef<AbortController | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState("");

  const setValidation = (
    provider: ModelProvider,
    mode: SetupMode,
    validation: ValidationState,
  ) => {
    setForms((current) => ({
      ...current,
      [provider]: {
        ...current[provider],
        [mode === "official" ? "officialValidation" : "customValidation"]: validation,
      },
    }));
  };

  const updateOfficialKey = (provider: ModelProvider, value: string) => {
    setSubmitMessage("");
    setForms((current) => ({
      ...current,
      [provider]: {
        ...current[provider],
        officialKey: value,
        officialValidation: { ...EMPTY_VALIDATION },
      },
    }));
  };

  const updateCustom = <K extends keyof ModelCustomFieldValues>(
    provider: ModelProvider,
    key: K,
    value: ModelCustomFieldValues[K],
  ) => {
    setSubmitMessage("");
    setForms((current) => ({
      ...current,
      [provider]: {
        ...current[provider],
        custom: { ...current[provider].custom, [key]: value },
        customValidation: { ...EMPTY_VALIDATION },
      },
    }));
  };

  const runValidation = async (provider: ModelProvider, mode: SetupMode) => {
    const form = formsRef.current[provider];
    const fingerprint = currentFingerprint(form, mode);
    if (mode === "official") {
      const formatError = officialKeyError(form.officialKey);
      if (formatError) {
        setValidation(provider, mode, { status: "fail", message: formatError, fingerprint });
        return;
      }
    } else {
      const baseUrlStatus = validHttpBaseUrl(form.custom.baseUrl);
      if (baseUrlStatus === false) {
        setValidation(provider, mode, {
          status: "fail",
          message: "API 地址格式不正确",
          fingerprint,
        });
        return;
      }
      if (!form.custom.baseUrl.trim() || !form.custom.apiKey.trim()) return;
    }

    const revision = ++validationRevisionRef.current;
    validationControllerRef.current?.abort();
    const controller = new AbortController();
    validationControllerRef.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 25_000);
    const obsolete = () =>
      validationRevisionRef.current !== revision || (controller.signal.aborted && !timedOut);
    setValidation(provider, mode, { status: "checking", message: "", fingerprint });
    try {
      if (mode === "official") {
        const body = await testOfficialModelKey({
          provider,
          apiKey: form.officialKey,
          signal: controller.signal,
        });
        if (obsolete()) return;
        if (timedOut) {
          setValidation(provider, mode, {
            status: "fail",
            message: "网络连接超时，请检查后重试",
            fingerprint,
          });
          return;
        }
        if (body.ok) {
          setValidation(provider, mode, {
            status: "ok",
            message: provider === "deepseek"
              ? deepseekSuccessMessage(body)
              : "密钥可用 · K3 权限已开通",
            fingerprint,
          });
        } else {
          setValidation(provider, mode, {
            status: "fail",
            message: body.keyInvalid
              ? "密钥无效：请重新复制完整密钥"
              : body.permissionDenied
                ? "Kimi 返回权限不足：请核对套餐与模型权限"
                : body.error ?? "验证未完成，请重试",
            fingerprint,
          });
        }
      } else {
        const custom = form.custom;
        const body = await testCustomModelConnection({
          provider,
          baseUrl: custom.baseUrl.trim(),
          apiKey: custom.apiKey.trim(),
          model: custom.modelFlash.trim() || MODEL_DEFAULTS[provider].flash,
          protocol: provider === "kimi" ? "openai" : custom.protocol,
        }, controller.signal);
        if (obsolete()) return;
        if (timedOut) {
          setValidation(provider, mode, {
            status: "fail",
            message: "网络连接超时，请检查后重试",
            fingerprint,
          });
          return;
        }
        setValidation(provider, mode, body.ok
          ? {
              status: "ok",
              message: "连接成功 · 模型可用",
              fingerprint,
              normalizedBaseUrl: body.normalizedBaseUrl?.trim() || custom.baseUrl.trim(),
            }
          : {
              status: "fail",
              message: body.keyInvalid
                ? "密钥无效或无权限，请检查"
                : body.permissionDenied
                  ? "Kimi 返回权限不足：请核对套餐与模型权限"
                  : body.error ?? "连接测试未完成，请重试",
              fingerprint,
            });
      }
    } catch (error) {
      if (obsolete()) return;
      setValidation(provider, mode, {
        status: "fail",
        message: timedOut || (error instanceof DOMException && error.name === "AbortError")
          ? "网络连接超时，请检查后重试"
          : "网络连接未完成，请重试",
        fingerprint,
      });
    } finally {
      window.clearTimeout(timeout);
      if (validationControllerRef.current === controller) {
        validationControllerRef.current = null;
      }
    }
  };

  const activeForm = forms[selectedProvider];
  const activeMode = activeForm.mode;
  const activeFingerprint = currentFingerprint(activeForm, activeMode);
  const activeEligible = activeMode === "official"
    ? officialKeyError(activeForm.officialKey) === null
    : validHttpBaseUrl(activeForm.custom.baseUrl) === true && Boolean(activeForm.custom.apiKey.trim());

  useEffect(() => {
    if (!activeEligible || isValidationCurrent(activeForm, activeMode)) return;
    const timer = window.setTimeout(() => {
      void runValidation(selectedProvider, activeMode);
    }, 600);
    return () => window.clearTimeout(timer);
    // fingerprint 已覆盖会影响测试请求的所有字段；status 改变不应重启 debounce。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEligible, activeFingerprint, activeMode, selectedProvider]);

  useEffect(() => () => validationControllerRef.current?.abort(), []);

  const validatedChoice = (): { provider: ModelProvider; mode: SetupMode } | null => {
    const preferred: Array<{ provider: ModelProvider; mode: SetupMode }> = [
      { provider: selectedProvider, mode: forms[selectedProvider].mode },
      { provider: selectedProvider, mode: forms[selectedProvider].mode === "official" ? "custom" : "official" },
      ...PROVIDERS.filter((provider) => provider !== selectedProvider).flatMap((provider) => [
        { provider, mode: forms[provider].mode },
        { provider, mode: forms[provider].mode === "official" ? "custom" as const : "official" as const },
      ]),
    ];
    return preferred.find(({ provider, mode }) => isValidationCurrent(forms[provider], mode)) ?? null;
  };
  const canStart = validatedChoice() !== null;

  const persistChoice = async ({ provider, mode }: { provider: ModelProvider; mode: SetupMode }) => {
    const form = formsRef.current[provider];
    if (mode === "official") {
      if (!await setVisitorModelKey(provider, form.officialKey.trim())) return false;
      if (!await clearCustomProvider(provider)) return false;
      if (!await writeOfficialModelOverride({}, provider)) return false;
    } else {
      const validation = form.customValidation;
      const custom = form.custom;
      if (!await writeCustomProvider({
        protocol: provider === "kimi" ? "openai" : custom.protocol,
        baseUrl: validation.normalizedBaseUrl || custom.baseUrl.trim(),
        apiKey: custom.apiKey.trim(),
        modelFlash: custom.modelFlash.trim() || MODEL_DEFAULTS[provider].flash,
        modelPro: custom.modelPro.trim() || MODEL_DEFAULTS[provider].pro,
      }, provider)) return false;
      if (!await clearVisitorModelKey(provider)) return false;
    }
    return setSelectedModelProvider(provider);
  };

  const handleStart = async () => {
    if (submitting) return;
    const choice = validatedChoice();
    if (!choice) {
      await runValidation(selectedProvider, activeMode);
      return;
    }
    setSubmitting(true);
    setSubmitMessage("");
    const persisted = await persistChoice(choice);
    if (!persisted) {
      setSubmitting(false);
      setSubmitMessage("密钥已通过验证，但本机保存未完成，请重试");
      return;
    }
    if (!await onboarding.complete("done")) {
      setSubmitting(false);
      setSubmitMessage("配置已保存，引导状态暂未写入，请重试");
    }
  };

  const handleSkip = async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitMessage("");
    if (!await onboarding.complete("skipped")) {
      setSubmitting(false);
      setSubmitMessage("暂时无法保存跳过状态，请重试");
    }
  };

  const handleKeyEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (canStart) void handleStart();
    else void runValidation(selectedProvider, activeMode);
  };

  const activeValidation = validationFor(activeForm, activeMode);
  const baseUrlValid = validHttpBaseUrl(activeForm.custom.baseUrl);

  return (
    <main className="onboarding-page" data-view="onboarding" aria-labelledby="onboarding-title">
      <section className="onboarding-column">
        <h1 id="onboarding-title">模型 API 配置</h1>

        <div className="onboarding-provider-cards" role="radiogroup" aria-label="模型厂商">
          {PROVIDERS.map((provider) => {
            const meta = PROVIDER_META[provider];
            const selected = provider === selectedProvider;
            return (
              <button
                key={provider}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`onboarding-provider-card${selected ? " is-selected" : ""}`}
                onClick={() => setSelectedProvider(provider)}
              >
                {provider === "deepseek" ? (
                  <span className="onboarding-provider-recommended">推荐</span>
                ) : null}
                <ProviderLogo provider={provider} />
                <strong>{meta.name}</strong>
                <span>{meta.description}</span>
              </button>
            );
          })}
        </div>

        <section className="onboarding-form" aria-label={`${PROVIDER_META[selectedProvider].name} 配置`}>
          <div className="onboarding-label-row">
            <span className="onboarding-field-title">
              {activeMode === "official" ? PROVIDER_META[selectedProvider].keyLabel : "自定义 API"}
            </span>
            <button
              type="button"
              className="onboarding-mode-switch"
              disabled={submitting}
              onClick={() => {
                validationRevisionRef.current += 1;
                validationControllerRef.current?.abort();
                setForms((current) => ({
                  ...current,
                  [selectedProvider]: {
                    ...current[selectedProvider],
                    mode: activeMode === "official" ? "custom" : "official",
                  },
                }));
              }}
            >
              {activeMode === "official" ? "想使用自定义 API key?" : "返回官方 API"}
            </button>
          </div>

          {activeMode === "official" ? (
            <>
              <label className="onboarding-secret-field">
                <span className="onboarding-sr-only">{PROVIDER_META[selectedProvider].keyLabel}</span>
                <SecretInput
                  autoComplete="off"
                  spellCheck={false}
                  className="onboarding-key-input"
                  placeholder={PROVIDER_META[selectedProvider].keyPlaceholder}
                  value={activeForm.officialKey}
                  disabled={submitting}
                  onChange={(event) => updateOfficialKey(selectedProvider, event.target.value)}
                  onKeyDown={handleKeyEnter}
                />
              </label>
              <ValidationLine validation={activeValidation} />
              {selectedProvider === "deepseek" ? (
                <a
                  className="onboarding-help-link"
                  href="https://qingagent.com/blog/setup-deepseek"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  如何获取?
                </a>
              ) : (
                <details className="onboarding-help">
                  <summary>如何获取?</summary>
                  <ol>
                    <li>
                      前往{" "}
                      <a
                        href="https://platform.moonshot.cn/"
                        target="_blank"
                        rel="noreferrer"
                      >
                        platform.moonshot.cn
                      </a>
                      {" "}并登录
                    </li>
                    <li>进入 API Key 管理，新建并复制密钥</li>
                    <li>确认套餐已开通 K3 / K2.7 Code 权限</li>
                  </ol>
                </details>
              )}
            </>
          ) : (
            <div className="onboarding-custom-fields">
              <ModelCustomFields
                provider={selectedProvider}
                values={activeForm.custom}
                disabled={submitting}
                baseUrlValid={baseUrlValid}
                errorId={`onboarding-${selectedProvider}-base-url-error`}
                onApiKeyKeyDown={handleKeyEnter}
                onChange={(key, value) => updateCustom(selectedProvider, key, value)}
              />
              <ValidationLine validation={activeValidation} />
            </div>
          )}
        </section>

        {submitMessage ? <p className="onboarding-submit-message" role="status">{submitMessage}</p> : null}
        <div className="onboarding-actions">
          <Button type="button" variant="ghost" disabled={submitting} onClick={() => void handleSkip()}>
            先跳过
          </Button>
          <Button type="button" variant="primary" disabled={!canStart || submitting} onClick={() => void handleStart()}>
            {submitting ? "保存中…" : "开始使用"}
          </Button>
        </div>
      </section>
    </main>
  );
}

export function OnboardingLoadingPage() {
  return <div className="onboarding-loading-page" aria-label="正在读取模型配置" />;
}

function ProviderLogo({ provider }: { provider: ModelProvider }) {
  return (
    <span className={`onboarding-provider-logo onboarding-provider-logo--${provider}`} aria-hidden="true">
      {provider === "deepseek" ? <DeepSeekColorIcon /> : <KimiColorIcon />}
    </span>
  );
}

function ValidationLine({ validation }: { validation: ValidationState }) {
  if (validation.status === "idle") return <div className="onboarding-validation" aria-hidden="true" />;
  return (
    <div
      className={`onboarding-validation is-${validation.status}`}
      role="status"
      aria-live="polite"
    >
      {validation.status === "checking" ? <span className="onboarding-spinner" aria-hidden="true" /> : null}
      {validation.status === "ok" ? <CheckIcon size={13} /> : null}
      <span>{validation.status === "checking" ? "正在检测密钥…" : validation.message}</span>
    </div>
  );
}

// 模型 key 门禁：只有“已明确无 key”才禁用发送；本地持久层不可读时保持 loading/fail-open。
// 当前厂商无 key、另一家可用时给明确的一键切换，不静默改变 provider。
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CLIENT_PERSIST_CHANGED_EVENT,
} from "../overlays/settings/clientPersist";
import {
  readLocalModelKeySnapshot,
  setSelectedModelProvider,
  type LocalModelKeySnapshot,
  type ModelProvider,
} from "../overlays/settings/visitorKeyStore";
import { useToast } from "./ToastProvider";
import { ArrowRightIcon } from "./icons";

const OPEN_SETTINGS_FLAG = "qj-open-settings";
const RETRY_DELAYS_MS = [50, 100, 250, 500, 1_000] as const;

export type ModelKeyGateSnapshot =
  | { status: "loading" }
  | { status: "configured"; provider: ModelProvider }
  | {
      status: "unconfigured";
      provider: ModelProvider;
      fallbackProvider: ModelProvider | null;
    };

interface ModelKeySettingsResponse {
  provider?: ModelProvider;
  apiKeyConfigured?: boolean;
  providers?: Partial<Record<ModelProvider, { apiKeyConfigured?: boolean }>>;
}

function providerName(provider: ModelProvider): string {
  return provider === "kimi" ? "Kimi" : "DeepSeek";
}

function oppositeProvider(provider: ModelProvider): ModelProvider {
  return provider === "kimi" ? "deepseek" : "kimi";
}

function localRequestProvider(
  local: LocalModelKeySnapshot,
  serverProvider?: ModelProvider,
): ModelProvider {
  if (local.provider) return local.provider;
  // 兼容旧数据：只要已有任一 DeepSeek 显式配置，就继续锁定 DeepSeek。
  if (local.providers.deepseek.hasExplicitConfig) return "deepseek";
  return serverProvider ?? "deepseek";
}

function serverProviderConfigured(
  body: ModelKeySettingsResponse,
  provider: ModelProvider,
): boolean {
  const configured = body.providers?.[provider]?.apiKeyConfigured;
  if (typeof configured === "boolean") return configured;
  if (body.provider === provider && typeof body.apiKeyConfigured === "boolean") {
    return body.apiKeyConfigured;
  }
  throw new Error(`model settings response is missing ${provider} apiKeyConfigured`);
}

function configuredFromLocal(
  local: LocalModelKeySnapshot,
): ModelKeyGateSnapshot | null {
  const provider = localRequestProvider(local, undefined);
  if (
    (local.provider || local.providers.deepseek.hasExplicitConfig) &&
    local.providers[provider].configured
  ) {
    return { status: "configured", provider };
  }
  return null;
}

function initialGateSnapshot(): ModelKeyGateSnapshot {
  const local = readLocalModelKeySnapshot();
  return local ? configuredFromLocal(local) ?? { status: "loading" } : { status: "loading" };
}

/** 一次读取当前 provider 与两家配置态；旧请求永远不能覆盖新配置。 */
export function useModelKeyGate(): ModelKeyGateSnapshot {
  const [snapshot, setSnapshot] = useState<ModelKeyGateSnapshot>(initialGateSnapshot);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  useEffect(() => {
    let alive = true;
    let generation = 0;
    let retryIndex = 0;
    let retryTimer: number | null = null;
    let fetchController: AbortController | null = null;

    const clearRetry = () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
    };

    const publish = (next: ModelKeyGateSnapshot) => {
      if (!alive) return;
      snapshotRef.current = next;
      setSnapshot(next);
    };

    const scheduleRetry = (recompute: () => void) => {
      if (retryTimer !== null) return;
      const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)]!;
      retryIndex += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        recompute();
      }, delay);
    };

    const recompute = () => {
      const currentGeneration = ++generation;
      fetchController?.abort();
      fetchController = null;
      const local = readLocalModelKeySnapshot();
      if (!local) {
        publish({ status: "loading" });
        scheduleRetry(recompute);
        return;
      }

      clearRetry();
      retryIndex = 0;
      const localConfigured = configuredFromLocal(local);
      if (localConfigured) {
        publish(localConfigured);
        return;
      }

      const controller = new AbortController();
      fetchController = controller;
      void (async () => {
        try {
          const res = await fetch("/api/v1/settings/model", { signal: controller.signal });
          if (!res.ok) throw new Error(`model settings request failed: ${res.status}`);
          const body = (await res.json()) as ModelKeySettingsResponse;
          const provider = localRequestProvider(local, body.provider);
          const otherProvider = oppositeProvider(provider);
          const providerConfigured =
            local.providers[provider].configured ||
            serverProviderConfigured(body, provider);
          const fallbackConfigured =
            local.providers[otherProvider].configured ||
            serverProviderConfigured(body, otherProvider);
          if (!alive || currentGeneration !== generation || controller.signal.aborted) return;
          publish(providerConfigured
            ? { status: "configured", provider }
            : {
                status: "unconfigured",
                provider,
                fallbackProvider: fallbackConfigured ? otherProvider : null,
              });
        } catch {
          if (!alive || currentGeneration !== generation || controller.signal.aborted) return;
          // 瞬态失败保留最后已知结论；若请求期间本地已写好 key，则立即升级放行。
          const latestLocal = readLocalModelKeySnapshot();
          const latestConfigured = latestLocal ? configuredFromLocal(latestLocal) : null;
          if (latestConfigured) publish(latestConfigured);
        }
      })();
    };

    const onSignal = () => recompute();
    const removeReadyListener = window.electron?.onClientConfigReady?.(onSignal);
    window.addEventListener(CLIENT_PERSIST_CHANGED_EVENT, onSignal);
    window.addEventListener("storage", onSignal);
    window.addEventListener("focus", onSignal);
    recompute();

    return () => {
      alive = false;
      generation += 1;
      fetchController?.abort();
      clearRetry();
      removeReadyListener?.();
      window.removeEventListener(CLIENT_PERSIST_CHANGED_EVENT, onSignal);
      window.removeEventListener("storage", onSignal);
      window.removeEventListener("focus", onSignal);
    };
  }, []);

  return snapshot;
}

/** 兼容只关心 boolean 的旧调用方；loading 保持 fail-open。 */
export function useModelKeyConfigured(): boolean {
  return useModelKeyGate().status !== "unconfigured";
}

// 「去配置」：携带目标厂商返回首页，设置弹框直接打开该厂商二级配置页。
export function goConfigureModel(
  navigateHome: () => void,
  provider?: ModelProvider,
): void {
  try {
    sessionStorage.setItem(
      OPEN_SETTINGS_FLAG,
      provider ? `model:${provider}` : "model",
    );
  } catch {
    /* ignore */
  }
  navigateHome();
}

export interface OpenSettingsTarget {
  tab: "model";
  provider?: ModelProvider;
}

export function readOpenSettingsFlag(): OpenSettingsTarget | null {
  try {
    const value = sessionStorage.getItem(OPEN_SETTINGS_FLAG);
    if (value === "model") return { tab: "model" };
    if (value === "model:deepseek") return { tab: "model", provider: "deepseek" };
    if (value === "model:kimi") return { tab: "model", provider: "kimi" };
  } catch {
    /* ignore */
  }
  return null;
}

export function clearOpenSettingsFlag(): void {
  try {
    sessionStorage.removeItem(OPEN_SETTINGS_FLAG);
  } catch {
    /* ignore */
  }
}

export function consumeOpenSettingsFlag(): boolean {
  if (readOpenSettingsFlag()) {
    clearOpenSettingsFlag();
    return true;
  }
  return false;
}

// 发送按钮上的门禁气泡：一键切换会等待 provider 真正落盘，再由同窗口配置事件触发门禁重算。
export function NoKeyTip({
  gate,
  active = false,
  forced = false,
  onConfigure,
  children,
}: {
  gate?: ModelKeyGateSnapshot;
  /** 仅保留给独立样式/demo 调用；产品路径应传 gate。 */
  active?: boolean;
  forced?: boolean;
  onConfigure: (provider: ModelProvider) => void;
  children: ReactNode;
}) {
  const toast = useToast();
  const [switching, setSwitching] = useState(false);
  const effectiveGate: ModelKeyGateSnapshot = gate ?? (
    active
      ? { status: "unconfigured", provider: "deepseek", fallbackProvider: null }
      : { status: "configured", provider: "deepseek" }
  );
  if (effectiveGate.status !== "unconfigured") return <>{children}</>;

  const { provider, fallbackProvider } = effectiveGate;
  const handlePrimaryAction = async () => {
    if (!fallbackProvider) {
      onConfigure(provider);
      return;
    }
    if (switching) return;
    setSwitching(true);
    const saved = await setSelectedModelProvider(fallbackProvider);
    setSwitching(false);
    toast.show(saved
      ? {
          message: `已切到 ${providerName(fallbackProvider)}`,
          tone: "success",
          dedupeKey: "model-gate-switch",
        }
      : {
          message: "本机保存失败，请重试",
          tone: "warn",
          dedupeKey: "model-gate-switch-failed",
        });
  };

  return (
    <span className={`nokey-gate${forced ? " is-forced" : ""}`}>
      {children}
      <span className="nokey-tip" role="tooltip">
        <span className="nokey-tip-text">
          当前使用中的 {providerName(provider)} 还没配置 key{fallbackProvider ? "。" : "，无法开始写作。"}
        </span>
        <button
          type="button"
          className="nokey-tip-btn"
          disabled={switching}
          onClick={() => void handlePrimaryAction()}
        >
          {fallbackProvider
            ? `切到 ${providerName(fallbackProvider)}`
            : `去配置 ${providerName(provider)}`}
          <ArrowRightIcon size={12} />
        </button>
      </span>
    </span>
  );
}

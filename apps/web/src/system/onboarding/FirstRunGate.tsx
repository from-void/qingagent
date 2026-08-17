import { useEffect, useState, type ReactNode } from "react";
import { CLIENT_PERSIST_CHANGED_EVENT } from "../../overlays/settings/clientPersist";
import { MODEL_VENDORS } from "../../overlays/settings/modelVendorMeta";
import { anyModelProviderConfigured } from "../../overlays/settings/modelSettingsTypes";
import {
  readLocalModelKeySnapshot,
  type LocalModelKeySnapshot,
  type ModelProvider,
} from "../../overlays/settings/visitorKeyStore";
import { useBackendConnection } from "../backendConnectionStore";
import { useOnboardingSettings } from "./OnboardingSettingsContext";

type ServerModelStatus = "idle" | "loading" | "configured" | "unconfigured" | "error";

interface ModelSettingsResponse {
  providers: Record<ModelProvider, { apiKeyConfigured: boolean }>;
}

function localHasConfiguredProvider(snapshot: LocalModelKeySnapshot | null): boolean {
  return anyModelProviderConfigured(MODEL_VENDORS, (provider) => ({
    localConfigured: snapshot?.providers[provider].configured,
  }));
}

export function FirstRunGate({
  children,
  onboarding,
  loading,
}: {
  children: ReactNode;
  onboarding: ReactNode;
  loading: ReactNode;
}) {
  const backend = useBackendConnection();
  const attachMode = backend?.mode === "attach" || (() => {
    try { return window.electron?.getBackendConnection?.()?.mode === "attach"; } catch { return false; }
  })();
  const settings = useOnboardingSettings();
  const [local, setLocal] = useState<LocalModelKeySnapshot | null>(
    () => readLocalModelKeySnapshot(),
  );
  const [serverStatus, setServerStatus] = useState<ServerModelStatus>("idle");
  const [presentingOnboarding, setPresentingOnboarding] = useState(false);

  useEffect(() => {
    if (attachMode) return;
    const update = () => setLocal(readLocalModelKeySnapshot());
    const removeReadyListener = window.electron?.onClientConfigReady?.(update);
    window.addEventListener(CLIENT_PERSIST_CHANGED_EVENT, update);
    window.addEventListener("storage", update);
    window.addEventListener("focus", update);
    update();
    return () => {
      removeReadyListener?.();
      window.removeEventListener(CLIENT_PERSIST_CHANGED_EVENT, update);
      window.removeEventListener("storage", update);
      window.removeEventListener("focus", update);
    };
  }, [attachMode]);

  const shouldReadServer = !attachMode &&
    local !== null &&
    !localHasConfiguredProvider(local) &&
    settings.status === "ready" &&
    settings.state === null &&
    !presentingOnboarding;

  useEffect(() => {
    if (!shouldReadServer) {
      setServerStatus("idle");
      return;
    }
    const controller = new AbortController();
    setServerStatus("loading");
    void (async () => {
      try {
        const response = await fetch("/api/v1/settings/model", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("model settings unavailable");
        const body = (await response.json()) as ModelSettingsResponse;
        if (controller.signal.aborted) return;
        const configured = anyModelProviderConfigured(MODEL_VENDORS, (provider) => ({
          serverConfigured: body.providers[provider].apiKeyConfigured,
        }));
        setServerStatus(configured ? "configured" : "unconfigured");
      } catch {
        if (!controller.signal.aborted) setServerStatus("error");
      }
    })();
    return () => controller.abort();
  }, [shouldReadServer]);

  useEffect(() => {
    if (serverStatus === "unconfigured") setPresentingOnboarding(true);
  }, [serverStatus]);

  if (attachMode) return <>{children}</>;
  if (settings.state) return <>{children}</>;
  // 一旦首启页已交给用户，本轮就保持在该页；保存 key 产生的本地配置事件不能抢先跳首页，
  // 必须等 onboarding_state 真正写成功。
  if (presentingOnboarding) return <>{onboarding}</>;
  if (localHasConfiguredProvider(local)) return <>{children}</>;
  if (serverStatus === "configured") return <>{children}</>;
  if (settings.status === "error" || serverStatus === "error") return <>{children}</>;
  if (local === null || settings.status === "loading" || serverStatus !== "unconfigured") {
    return <>{loading}</>;
  }
  return <>{onboarding}</>;
}

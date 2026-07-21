import { useEffect, useState, type MouseEvent } from "react";
import { useToast } from "../../system/ToastProvider";

type SecurityKind = "install" | "command" | "send" | "connect";

interface SecurityCategory {
  kind: SecurityKind;
  label: string;
  needConfirmation: boolean;
  mutable: boolean;
}

interface SecuritySettingsResponse {
  categories: SecurityCategory[];
  insecureRememberAllowed: boolean;
}

export function SecurityPanel() {
  const toast = useToast();
  const [settings, setSettings] = useState<SecuritySettingsResponse | null>(null);
  const [busy, setBusy] = useState<SecurityKind | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/settings/security", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as Partial<SecuritySettingsResponse>;
        if (!Array.isArray(body.categories)) throw new Error("invalid security settings");
        return body as SecuritySettingsResponse;
      })
      .then((body) => setSettings(body))
      .catch(() => {
        if (controller.signal.aborted) return;
        toast.show({ message: "安全设置加载失败，请稍后重试", tone: "error" });
      });
    return () => controller.abort();
  }, [toast]);

  const toggle = async (
    category: SecurityCategory,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    if (!category.mutable || busy) return;
    const needConfirmation = !category.needConfirmation;
    let uiGrantNonce: string | undefined;
    if (!needConfirmation && !settings?.insecureRememberAllowed) {
      const requestGrant = window.electron?.requestSettingsRememberGrant;
      if (!requestGrant || !event.isTrusted) {
        toast.show({ message: "仅可在桌面端通过真实操作关闭确认", tone: "warn" });
        return;
      }
      try {
        uiGrantNonce = await requestGrant({
          kind: category.kind as "install" | "command",
          trustedGesture: event.isTrusted,
        }) ?? undefined;
      } catch {
        uiGrantNonce = undefined;
      }
      if (!uiGrantNonce) {
        toast.show({ message: "未取得桌面安全授权，设置未更改", tone: "warn" });
        return;
      }
    }

    setBusy(category.kind);
    try {
      const response = await fetch(`/api/v1/settings/security/${category.kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ needConfirmation, ...(uiGrantNonce ? { uiGrantNonce } : {}) }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setSettings((current) => current ? {
        ...current,
        categories: current.categories.map((item) => item.kind === category.kind
          ? { ...item, needConfirmation }
          : item),
      } : current);
      toast.show({
        message: needConfirmation ? `${category.label}已恢复逐次确认` : `${category.label}已默认同意`,
        tone: "success",
      });
    } catch {
      toast.show({ message: "安全设置更新失败，请重试", tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="security-panel" data-wf="SecurityPanel">
      <header className="security-head">
        <h2>指令确认</h2>
        <p>关闭后，同类指令会直接执行；可随时重新开启确认。</p>
      </header>
      <div className="security-list" aria-busy={settings === null}>
        {settings?.categories.map((category) => (
          <div className="security-row" key={category.kind}>
            <div className="security-copy">
              <span className="security-label">{category.label}</span>
              <span className="security-meta">
                {category.mutable
                  ? category.needConfirmation ? "每次执行前询问" : "已默认同意"
                  : "始终需要确认"}
              </span>
            </div>
            <button
              type="button"
              className={`security-toggle${category.needConfirmation ? " is-on" : ""}`}
              aria-label={`${category.label}需要确认`}
              aria-pressed={category.needConfirmation}
              disabled={!category.mutable || busy !== null}
              onClick={(event) => void toggle(category, event)}
            >
              <span className="security-toggle-dot" aria-hidden="true" />
              {category.mutable ? category.needConfirmation ? "需要确认" : "默认同意" : "始终确认"}
            </button>
          </div>
        )) ?? <p className="security-loading">正在读取安全设置…</p>}
      </div>
      {settings?.insecureRememberAllowed && (
        <p className="security-dev-note">本地开发的不安全记忆模式已开启。</p>
      )}
    </div>
  );
}

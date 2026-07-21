import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { useToast } from "../../system/ToastProvider";
import {
  publishRememberGrantState,
  subscribeRememberGrantState,
  type RememberGrantCanonical,
} from "../../system/confirmGrantState";

type SecurityKind = "install" | "command" | "send" | "connect";
type UpdatePhase = "idle" | "updating" | "settled";

interface SecurityCategory {
  kind: SecurityKind;
  label: string;
  needConfirmation: boolean;
  mutable: boolean;
  present: boolean;
  grantId: string | null;
  version: number;
}

interface SecuritySettingsResponse {
  categories: SecurityCategory[];
  insecureRememberAllowed: boolean;
}

const POST_TIMEOUT_MS = 8_000;
const fixedCategoryReasons: Partial<Record<SecurityKind, string>> = {
  send: "发出后不能撤回，所以每次都会询问。",
  connect: "连接会改变可访问的内容，所以每次连接前都会询问。",
};

function isCategory(value: unknown): value is SecurityCategory {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return (
    (input.kind === "install" || input.kind === "command" || input.kind === "send" || input.kind === "connect") &&
    typeof input.label === "string" &&
    typeof input.needConfirmation === "boolean" &&
    typeof input.mutable === "boolean" &&
    typeof input.present === "boolean" &&
    (input.grantId === null || typeof input.grantId === "string") &&
    Number.isSafeInteger(input.version) &&
    Number(input.version) >= 0
  );
}

function parseSettings(value: unknown): SecuritySettingsResponse {
  if (!value || typeof value !== "object") throw new Error("invalid security settings");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.categories) || !input.categories.every(isCategory)) {
    throw new Error("invalid security settings");
  }
  if (typeof input.insecureRememberAllowed !== "boolean") {
    throw new Error("invalid security settings");
  }
  return {
    categories: input.categories,
    insecureRememberAllowed: input.insecureRememberAllowed,
  };
}

function parseCanonical(kind: SecurityKind, value: unknown): RememberGrantCanonical {
  if (kind !== "install" && kind !== "command") throw new Error("invalid grant kind");
  if (!value || typeof value !== "object") throw new Error("invalid grant state");
  const input = value as Record<string, unknown>;
  if (
    input.present === undefined || typeof input.present !== "boolean" ||
    (input.grantId !== null && typeof input.grantId !== "string") ||
    !Number.isSafeInteger(input.version) || Number(input.version) < 0
  ) {
    throw new Error("invalid grant state");
  }
  return {
    kind,
    present: input.present,
    grantId: input.grantId as string | null,
    version: Number(input.version),
  };
}

function mergeSettings(
  current: SecuritySettingsResponse | null,
  incoming: SecuritySettingsResponse,
): SecuritySettingsResponse {
  if (!current) return incoming;
  const currentByKind = new Map(current.categories.map((item) => [item.kind, item]));
  return {
    ...incoming,
    categories: incoming.categories.map((item) => {
      const previous = currentByKind.get(item.kind);
      return previous && previous.version > item.version ? previous : item;
    }),
  };
}

export function SecurityPanel() {
  const toast = useToast();
  const [settings, setSettings] = useState<SecuritySettingsResponse | null>(null);
  const [updatePhases, setUpdatePhases] = useState<Partial<Record<SecurityKind, UpdatePhase>>>({});
  const desktopRememberAvailable = Boolean(window.electron?.requestSettingsRememberGrant);
  const insecureWebRememberAvailable = settings?.insecureRememberAllowed === true;
  const rememberConfigurationAvailable = desktopRememberAvailable || insecureWebRememberAvailable;

  const applyCanonical = useCallback((state: RememberGrantCanonical) => {
    setSettings((current) => current ? {
      ...current,
      categories: current.categories.map((item) => {
        if (item.kind !== state.kind || item.version > state.version) return item;
        return {
          ...item,
          needConfirmation: !state.present,
          present: state.present,
          grantId: state.grantId,
          version: state.version,
        };
      }),
    } : current);
  }, []);

  const readSettings = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/v1/settings/security", { signal });
    if (!response.ok) throw new Error(String(response.status));
    const body = parseSettings(await response.json());
    setSettings((current) => mergeSettings(current, body));
    return body;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void readSettings(controller.signal).catch(() => {
      if (controller.signal.aborted) return;
      toast.show({ message: "设置加载失败，请稍后再试", tone: "error" });
    });
    return () => controller.abort();
  }, [readSettings, toast]);

  useEffect(() => subscribeRememberGrantState(applyCanonical), [applyCanonical]);

  useEffect(() => {
    const revalidate = () => {
      void readSettings().catch(() => {
        toast.show({
          message: "设置加载失败，请稍后再试",
          tone: "error",
          dedupeKey: "security-settings-focus-refresh",
        });
      });
    };
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, [readSettings, toast]);

  const setUpdatePhase = (kind: SecurityKind, phase: UpdatePhase) => {
    setUpdatePhases((current) => ({ ...current, [kind]: phase }));
  };

  const toggle = async (
    category: SecurityCategory,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    const rememberable = category.kind === "install" || category.kind === "command";
    if (
      !category.mutable ||
      (rememberable && !rememberConfigurationAvailable) ||
      updatePhases[category.kind] === "updating"
    ) return;
    setUpdatePhase(category.kind, "updating");
    const needConfirmation = !category.needConfirmation;
    let uiGrantNonce: string | undefined;
    try {
      if (!needConfirmation) {
        const requestGrant = window.electron?.requestSettingsRememberGrant;
        if (requestGrant) {
          try {
            uiGrantNonce = await requestGrant({
              kind: category.kind as "install" | "command",
              trustedGesture: event.isTrusted,
            }) ?? undefined;
          } catch {
            toast.show({ message: "没有完成确认，设置未更改。", tone: "warn" });
            return;
          }
          if (!uiGrantNonce) {
            toast.show({ message: "没有完成确认，设置未更改。", tone: "warn" });
            return;
          }
        } else if (!settings?.insecureRememberAllowed) {
          toast.show({ message: "开启记忆需要在桌面应用中完成确认。", tone: "warn" });
          return;
        }
      }

      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
      try {
        const response = await fetch(`/api/v1/settings/security/${category.kind}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ needConfirmation, ...(uiGrantNonce ? { uiGrantNonce } : {}) }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(String(response.status));
        const canonical = parseCanonical(category.kind, await response.json());
        applyCanonical(canonical);
        publishRememberGrantState(canonical);
        toast.show({
          message: needConfirmation
            ? `${category.label}已恢复每次询问。已在执行的不受影响。`
            : `${category.label}之后不再询问。`,
          tone: "success",
        });
      } finally {
        window.clearTimeout(timeout);
      }
    } catch {
      toast.show({ message: "设置保存失败，请再试一次", tone: "error" });
      await readSettings().catch(() => undefined);
    } finally {
      setUpdatePhase(category.kind, "settled");
    }
  };

  return (
    <div className="security-panel" data-wf="SecurityPanel">
      <header className="security-head">
        <h2>操作确认</h2>
        <p>这里可以选择哪些操作需要每次询问。记住后，之后会直接进行；随时可以恢复每次询问。</p>
        <p className="security-scope-note">按操作类别分别生效，改一类不影响其他。</p>
      </header>
      <div className="security-list" aria-busy={settings === null}>
        {settings?.categories.map((category) => {
          const phase = updatePhases[category.kind] ?? "idle";
          const rememberable = category.kind === "install" || category.kind === "command";
          const clientMutable = category.mutable && (
            !rememberable || rememberConfigurationAvailable
          );
          const fixedReason = fixedCategoryReasons[category.kind];
          const reasonId = fixedReason ? `security-${category.kind}-reason` : undefined;
          const commandScopeId = category.kind === "command" ? "security-command-scope" : undefined;
          const describedBy = [
            reasonId,
            commandScopeId,
            rememberable && !clientMutable ? "security-desktop-note" : undefined,
          ].filter((value): value is string => Boolean(value)).join(" ") || undefined;
          const toggleLabel = category.needConfirmation
            ? `${category.label}：每次询问，点击后改为之后不再询问`
            : `${category.label}：之后不再询问，点击后恢复每次询问`;
          return (
            <div
              className="security-row"
              key={category.kind}
              data-update-state={phase}
              data-capability={clientMutable ? "mutable" : "readonly"}
            >
              <div className="security-copy">
                <span className="security-label">{category.label}</span>
                <span className="security-meta">
                  {phase === "updating"
                    ? "正在保存…"
                    : category.needConfirmation ? "每次询问" : "之后不再询问"}
                </span>
                {commandScopeId && (
                  <span className="security-reason" id={commandScopeId}>
                    仅影响会删除、移动或产生多种影响的操作，普通命令不受影响。
                  </span>
                )}
                {fixedReason && (
                  <span className="security-reason" id={reasonId}>
                    {fixedReason}
                  </span>
                )}
              </div>
              {category.mutable ? (
                <button
                  type="button"
                  className={`security-toggle${category.needConfirmation ? " is-on" : ""}`}
                  aria-label={toggleLabel}
                  aria-pressed={category.needConfirmation}
                  aria-busy={phase === "updating"}
                  aria-describedby={describedBy}
                  disabled={!clientMutable || phase === "updating"}
                  onClick={(event) => void toggle(category, event)}
                >
                  <span className="security-toggle-dot" aria-hidden="true" />
                  {phase === "updating"
                    ? "正在保存…"
                    : category.needConfirmation ? "每次询问" : "之后不再询问"}
                </button>
              ) : (
                <span
                  className="security-fixed-state"
                  role="status"
                  aria-label={`${category.label}：每次询问`}
                  aria-describedby={describedBy}
                >
                  <span aria-hidden="true" />
                  每次询问
                </span>
              )}
            </div>
          );
        }) ?? <p className="security-loading">正在加载…</p>}
      </div>
      {settings && !rememberConfigurationAvailable && (
        <p className="security-capability-note" id="security-desktop-note">
          开启记忆需要在桌面应用中完成确认。
        </p>
      )}
    </div>
  );
}

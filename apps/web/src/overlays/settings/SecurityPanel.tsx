import { useCallback, useEffect, useRef, useState } from "react";
import { useDelayedVisible } from "../../system/useDelayedVisible";
import { attachCapabilityEnabled } from "../../system/backendConnectionStore";
import type {
  SecurityBypassState,
  SecurityGrantCategory,
  SecurityGrantKind,
  SecurityGrantMode,
  SecuritySettingsOperation,
  SecuritySettingsResponse,
  UpdateSecurityGrantResponse,
} from "@qingagent/contract-ts";
import type { CredentialShareItem } from "@qingagent/contract-ts";
import { parseCredentialShareItems, updateCredentialShare } from "./credentialShare";
import { useToast } from "../../system/ToastProvider";
import { SkinSelect } from "../../system/SkinSelect";
import {
  publishRememberGrantState,
  subscribeRememberGrantState,
  type RememberGrantCanonical,
} from "../../system/confirmGrantState";

type UpdatePhase = "idle" | "updating" | "uncertain" | "settled";

const POST_TIMEOUT_MS = 8_000;
const RECONCILE_INTERVAL_MS = 750;
const modeLabels: Record<SecurityGrantMode, string> = {
  ask: "每次询问",
  always: "不再询问",
};
const categoryDescriptions: Record<SecurityGrantKind, string> = {
  install: "装软件或依赖会改变你的电脑环境。",
  command: "删除、移动文件这类不好撤销的操作；普通命令不受影响。",
  send: "内容发出去就收不回来了。",
  connect: "连接后，青简能读到这个账号里的内容。",
};

// 全局确认档的常驻控制点。260811 起缺省为「不再询问」;用户在这里显式改为
// 「每次询问」后立刻恢复弹确认卡与隔离,已有会话即时生效。
const BYPASS_ASK = "ask";
const BYPASS_NEVER = "never";
const bypassModeLabels = {
  [BYPASS_ASK]: "每次询问",
  [BYPASS_NEVER]: "不再询问",
} as const;

function parseBypass(value: unknown): SecurityBypassState {
  if (!value || typeof value !== "object") return { enabled: true, enabledAt: null };
  const input = value as Record<string, unknown>;
  if (input.enabled === false) return { enabled: false, enabledAt: null };
  if (input.enabled !== true) return { enabled: true, enabledAt: null };
  return {
    enabled: true,
    enabledAt: typeof input.enabledAt === "string" ? input.enabledAt : null,
  };
}

function isGrantMode(value: unknown): value is SecurityGrantMode {
  return value === "ask" || value === "always";
}

function isCategory(value: unknown): value is SecurityGrantCategory {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return (
    (input.kind === "install" || input.kind === "command" || input.kind === "send" || input.kind === "connect") &&
    typeof input.label === "string" &&
    isGrantMode(input.grantMode) &&
    Array.isArray(input.grantModes) &&
    input.grantModes.length > 0 &&
    input.grantModes.every(isGrantMode) &&
    input.grantModes.includes(input.grantMode) &&
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
  return {
    categories: input.categories,
    bypass: parseBypass(input.bypass),
    credentialShare: parseCredentialShareItems({ items: input.credentialShare }),
    operation: input.operation === undefined
      ? undefined
      : parseOperation(input.operation),
  };
}

function parseCanonical(
  kind: SecurityGrantKind,
  value: unknown,
): UpdateSecurityGrantResponse {
  if (!value || typeof value !== "object") throw new Error("invalid grant state");
  const input = value as Record<string, unknown>;
  if (
    !isGrantMode(input.grantMode) ||
    typeof input.present !== "boolean" ||
    (input.grantId !== null && typeof input.grantId !== "string") ||
    !Number.isSafeInteger(input.version) ||
    Number(input.version) < 0 ||
    typeof input.operationId !== "string" ||
    input.operationId.length === 0 ||
    !Number.isSafeInteger(input.baseVersion) ||
    Number(input.baseVersion) < 0
  ) {
    throw new Error("invalid grant state");
  }
  return {
    kind,
    grantMode: input.grantMode,
    present: input.present,
    grantId: input.grantId as string | null,
    version: Number(input.version),
    operationId: input.operationId,
    baseVersion: Number(input.baseVersion),
  };
}

function parseOperation(value: unknown): SecuritySettingsOperation {
  if (!value || typeof value !== "object") throw new Error("invalid operation state");
  const input = value as Record<string, unknown>;
  if (
    typeof input.operationId !== "string" ||
    input.operationId.length === 0 ||
    !(input.kind === "install" || input.kind === "command" || input.kind === "send" || input.kind === "connect") ||
    !isGrantMode(input.grantMode) ||
    !Number.isSafeInteger(input.baseVersion) ||
    Number(input.baseVersion) < 0 ||
    !(
      input.status === "pending" ||
      input.status === "failed" ||
      input.status === "conflict" ||
      input.status === "committed"
    )
  ) {
    throw new Error("invalid operation state");
  }
  const kind = input.kind as SecurityGrantKind;
  const operation = {
    operationId: input.operationId,
    kind,
    grantMode: input.grantMode,
    baseVersion: Number(input.baseVersion),
  };
  if (input.status !== "committed") {
    return { ...operation, status: input.status };
  }
  return {
    ...operation,
    status: "committed",
    result: parseCanonical(kind, input.result),
  };
}

type UpdateOutcome =
  | { status: "committed"; canonical: UpdateSecurityGrantResponse }
  | { status: "conflict" }
  | { status: "failed" }
  | { status: "uncertain" };

function waitForReconcile(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, RECONCILE_INTERVAL_MS));
}

function createOperationId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `security-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function mergeSettings(
  current: SecuritySettingsResponse | null,
  incoming: SecuritySettingsResponse,
): SecuritySettingsResponse {
  if (!current) return incoming;
  const currentByKind = new Map(current.categories.map((item) => [item.kind, item]));
  return {
    categories: incoming.categories.map((item) => {
      const previous = currentByKind.get(item.kind);
      return previous && previous.version > item.version ? previous : item;
    }),
    // 免询问开关与共享条目都没有版本线,服务端最新一次结果即真值。
    bypass: incoming.bypass ?? { enabled: true, enabledAt: null },
    credentialShare: incoming.credentialShare ?? [],
  };
}

export function SecurityPanel() {
  const toast = useToast();
  const confirmGrantEnabled = attachCapabilityEnabled("confirmGrant");
  const credentialProviderEnabled = attachCapabilityEnabled("credentialProvider");
  const [settings, setSettings] = useState<SecuritySettingsResponse | null>(null);
  // 加载占位延迟 250ms 才显形,快请求不闪
  const showLoading = useDelayedVisible(settings === null);
  const [updatePhases, setUpdatePhases] = useState<
    Partial<Record<SecurityGrantKind, UpdatePhase>>
  >({});
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applyCanonical = useCallback((state: RememberGrantCanonical) => {
    setSettings((current) => current ? {
      ...current,
      categories: current.categories.map((item) => {
        if (item.kind !== state.kind || item.version > state.version) return item;
        return {
          ...item,
          grantMode: state.present ? "always" : "ask",
          present: state.present,
          grantId: state.grantId,
          version: state.version,
        };
      }),
    } : current);
  }, []);

  const readSettings = useCallback(async (
    signal?: AbortSignal,
    operationId?: string,
  ) => {
    const url = operationId
      ? `/api/v1/settings/security?operationId=${encodeURIComponent(operationId)}`
      : "/api/v1/settings/security";
    const response = await fetch(url, { signal });
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

  const [bypassBusy, setBypassBusy] = useState(false);
  const bypassEnabled = settings?.bypass?.enabled === true;

  const updateBypass = async (enabled: boolean) => {
    if (bypassBusy || enabled === bypassEnabled) return;
    setBypassBusy(true);
    try {
      const response = await fetch("/api/v1/settings/security/bypass", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const next = parseBypass(await response.json());
      setSettings((current) => current ? { ...current, bypass: next } : current);
      toast.show({
        message: next.enabled
          ? "以后不再询问，命令会直接执行。随时可以在这里改回。"
          : "已改为每次询问：这些操作会先问你一句，命令也重新隔离执行。",
        tone: "success",
      });
    } catch {
      toast.show({ message: "设置保存失败，请再试一次", tone: "error" });
      await readSettings().catch(() => undefined);
    } finally {
      if (mountedRef.current) setBypassBusy(false);
    }
  };

  const setUpdatePhase = (kind: SecurityGrantKind, phase: UpdatePhase) => {
    setUpdatePhases((current) => ({ ...current, [kind]: phase }));
  };

  const updateGrantMode = async (
    category: SecurityGrantCategory,
    grantMode: SecurityGrantMode,
  ) => {
    if (
      grantMode === category.grantMode ||
      !category.grantModes.includes(grantMode) ||
      category.grantModes.length === 1 ||
      updatePhases[category.kind] === "updating" ||
      updatePhases[category.kind] === "uncertain"
    ) return;

    setUpdatePhase(category.kind, "updating");
    const operationId = createOperationId();
    const baseVersion = category.version;
    let directOutcome: UpdateOutcome | undefined;
    const postOutcome = (async (): Promise<UpdateOutcome> => {
      try {
        const response = await fetch(`/api/v1/settings/security/${category.kind}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grantMode, operationId, baseVersion }),
        });
        if (response.status === 409) return { status: "conflict" };
        if (!response.ok) return { status: "failed" };
        const canonical = parseCanonical(category.kind, await response.json());
        if (
          canonical.operationId !== operationId ||
          canonical.baseVersion !== baseVersion
        ) return { status: "failed" };
        return { status: "committed", canonical };
      } catch {
        return { status: "uncertain" };
      }
    })();
    void postOutcome.then((outcome) => {
      directOutcome = outcome;
    });

    try {
      let timeout: number | undefined;
      const initialOutcome = await Promise.race([
        postOutcome,
        new Promise<UpdateOutcome>((resolve) => {
          timeout = window.setTimeout(
            () => resolve({ status: "uncertain" }),
            POST_TIMEOUT_MS,
          );
        }),
      ]);
      if (timeout !== undefined) window.clearTimeout(timeout);

      let outcome = initialOutcome;
      if (outcome.status === "uncertain") {
        setUpdatePhase(category.kind, "uncertain");
        while (mountedRef.current) {
          if (
            directOutcome?.status === "committed" ||
            directOutcome?.status === "conflict" ||
            directOutcome?.status === "failed"
          ) {
            outcome = directOutcome;
            break;
          }
          try {
            const snapshot = await readSettings(undefined, operationId);
            const operation = snapshot.operation;
            if (
              operation?.operationId === operationId &&
              operation.status === "committed"
            ) {
              outcome = { status: "committed", canonical: operation.result };
              break;
            }
            if (
              operation?.operationId === operationId &&
              operation.status === "conflict"
            ) {
              outcome = { status: "conflict" };
              break;
            }
            if (
              operation?.operationId === operationId &&
              operation.status === "failed"
            ) {
              outcome = { status: "failed" };
              break;
            }
          } catch {
            // 网络恢复前保持结果未定，不把旧 canonical 误报为保存失败。
          }
          await waitForReconcile();
        }
      }

      if (outcome.status === "committed") {
        applyCanonical(outcome.canonical);
        publishRememberGrantState(outcome.canonical);
        toast.show({
          message: outcome.canonical.grantMode === "always"
            ? `${category.label}以后不再询问。`
            : `${category.label}恢复每次询问。已在执行的不受影响。`,
          tone: "success",
        });
      } else if (outcome.status === "conflict") {
        toast.show({ message: "设置已被别处修改", tone: "error" });
        await readSettings().catch(() => undefined);
      } else if (outcome.status === "failed") {
        toast.show({ message: "设置保存失败，请再试一次", tone: "error" });
        await readSettings().catch(() => undefined);
      }
    } finally {
      if (mountedRef.current) setUpdatePhase(category.kind, "settled");
    }
  };

  return (
    <div className="security-panel" data-wf="SecurityPanel">
      <header className="security-head">
        <h2>操作确认</h2>
        <p>{confirmGrantEnabled
          ? "按操作类别选择确认方式。授权会立即生效，也可以随时改回。"
          : "当前连接外部后台，确认授权设置仅供查看。"}</p>
      </header>
      {settings && (
        <div className="security-list">
          <div
            className="security-row"
            data-wf="SecurityBypassRow"
            data-bypass={bypassEnabled ? "on" : "off"}
          >
            <div className="security-copy">
              <span className="security-label">执行命令前是否询问</span>
              <span className="security-description" id="security-bypass-description">
                这是总开关，管住下面所有类别。改成「不再询问」之后，命令都直接执行，不再打断你。
              </span>
              {bypassEnabled && (
                <span className="security-effect" id="security-bypass-effect">
                  当前所有操作都不再询问，下面的分类设置暂时不起作用。
                </span>
              )}
            </div>
            <SkinSelect
              className="security-select"
              ariaLabel="执行命令前是否询问"
              ariaDescribedBy={[
                "security-bypass-description",
                bypassEnabled ? "security-bypass-effect" : "",
              ].filter(Boolean).join(" ")}
              ariaBusy={bypassBusy}
              value={bypassEnabled ? BYPASS_NEVER : BYPASS_ASK}
              disabled={!confirmGrantEnabled || bypassBusy}
              onChange={(value) => void updateBypass(value === BYPASS_NEVER)}
              skin="ink"
              options={[
                { value: BYPASS_ASK, label: bypassModeLabels[BYPASS_ASK] },
                { value: BYPASS_NEVER, label: bypassModeLabels[BYPASS_NEVER] },
              ]}
            />
          </div>
        </div>
      )}
      {/* 分类是总开关的下级:总开关关掉询问时,这一整块只是陈列,不再生效——
          必须让层级在视觉上一眼可见,否则五行平铺会被读成五个平级开关。 */}
      {settings && (
        <p className="security-subhead" data-inactive={bypassEnabled ? "true" : undefined}>
          {bypassEnabled ? "按类别细分（当前不生效）" : "按类别细分"}
        </p>
      )}
      <div
        className="security-list"
        aria-busy={settings === null}
        data-inactive={bypassEnabled ? "true" : undefined}
      >
        {settings?.categories.map((category) => {
          const phase = updatePhases[category.kind] ?? "idle";
          const mutable = category.grantModes.length > 1;
          const descriptionId = `security-${category.kind}-description`;
          const effectId = category.grantMode === "always"
            ? `security-${category.kind}-effect`
            : undefined;
          return (
            <div
              className="security-row"
              key={category.kind}
              data-update-state={phase}
              data-capability={mutable ? "mutable" : "readonly"}
            >
              <div className="security-copy">
                <span className="security-label">{category.label}</span>
                <span className="security-description" id={descriptionId}>
                  {categoryDescriptions[category.kind]}
                </span>
                {effectId && (
                  <span className="security-effect" id={effectId}>
                    这一类以后不再询问，直接执行；可随时改回。
                  </span>
                )}
              </div>
              <SkinSelect
                className="security-select"
                ariaLabel={`${category.label}的确认方式`}
                ariaDescribedBy={[descriptionId, effectId].filter(Boolean).join(" ")}
                ariaBusy={phase === "updating" || phase === "uncertain"}
                value={category.grantMode}
                disabled={
                  !confirmGrantEnabled || !mutable || bypassEnabled ||
                  phase === "updating" || phase === "uncertain"
                }
                onChange={(value) => void updateGrantMode(category, value as SecurityGrantMode)}
                skin="ink"
                options={category.grantModes.map((mode) => ({
                  value: mode,
                  label: modeLabels[mode],
                }))}
              />
            </div>
          );
        }) ?? (showLoading ? <p className="security-loading">正在加载…</p> : null)}
      </div>
      <CredentialSharePanel
        items={settings?.credentialShare ?? []}
        enabled={credentialProviderEnabled}
        onChanged={() => void readSettings().catch(() => undefined)}
      />
    </div>
  );
}

/** 已允许与命令行工具共享的登录信息:逐条可收回。没有任何条目时整段不显示。 */
function CredentialSharePanel({
  items,
  enabled,
  onChanged,
}: {
  items: CredentialShareItem[];
  enabled: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const shared = items.filter((item) => item.granted);
  if (shared.length === 0) return null;

  const revoke = async (item: CredentialShareItem) => {
    setBusy(item.declared);
    try {
      await updateCredentialShare({
        skillName: item.skillName,
        declared: item.declared,
        granted: false,
      });
      onChanged();
      toast.show({
        message: `已收回「${item.skillLabel}」的共享。下次用到时会重新询问。`,
        tone: "success",
      });
    } catch {
      toast.show({ message: "收回没有成功，请再试一次", tone: "warn" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="security-credential" data-wf="CredentialSharePanel">
      <header className="security-head">
        <h2>已共享的登录信息</h2>
        <p>这些技能用的命令行工具，和你在终端里用的是同一个账号。收回后下次会重新询问。</p>
      </header>
      <div className="security-list">
        {shared.map((item) => (
          <div className="security-row" key={`${item.skillName}:${item.declared}`}>
            <div className="security-copy">
              <span className="security-label">{item.skillLabel}</span>
              <span className="security-description">{item.declared}</span>
            </div>
            <button
              type="button"
              className="security-revoke"
              disabled={!enabled || busy === item.declared}
              title={enabled ? undefined : "连接外部后台时不使用本机凭据共享"}
              onClick={() => void revoke(item)}
            >
              收回
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

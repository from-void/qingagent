import { useCallback, useEffect, useState } from "react";
import { useDelayedVisible } from "../../system/useDelayedVisible";
import type {
  SecurityGrantCategory,
  SecurityGrantKind,
  SecurityGrantMode,
  SecuritySettingsResponse,
  UpdateSecurityGrantResponse,
} from "@qingagent/contract-ts";
import { useToast } from "../../system/ToastProvider";
import { SkinSelect } from "../../system/SkinSelect";
import {
  publishRememberGrantState,
  subscribeRememberGrantState,
  type RememberGrantCanonical,
} from "../../system/confirmGrantState";

type UpdatePhase = "idle" | "updating" | "settled";

const POST_TIMEOUT_MS = 8_000;
const modeLabels: Record<SecurityGrantMode, string> = {
  ask: "每次询问",
  always: "总是允许",
};
const categoryDescriptions: Record<SecurityGrantKind, string> = {
  install: "安装软件或依赖前先询问，避免在不知情时改变本机环境。",
  command: "仅影响会删除、移动或产生多种影响的同类操作，普通命令不受影响。",
  send: "内容发出后不能撤回，因此每次都会询问。",
  connect: "连接会改变可访问的内容，因此每次连接前都会询问。",
};

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
  return { categories: input.categories };
}

function parseCanonical(
  kind: SecurityGrantKind,
  value: unknown,
): UpdateSecurityGrantResponse {
  if (kind !== "install" && kind !== "command") throw new Error("invalid grant kind");
  if (!value || typeof value !== "object") throw new Error("invalid grant state");
  const input = value as Record<string, unknown>;
  if (
    !isGrantMode(input.grantMode) ||
    typeof input.present !== "boolean" ||
    (input.grantId !== null && typeof input.grantId !== "string") ||
    !Number.isSafeInteger(input.version) ||
    Number(input.version) < 0
  ) {
    throw new Error("invalid grant state");
  }
  return {
    kind,
    grantMode: input.grantMode,
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
    categories: incoming.categories.map((item) => {
      const previous = currentByKind.get(item.kind);
      return previous && previous.version > item.version ? previous : item;
    }),
  };
}

export function SecurityPanel() {
  const toast = useToast();
  const [settings, setSettings] = useState<SecuritySettingsResponse | null>(null);
  // 加载占位延迟 250ms 才显形,快请求不闪
  const showLoading = useDelayedVisible(settings === null);
  const [updatePhases, setUpdatePhases] = useState<
    Partial<Record<SecurityGrantKind, UpdatePhase>>
  >({});

  const applyCanonical = useCallback((state: RememberGrantCanonical) => {
    setSettings((current) => current ? {
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
      updatePhases[category.kind] === "updating"
    ) return;

    setUpdatePhase(category.kind, "updating");
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
      try {
        const response = await fetch(`/api/v1/settings/security/${category.kind}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grantMode }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(String(response.status));
        const canonical = parseCanonical(category.kind, await response.json());
        applyCanonical(canonical);
        publishRememberGrantState(canonical);
        toast.show({
          message: canonical.grantMode === "always"
            ? `${category.label}已设为总是允许。`
            : `${category.label}已恢复每次询问。已在执行的不受影响。`,
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
        <p>按操作类别选择确认方式。授权会立即生效，也可以随时改回。</p>
      </header>
      <div className="security-list" aria-busy={settings === null}>
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
                    已记住，之后同类操作直接执行；可随时改回。
                  </span>
                )}
              </div>
              <SkinSelect
                className="security-select"
                ariaLabel={`${category.label}的确认方式`}
                ariaDescribedBy={[descriptionId, effectId].filter(Boolean).join(" ")}
                ariaBusy={phase === "updating"}
                value={category.grantMode}
                disabled={!mutable || phase === "updating"}
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
    </div>
  );
}

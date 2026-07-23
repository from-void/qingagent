// 模型 key 门禁:检测是否已配置可用 key;未配置时发送按钮 disable + hover 引导气泡,
// 「去配置」按钮带转场返回首页并打开设置(定位第一个 tab)。新建页与编辑页共用。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { getVisitorDeepseekKey, readCustomProvider } from "../overlays/settings/visitorKeyStore";

const OPEN_SETTINGS_FLAG = "qj-open-settings";
type ModelKeyGateState = "loading" | "configured" | "unconfigured";

function readLocalKey(): boolean {
  try {
    return Boolean(getVisitorDeepseekKey()) || Boolean(readCustomProvider());
  } catch {
    return false;
  }
}

// 是否已配置可用模型 key。桌面端只认本机自带 key(visitor/custom);web 端再叠加服务端状态。
export function useModelKeyConfigured(): boolean {
  const [state, setState] = useState<ModelKeyGateState>(() =>
    readLocalKey() ? "configured" : "loading",
  );
  const serverConfiguredVerified = useRef(false);
  useEffect(() => {
    let alive = true;
    const recompute = async () => {
      if (readLocalKey()) {
        if (alive) setState("configured");
        return;
      }
      // 桌面端服务端已无 env/db 兜底 key(main 里删了),这步主要兼容 web。
      try {
        const res = await fetch("/api/v1/settings/model");
        if (!res.ok) throw new Error(`model settings request failed: ${res.status}`);
        const body = (await res.json()) as { apiKeyConfigured?: boolean };
        if (typeof body?.apiKeyConfigured !== "boolean") {
          throw new Error("model settings response is missing apiKeyConfigured");
        }
        if (!alive) return;
        if (body.apiKeyConfigured) {
          serverConfiguredVerified.current = true;
          setState("configured");
        } else if (!serverConfiguredVerified.current) {
          setState("unconfigured");
        }
      } catch {
        // 瞬态失败不覆盖已知状态;若请求期间刚写入本地 key,仍立即放行。
        if (alive && readLocalKey()) setState("configured");
      }
    };
    void recompute();
    const onSignal = () => void recompute();
    window.addEventListener("storage", onSignal);
    window.addEventListener("focus", onSignal);
    return () => {
      alive = false;
      window.removeEventListener("storage", onSignal);
      window.removeEventListener("focus", onSignal);
    };
  }, []);
  // loading 不是“确认无 key”;只有服务端明确确认 false 时才启用门禁。
  return state !== "unconfigured";
}

// 「去配置」:设信号让首页打开设置(定位第一个 tab),再调用各页自带的「返回首页(带转场)」。
export function goConfigureModel(navigateHome: () => void): void {
  try {
    sessionStorage.setItem(OPEN_SETTINGS_FLAG, "model");
  } catch {
    /* ignore */
  }
  navigateHome();
}

export type OpenSettingsTarget = "model";

export function readOpenSettingsFlag(): OpenSettingsTarget | null {
  try {
    return sessionStorage.getItem(OPEN_SETTINGS_FLAG) === "model" ? "model" : null;
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

// 首页挂载时消费信号:返回 true 表示应打开设置。
export function consumeOpenSettingsFlag(): boolean {
  if (readOpenSettingsFlag()) {
    clearOpenSettingsFlag();
    return true;
  }
  return false;
}

// 发送按钮上的「未配置 key」引导气泡:hover(active 时)显示文案 + 「去配置」按钮。
// forced=true 时强制弹出(用于:用户按发送快捷键却因未配置 key 被拦下时,主动把气泡推到眼前)。
export function NoKeyTip({
  active,
  forced = false,
  onConfigure,
  children,
}: {
  active: boolean;
  forced?: boolean;
  onConfigure: () => void;
  children: ReactNode;
}) {
  if (!active) return <>{children}</>;
  return (
    <span className={`nokey-gate${forced ? " is-forced" : ""}`}>
      {children}
      <span className="nokey-tip" role="tooltip">
        <span className="nokey-tip-text">还没配置模型 key,无法开始写作。</span>
        <button type="button" className="nokey-tip-btn" onClick={onConfigure}>
          去首页配置 →
        </button>
      </span>
    </span>
  );
}

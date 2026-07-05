// 模型 key 门禁:检测是否已配置可用 key;未配置时发送按钮 disable + hover 引导气泡,
// 「去配置」按钮带转场返回首页并打开设置(定位第一个 tab)。新建页与编辑页共用。
import { useEffect, useState, type ReactNode } from "react";
import { getVisitorDeepseekKey, readCustomProvider } from "../overlays/settings/visitorKeyStore";

const OPEN_SETTINGS_FLAG = "qj-open-settings";

function readLocalKey(): boolean {
  try {
    return Boolean(getVisitorDeepseekKey()) || Boolean(readCustomProvider());
  } catch {
    return false;
  }
}

// 是否已配置可用模型 key。桌面端只认本机自带 key(visitor/custom);web 端再叠加服务端状态。
export function useModelKeyConfigured(): boolean {
  const [ok, setOk] = useState<boolean>(() => readLocalKey());
  useEffect(() => {
    let alive = true;
    const recompute = async () => {
      if (readLocalKey()) {
        if (alive) setOk(true);
        return;
      }
      // 桌面端服务端已无 env/db 兜底 key(main 里删了),这步主要兼容 web;失败按未配置处理。
      try {
        const res = await fetch("/api/v1/settings/model");
        const body = (await res.json()) as { apiKeyConfigured?: boolean };
        if (alive) setOk(Boolean(body?.apiKeyConfigured) || readLocalKey());
      } catch {
        if (alive) setOk(readLocalKey());
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
  return ok;
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

// 首页挂载时消费信号:返回 true 表示应打开设置。
export function consumeOpenSettingsFlag(): boolean {
  try {
    if (sessionStorage.getItem(OPEN_SETTINGS_FLAG)) {
      sessionStorage.removeItem(OPEN_SETTINGS_FLAG);
      return true;
    }
  } catch {
    /* ignore */
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

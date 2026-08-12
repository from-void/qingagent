import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useToast } from "../../system/ToastProvider";
import {
  getDesktopUpdateSnapshot,
  subscribeDesktopUpdate,
  type DesktopUpdateStatus,
} from "../../system/desktopUpdateStore";

// 关于页:主区居中(产品标识 + 唯一「检查更新」按钮),辅助信息弱化在底部(链接 / 许可 / 内核)。
// 更新走「请求-响应」手动检查 + 共享 store 的被动推送(下载就绪 / 强更),不各自挂 IPC 监听。

const GITHUB_REPO_URL = "https://github.com/from-void/qingagent";
const RELEASES_URL = `${GITHUB_REPO_URL}/releases`;
const LICENSE_URL = `${GITHUB_REPO_URL}/blob/main/LICENSE`;
const NOTICES_URL = `${GITHUB_REPO_URL}/blob/main/THIRD_PARTY_NOTICES.md`;
// 官网:官方构建注入 VITE_DESKTOP_SITE_URL;fork/未注入则不显示官网入口。
const SITE_URL = (import.meta.env.VITE_DESKTOP_SITE_URL ?? "").trim();
// 一句话产品介绍(占位,待用户定稿后替换本行)。
const INTRO = "青简 —— 开源的中文 AI 写作工作台。对话起稿,审核改稿,文档与素材一体。";
const COPY_TOAST = "版本信息已复制";

// web 端构建期注入版本(vitest 无 __APP_VERSION__ define,typeof 兜底避免 ReferenceError)。
function webVersion(): string {
  try {
    return typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 降级到 execCommand
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function AboutPanel() {
  const toast = useToast();
  const electron = typeof window !== "undefined" ? window.electron : undefined;
  const isDesktop = Boolean(electron?.isDesktop);
  const platform = electron?.platform ?? "web";
  const versions = electron?.versions;

  // 版本号:桌面优先 preload 注入,取不到再退回构建期 web 版本。
  const appVersion = (isDesktop ? electron?.appVersion : "") || webVersion();
  // 开发构建:-dev. 版本不参与更新(与主进程 startDesktopUpdater dev 短路口径一致)。
  const isDevBuild = isDesktop && appVersion.includes("-dev.");
  const isBeta = appVersion.includes("-beta");
  const channelLabel = isBeta ? "测试通道" : "正式通道";

  // 共享 store 的被动推送(下载就绪 / 强更);手动检查结果走本地 state。
  const pushed = useSyncExternalStore(subscribeDesktopUpdate, getDesktopUpdateSnapshot);
  const [manual, setManual] = useState<DesktopUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [hardwareAccelerationEnabled, setHardwareAccelerationEnabled] = useState(() => {
    try {
      return electron?.getHardwareAccelerationEnabled?.() ?? true;
    } catch {
      return true;
    }
  });
  const [savingHardwareAcceleration, setSavingHardwareAcceleration] = useState(false);

  // 生效态:推送的就绪/强更是权威终态;否则以本次手动检查结果为准;都没有则用推送快照。
  const status: DesktopUpdateStatus | null = useMemo(() => {
    if (pushed && (pushed.kind === "soft-ready" || pushed.kind === "force")) return pushed;
    return manual ?? pushed;
  }, [pushed, manual]);

  const runCheck = useCallback(async () => {
    if (!electron?.checkForUpdate) return;
    setChecking(true);
    try {
      const result = await electron.checkForUpdate();
      setManual(result);
    } catch {
      setManual({ kind: "error" });
    } finally {
      setChecking(false);
    }
  }, [electron]);

  const copyVersionInfo = useCallback(async () => {
    const lines = isDesktop
      ? [
          `青简 v${appVersion} · ${channelLabel}`,
          `平台 ${platform}`,
          versions
            ? `Electron ${versions.electron} · Chromium ${versions.chrome} · Node ${versions.node}`
            : "",
        ]
      : [`青简 网页版 v${appVersion}`];
    const ok = await copyText(lines.filter(Boolean).join("\n"));
    if (ok) toast.show({ message: COPY_TOAST, tone: "success" });
  }, [isDesktop, appVersion, channelLabel, platform, versions, toast]);

  const toggleHardwareAcceleration = useCallback(async () => {
    if (!electron?.setHardwareAccelerationEnabled || savingHardwareAcceleration) return;
    const nextEnabled = !hardwareAccelerationEnabled;
    setSavingHardwareAcceleration(true);
    try {
      const saved = await electron.setHardwareAccelerationEnabled(nextEnabled);
      if (!saved) {
        toast.show({ message: "设置保存失败，请再试一次", tone: "error" });
        return;
      }
      setHardwareAccelerationEnabled(nextEnabled);
      toast.show({ message: "硬件加速设置已保存，重启后生效", tone: "success" });
    } catch {
      toast.show({ message: "设置保存失败，请再试一次", tone: "error" });
    } finally {
      setSavingHardwareAcceleration(false);
    }
  }, [electron, hardwareAccelerationEnabled, savingHardwareAcceleration, toast]);

  return (
    <div className="settings-about" data-wf="AboutPanel">
      {/* —— 主区:居中产品标识 + 唯一「检查更新」按钮 —— */}
      <section className="ab-hero">
        <div className="ab-logo" aria-hidden="true">
          <img src="/favicon.svg" alt="" width={56} height={56} draggable={false} />
        </div>
        <div className="ab-name">
          青简 <span className="ab-name-en">qingagent</span>
        </div>
        <p className="ab-intro">{INTRO}</p>
        <button
          type="button"
          className="ab-version"
          data-wf="AboutVersion"
          title="复制版本信息"
          onClick={copyVersionInfo}
        >
          {isDesktop ? (
            <>
              v{appVersion} <span className="ab-version-dot">·</span> {channelLabel}
            </>
          ) : (
            <>网页版 v{appVersion}</>
          )}
        </button>

        {isDesktop ? (
          <AboutUpdateArea
            status={status}
            checking={checking}
            isDevBuild={isDevBuild}
            onCheck={runCheck}
          />
        ) : null}
      </section>

      {/* —— 辅助区:链接 / 许可 / 内核,弱化(小字、细边框、无强调色) —— */}
      <section className="ab-aux">
        {isDesktop ? (
          <div className="ab-block ab-rendering" data-wf="AboutRenderingSettings">
            <div className="ab-rendering-head">
              <div>
                <div className="ab-block-title">渲染</div>
                <div className="ab-rendering-name">硬件加速</div>
              </div>
              <button
                type="button"
                className={`sk-toggle${hardwareAccelerationEnabled ? " sk-on" : ""}`}
                data-wf="AboutHardwareAccelerationToggle"
                aria-pressed={hardwareAccelerationEnabled}
                disabled={savingHardwareAcceleration}
                onClick={() => void toggleHardwareAcceleration()}
              >
                <span className="sk-toggle-dot" aria-hidden="true" />
                {hardwareAccelerationEnabled ? "已开启" : "已关闭"}
              </button>
            </div>
            <p className="ab-rendering-note">
              遇到界面空白/花屏时可尝试关闭，重启后生效。
            </p>
          </div>
        ) : null}
        <div className="ab-block">
          <div className="ab-block-title">链接</div>
          <div className="ab-block-body">
            {SITE_URL ? (
              <ExternalLink href={SITE_URL} wf="AboutSite">
                官网
              </ExternalLink>
            ) : null}
            <ExternalLink href={GITHUB_REPO_URL} wf="AboutGithub">
              GitHub 仓库
            </ExternalLink>
            <ExternalLink href={RELEASES_URL} wf="AboutReleases">
              版本发布页 Releases
            </ExternalLink>
          </div>
        </div>

        <LicenseBlock isDesktop={isDesktop} electron={electron} />

        {isDesktop && versions ? (
          <button
            type="button"
            className="ab-block ab-block--kernel"
            data-wf="AboutKernel"
            title="复制版本信息"
            onClick={copyVersionInfo}
          >
            <div className="ab-block-title">内核信息</div>
            <div className="ab-block-body ab-kernel">
              <span>Electron {versions.electron}</span>
              <span>Chromium {versions.chrome}</span>
              <span>Node {versions.node}</span>
            </div>
          </button>
        ) : null}
      </section>
    </div>
  );
}

function AboutUpdateArea({
  status,
  checking,
  isDevBuild,
  onCheck,
}: {
  status: DesktopUpdateStatus | null;
  checking: boolean;
  isDevBuild: boolean;
  onCheck: () => void;
}) {
  if (isDevBuild) {
    return (
      <div className="ab-update">
        <button type="button" className="ab-check-btn" data-wf="AboutUpdateButton" disabled>
          检查更新
        </button>
        <div className="ab-update-status" data-wf="AboutUpdateStatus">
          开发构建不参与更新
        </div>
      </div>
    );
  }

  const kind = checking ? "checking" : status?.kind ?? "idle";
  const version = status?.version;

  let statusText = "";
  let button: { label: string; onClick: () => void; disabled?: boolean } = {
    label: "检查更新",
    onClick: onCheck,
    disabled: checking,
  };
  let showButton = true;

  switch (kind) {
    case "checking":
      statusText = "正在检查更新…";
      break;
    case "none":
      statusText = "已是最新版本";
      break;
    case "error":
      statusText = "检查更新失败,请稍后重试";
      break;
    case "soft-available":
      statusText = version ? `发现新版本 v${version},正在下载…` : "发现新版本,正在下载…";
      break;
    case "mac-manual":
      statusText = version ? `发现新版本 v${version}` : "发现新版本";
      button = { label: "前往下载页", onClick: () => void window.electron?.openDownloadPage?.() };
      break;
    case "soft-ready":
      statusText = "新版本已就绪";
      button = { label: "重启更新", onClick: () => void window.electron?.quitAndInstall?.() };
      break;
    case "force":
      // 强更由 AppUpdateWatcher 的 Modal 接管;本区只显示低版本提示,不提供绕过。
      statusText = "当前版本低于最低支持版本,请更新后继续使用";
      showButton = false;
      break;
    default:
      statusText = "";
  }

  return (
    <div className="ab-update">
      {showButton ? (
        <button
          type="button"
          className="ab-check-btn"
          data-wf="AboutUpdateButton"
          disabled={button.disabled}
          onClick={button.onClick}
        >
          {button.label}
        </button>
      ) : null}
      <div className="ab-update-status" data-wf="AboutUpdateStatus">
        {statusText}
      </div>
    </div>
  );
}

function LicenseBlock({
  isDesktop,
  electron,
}: {
  isDesktop: boolean;
  electron: Window["electron"];
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const openNotices = useCallback(async () => {
    // web 端:直接跳 GitHub 查看第三方声明。
    if (!isDesktop || !electron?.getThirdPartyNotices) {
      window.open(NOTICES_URL, "_blank", "noopener,noreferrer");
      return;
    }
    if (text !== null) {
      setOpen((prev) => !prev);
      return;
    }
    setLoading(true);
    try {
      const content = await electron.getThirdPartyNotices();
      if (content && content.trim()) {
        setText(content);
        setOpen(true);
      } else {
        // 读不到:降级跳 GitHub。
        window.open(NOTICES_URL, "_blank", "noopener,noreferrer");
      }
    } catch {
      window.open(NOTICES_URL, "_blank", "noopener,noreferrer");
    } finally {
      setLoading(false);
    }
  }, [isDesktop, electron, text]);

  return (
    <div className="ab-block">
      <div className="ab-block-title">许可</div>
      <div className="ab-block-body">
        <ExternalLink href={LICENSE_URL} wf="AboutLicense">
          MIT 许可
        </ExternalLink>
        <button
          type="button"
          className="ab-linklike"
          data-wf="AboutNoticesToggle"
          disabled={loading}
          onClick={openNotices}
        >
          第三方开源声明
        </button>
      </div>
      {open && text !== null ? (
        <pre className="ab-notices-body" data-wf="AboutNoticesBody">
          {text}
        </pre>
      ) : null}
    </div>
  );
}

function ExternalLink({
  href,
  wf,
  children,
}: {
  href: string;
  wf: string;
  children: ReactNode;
}) {
  return (
    <a
      className="ab-linklike"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-wf={wf}
    >
      {children}
    </a>
  );
}

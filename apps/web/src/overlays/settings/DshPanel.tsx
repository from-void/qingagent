import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../../system/ToastProvider";
import { GitHubStarInvite, SettingsExternalLink } from "./GitHubStarInvite";
import { copySettingsText } from "./settingsClipboard";

const DEFAULT_DSH_PROFILE = "web";
const DSH_REPO_URL = "https://github.com/void2anything/dsh-qingagent";
const INSTALL_FAILURE_TOAST_KEY = "dsh-plugin-install-failed";
const INSTALL_SUCCESS_TOAST_KEY = "dsh-plugin-install-success";

type EngineConnection = {
  desktop: boolean;
  snapshot: ElectronBackendConnectionSnapshot | null;
};

export function DshPanel() {
  const toast = useToast();
  const engineConnection = useEngineConnection();
  const { desktopInstaller, detection, refreshDetection } = useDshDetection();
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installFeedback, setInstallFeedback] = useState<ElectronDshInstallResult | null>(null);
  const installingRef = useRef(false);
  const profiles = detection?.profiles ?? [];
  const detectedDefaultProfile = profiles.find(
    (profile) => profile.name === detection?.defaultProfile,
  )?.name ?? profiles[0]?.name ?? null;
  const effectiveProfile = profiles.some((profile) => profile.name === selectedProfile)
    ? selectedProfile
    : detectedDefaultProfile;
  const selectedSnapshot = profiles.find((profile) => profile.name === effectiveProfile) ?? null;
  const installCommand = buildInstallCommand(effectiveProfile ?? DEFAULT_DSH_PROFILE);
  const npxUnavailable = detection?.detected === true && detection.npxAvailable === false;

  const copyInstallCommand = useCallback(async (command: string) => {
    const copied = await copySettingsText(command);
    toast.show({
      message: copied ? "安装命令已复制" : "复制失败,请手动复制",
      tone: copied ? "success" : "error",
      dedupeKey: copied ? "dsh-install-command-copied" : "dsh-install-command-copy-failed",
    });
  }, [toast]);

  const runInstall = useCallback(async () => {
    if (installingRef.current || installing || !effectiveProfile || npxUnavailable) return;
    const install = window.electron?.installDshPlugin;
    if (!install) return;
    installingRef.current = true;
    setInstalling(true);
    setInstallFeedback(null);
    try {
      const result = await install(effectiveProfile);
      setInstallFeedback(result);
      if (result.ok) {
        toast.show({
          message: "插件安装完成",
          tone: "success",
          dedupeKey: INSTALL_SUCCESS_TOAST_KEY,
        });
        await refreshDetection();
      } else {
        toast.show({
          message: "插件安装失败,可复制命令手动执行",
          tone: "error",
          dedupeKey: INSTALL_FAILURE_TOAST_KEY,
        });
        if (result.reason === "npx-not-found") await refreshDetection();
      }
    } catch {
      setInstallFeedback({
        ok: false,
        profile: effectiveProfile,
        command: installCommand,
        reason: "spawn-failed",
        stderr: "桌面安装通道暂不可用",
        output: "",
      });
      toast.show({
        message: "插件安装失败,可复制命令手动执行",
        tone: "error",
        dedupeKey: INSTALL_FAILURE_TOAST_KEY,
      });
    } finally {
      installingRef.current = false;
      setInstalling(false);
    }
  }, [effectiveProfile, installCommand, installing, npxUnavailable, refreshDetection, toast]);

  return (
    <div className="settings-dsh" data-wf="DshPanel">
      <section className="dsh-section" aria-labelledby="dsh-about-title">
        <h2 id="dsh-about-title" className="dsh-section-title">这是什么</h2>
        <p className="dsh-copy">
          DSH(DeepSeek Harness)是 DeepSeek 官方的终端 Agent 环境。装上 dsh-qingagent
          插件后,可以在 dsh 的对话里直接让 Agent 起草、修改、审阅青简里的文档——Agent
          出内容,青简负责排版呈现与「先审后应用」的把关。
        </p>
      </section>

      <section className="dsh-section" aria-labelledby="dsh-install-title">
        <h2 id="dsh-install-title" className="dsh-section-title">安装</h2>
        {detection?.detected ? (
          <div className="dsh-detected-install" data-wf="DshDetectedInstall">
            <div className="dsh-detected-heading">
              <strong data-wf="DshPluginStatus">
                {selectedSnapshot?.pluginVersion
                  ? `✓ 插件已安装 · v${selectedSnapshot.pluginVersion}`
                  : "已检测到 DSH"}
              </strong>
              {profiles.length === 1 && effectiveProfile && (
                <span>profile: <code>{effectiveProfile}</code></span>
              )}
              {profiles.length > 1 && effectiveProfile && (
                <label className="dsh-profile-field">
                  <span>profile</span>
                  <select
                    value={effectiveProfile}
                    data-wf="DshProfileSelect"
                    disabled={installing}
                    onChange={(event) => {
                      const next = event.currentTarget.value;
                      if (profiles.some((profile) => profile.name === next)) {
                        setSelectedProfile(next);
                        setInstallFeedback(null);
                      }
                    }}
                  >
                    {profiles.map((profile) => (
                      <option key={profile.name} value={profile.name}>{profile.name}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {effectiveProfile ? (
              <>
                {desktopInstaller && (
                  <div className="dsh-install-operation" data-wf="DshInstallOperation">
                    <button
                      type="button"
                      className="dsh-install-button"
                      data-wf="DshInstallPlugin"
                      disabled={installing || npxUnavailable}
                      onClick={() => void runInstall()}
                    >
                      {installing && <span className="dsh-install-spinner" aria-hidden="true" />}
                      {installing
                        ? "正在安装…"
                        : selectedSnapshot?.pluginVersion ? "更新到最新" : "一键安装插件"}
                    </button>
                    {npxUnavailable && (
                      <p className="dsh-install-note" data-wf="DshNpxMissing">
                        未找到 Node/npx,请先安装 Node.js 20+
                      </p>
                    )}
                    {installFeedback && (
                      <InstallFeedback
                        feedback={installFeedback}
                        installCommand={installCommand}
                        onCopy={copyInstallCommand}
                      />
                    )}
                  </div>
                )}
                <CommandLine
                  command={installCommand}
                  copyWf="DshCopyCommand"
                  onCopy={copyInstallCommand}
                  secondary
                />
              </>
            ) : (
              <p className="dsh-install-note">未检测到可用 profile，请先在 DSH 中创建 profile。</p>
            )}
          </div>
        ) : (
          <ManualInstallSteps
            command={buildInstallCommand(DEFAULT_DSH_PROFILE)}
            onCopy={copyInstallCommand}
          />
        )}
      </section>

      <section className="dsh-section" aria-labelledby="dsh-engine-title">
        <h2 id="dsh-engine-title" className="dsh-section-title">青简引擎</h2>
        <div className="dsh-engine-line">
          <span className="dsh-engine-label">本机引擎:</span>
          <EngineStatus connection={engineConnection} />
        </div>
      </section>

      <section className="dsh-section" aria-labelledby="dsh-usage-title">
        <h2 id="dsh-usage-title" className="dsh-section-title">怎么用</h2>
        <div className="dsh-examples">
          <blockquote>“把《XX 方案》第三节改得更紧凑,给我审”</blockquote>
          <blockquote>“起草一份面向投资人的产品 PRD,写完让我逐条过”</blockquote>
        </div>
      </section>

      <section className="dsh-section dsh-repository" aria-labelledby="dsh-repository-title">
        <h2 id="dsh-repository-title" className="dsh-section-title">插件仓库</h2>
        <SettingsExternalLink href={DSH_REPO_URL} wf="DshRepository" className="dsh-repository-link">
          github.com/void2anything/dsh-qingagent
        </SettingsExternalLink>
        <GitHubStarInvite repoUrl={DSH_REPO_URL} wf="DshStarInvite" />
      </section>
    </div>
  );
}

function ManualInstallSteps({
  command,
  onCopy,
}: {
  command: string;
  onCopy: (command: string) => Promise<void>;
}) {
  return (
    <ol className="dsh-steps">
      <li className="dsh-step">
        <span className="dsh-step-number" aria-hidden="true">1</span>
        <div className="dsh-step-body">
          <div className="dsh-step-line">
            <strong>启动 DSH</strong>
            <span>需 Node.js 20+,首次运行自动安装</span>
          </div>
        </div>
      </li>
      <li className="dsh-step">
        <span className="dsh-step-number" aria-hidden="true">2</span>
        <div className="dsh-step-body">
          <div className="dsh-step-line">
            <strong>装插件</strong>
            <span>装完重启 dsh web 即生效</span>
          </div>
          <CommandLine command={command} copyWf="DshCopyCommand" onCopy={onCopy} />
        </div>
      </li>
      <li className="dsh-step">
        <span className="dsh-step-number" aria-hidden="true">3</span>
        <div className="dsh-step-body">
          <div className="dsh-step-line">
            <strong>保持青简客户端运行</strong>
            <span>插件调用期间请勿退出客户端</span>
          </div>
        </div>
      </li>
    </ol>
  );
}

function CommandLine({
  command,
  copyWf,
  onCopy,
  secondary = false,
}: {
  command: string;
  copyWf: string;
  onCopy: (command: string) => Promise<void>;
  secondary?: boolean;
}) {
  return (
    <div
      className={`dsh-command${secondary ? " dsh-command--secondary" : ""}`}
      data-wf="DshInstallCommand"
    >
      <code>{command}</code>
      <button
        type="button"
        className="dsh-copy-button"
        data-wf={copyWf}
        onClick={() => void onCopy(command)}
      >
        复制
      </button>
    </div>
  );
}

function InstallFeedback({
  feedback,
  installCommand,
  onCopy,
}: {
  feedback: ElectronDshInstallResult;
  installCommand: string;
  onCopy: (command: string) => Promise<void>;
}) {
  return (
    <div
      className={`dsh-install-result dsh-install-result--${feedback.ok ? "success" : "failed"}`}
      aria-live="polite"
    >
      <span className="dsh-install-result-label">
        {feedback.ok ? "安装完成" : "未能完成安装"}
      </span>
      <pre data-wf="DshInstallOutput">
        {feedback.ok ? feedback.output : summarizeInstallFailure(feedback)}
      </pre>
      {!feedback.ok && (
        <button
          type="button"
          className="dsh-manual-button"
          data-wf="DshCopyManualCommand"
          onClick={() => void onCopy(installCommand)}
        >
          复制命令手动执行
        </button>
      )}
    </div>
  );
}

function buildInstallCommand(profile: string): string {
  return `npx @deepseek-ai/dsh plugin --profile ${profile} add dsh-qingagent@latest`;
}

function failureCopy(reason: Extract<ElectronDshInstallResult, { ok: false }>["reason"]): string {
  if (reason === "already-running") return "已有安装任务正在执行";
  if (reason === "invalid-profile") return "所选 profile 已失效，请重新打开面板检测";
  if (reason === "npx-not-found") return "未找到 Node/npx,请先安装 Node.js 20+";
  if (reason === "timed-out") return "安装超过 180 秒，已停止等待";
  return "安装命令未成功完成";
}

function summarizeInstallFailure(
  feedback: Extract<ElectronDshInstallResult, { ok: false }>,
): string {
  const raw = `${feedback.stderr}\n${feedback.output}`.toLowerCase();
  if (feedback.reason === "npx-not-found" || /\benoent\b|node\/npx|not found/u.test(raw)) {
    return "未找到 Node/npx,请先安装 Node.js 20+";
  }
  if (/eai_again|enotfound|network|registry|fetch|socket|timed?\s*out/u.test(raw)) {
    return "npm registry 连接失败，请检查网络后重试";
  }
  if (/eacces|eperm|permission|access denied/u.test(raw)) {
    return "当前用户权限不足，请复制命令到终端手动执行";
  }
  return failureCopy(feedback.reason);
}

function useDshDetection(): {
  desktopInstaller: boolean;
  detection: ElectronDshDetectionSnapshot | null;
  refreshDetection: () => Promise<void>;
} {
  const desktopInstaller = typeof window !== "undefined"
    && window.electron?.isDesktop === true
    && typeof window.electron.detectDshPlugin === "function"
    && typeof window.electron.installDshPlugin === "function";
  const [detection, setDetection] = useState<ElectronDshDetectionSnapshot | null>(null);

  const refreshDetection = useCallback(async () => {
    const detect = window.electron?.detectDshPlugin;
    if (!desktopInstaller || !detect) return;
    try {
      setDetection(await detect());
  } catch {
      setDetection({ detected: false, profiles: [], defaultProfile: null, npxAvailable: false });
    }
  }, [desktopInstaller]);

  useEffect(() => {
    let active = true;
    const detect = window.electron?.detectDshPlugin;
    if (!desktopInstaller || !detect) return undefined;
    void detect().then(
      (snapshot) => {
        if (active) setDetection(snapshot);
      },
      () => {
        if (active) {
          setDetection({ detected: false, profiles: [], defaultProfile: null, npxAvailable: false });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [desktopInstaller]);

  return { desktopInstaller, detection, refreshDetection };
}

function readEngineConnection(): EngineConnection {
  if (typeof window === "undefined") return { desktop: false, snapshot: null };
  try {
    const electron = window.electron;
    if (!electron?.isDesktop) return { desktop: false, snapshot: null };
    return { desktop: true, snapshot: electron.getBackendConnection?.() ?? null };
  } catch {
    return { desktop: false, snapshot: null };
  }
}

function useEngineConnection(): EngineConnection {
  const [connection, setConnection] = useState<EngineConnection>(readEngineConnection);

  useEffect(() => {
    setConnection(readEngineConnection());
    try {
      return window.electron?.onBackendConnectionChanged?.((snapshot) => {
        setConnection({ desktop: true, snapshot });
      });
    } catch {
      return undefined;
    }
  }, []);

  return connection;
}

function EngineStatus({ connection }: { connection: EngineConnection }) {
  const snapshot = connection.snapshot;
  let mode: "ready" | "static" = "static";
  let text = "插件依赖本机青简引擎";

  if (connection.desktop && snapshot?.mode === "embedded") {
    mode = "ready";
    const port = Number.isSafeInteger(snapshot.port) && (snapshot.port ?? 0) > 0
      ? ` · 端口 ${snapshot.port}`
      : "";
    text = `✓ 青简引擎已就绪${port}`;
  } else if (
    connection.desktop
    && snapshot?.mode === "attach"
    && snapshot.status === "attached"
  ) {
    mode = "ready";
    text = "✓ 青简引擎已就绪";
  }

  return (
    <div className={`dsh-engine-status dsh-engine-status--${mode}`} data-wf="DshEngineStatus">
      {text}
    </div>
  );
}

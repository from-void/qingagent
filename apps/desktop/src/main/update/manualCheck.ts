import {
  checkForUpdatesAndWatchDownload,
  type UpdateChecker,
} from "./checkForUpdates.js";
import { fetchUpdatePolicy, isBelowMinSupported, resolveUpdatePolicyUrl } from "./policy.js";
import { RELEASES_URL, type UpdateStatusPayload } from "./updateTypes.js";

// 手动检查更新的纯逻辑(无 electron 依赖,可在 node:test 下直接单测)。
// 语义:请求-响应——一次调用直接把本次检查结果作为返回值给回渲染层,含 error 态。
// 推送通道(onStatus)只在强更命中、以及后续 update-downloaded 等被动同步时使用。

// 我们只依赖 AppUpdater 的这几个方法,窄接口便于注入假实现。
export interface CheckableUpdater extends UpdateChecker {
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface ManualCheckDeps {
  updater: CheckableUpdater;
  platform: NodeJS.Platform;
  appVersion: string;
  isPackaged: boolean;
  // 强更命中时把 force 推给渲染层(交给 AppUpdateWatcher 的 Modal 接管);可选,单测可省。
  onStatus?: (payload: UpdateStatusPayload) => void;
  // 生产链路注入 updater.ts 的统一失败报告器，保证 emit/reject 双路径同一 WARN 口径且去重。
  onCheckError?: (error: unknown) => void;
  fetchPolicy?: typeof fetchUpdatePolicy;
  policyUrl?: string;
  // 检查迟迟无事件回来的兜底超时,超时按 error 处理,避免渲染层永远卡在「检查中」。
  timeoutMs?: number;
}

const DEFAULT_CHECK_TIMEOUT_MS = 30_000;

// 并发去重:检查进行中再次点击直接复用进行中的 Promise,不重复触发底层检查。
let inflight: Promise<UpdateStatusPayload> | null = null;

export function runManualCheck(deps: ManualCheckDeps): Promise<UpdateStatusPayload> {
  if (inflight) return inflight;
  const run = doRun(deps).finally(() => {
    inflight = null;
  });
  inflight = run;
  return run;
}

async function doRun(deps: ManualCheckDeps): Promise<UpdateStatusPayload> {
  // 开发构建 / 未打包:不进状态机(与 startDesktopUpdater 的 dev 短路口径一致)。
  if (!deps.isPackaged || deps.appVersion.includes("-dev.")) {
    return { kind: "none" };
  }

  // 强更分流:与启动检查同口径,policy fail-open(拉取失败不拦手动检查)。
  try {
    const policy = await (deps.fetchPolicy ?? fetchUpdatePolicy)(
      deps.policyUrl ?? resolveUpdatePolicyUrl(),
    );
    if (policy.minSupported && isBelowMinSupported(deps.appVersion, policy.minSupported)) {
      const payload: UpdateStatusPayload = {
        kind: "force",
        version: policy.minSupported,
        notesUrl: RELEASES_URL,
      };
      // 推送让 Modal 接管;返回值也给 About 面板显示低版本提示。
      deps.onStatus?.(payload);
      return payload;
    }
  } catch {
    // policy 拉取失败:fail-open,继续常规检查。
  }

  return awaitCheckResult(deps);
}

function readVersion(info: unknown): string | undefined {
  if (info && typeof info === "object") {
    const version = (info as { version?: unknown }).version;
    if (typeof version === "string" && version) return version;
  }
  return undefined;
}

// 一次性挂事件监听把本次 checkForUpdates 收敛成单个 payload。用 once + 首个到达者胜出:
// win/linux 自动下载会先 update-available(返回 soft-available),之后 update-downloaded 由
// updater.ts 常驻推送监听翻成 soft-ready;mac 不自动下载 → update-available 即 mac-manual。
function awaitCheckResult(deps: ManualCheckDeps): Promise<UpdateStatusPayload> {
  const { updater, platform } = deps;
  return new Promise<UpdateStatusPayload>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reportedErrors = new Set<unknown>();

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      updater.removeListener("update-available", onAvailable);
      updater.removeListener("update-not-available", onNotAvailable);
      updater.removeListener("update-downloaded", onDownloaded);
      updater.removeListener("error", onError);
    };
    const done = (payload: UpdateStatusPayload) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(payload);
    };

    const onAvailable = (info: unknown) => {
      const version = readVersion(info);
      if (platform === "darwin") {
        done({ kind: "mac-manual", version, notesUrl: RELEASES_URL });
        return;
      }
      done({ kind: "soft-available", version, notesUrl: RELEASES_URL });
    };
    const onNotAvailable = () => done({ kind: "none" });
    const onDownloaded = (info: unknown) => {
      done({ kind: "soft-ready", version: readVersion(info), notesUrl: RELEASES_URL });
    };
    const onError = (err: unknown) => {
      if (!reportedErrors.has(err)) {
        reportedErrors.add(err);
        if (deps.onCheckError) deps.onCheckError(err);
        else console.warn("[update] check failed:", err);
      }
      done({ kind: "error" });
    };

    updater.once("update-available", onAvailable);
    updater.once("update-not-available", onNotAvailable);
    updater.once("update-downloaded", onDownloaded);
    updater.once("error", onError);

    timer = setTimeout(() => {
      console.warn("[update] manual check timed out");
      done({ kind: "error" });
    }, deps.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS);

    void checkForUpdatesAndWatchDownload(updater, onError).catch(onError);
  });
}

// 仅供单测复位并发去重的 in-flight 门,生产代码勿用。
export function resetManualCheckInflightForTest(): void {
  inflight = null;
}

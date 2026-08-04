/**
 * 阶段6 — 崩溃可靠性 + 进程内 durable log。
 *
 * 在 index.ts **最早** import（早于 observability / app），以便：
 *  1. 进程崩溃（uncaughtException / unhandledRejection）时把错误+栈写持久日志
 *     （标 `CRASH`），不再只靠 shell 重定向（之前 /tmp/x.log 被 kill 即断、断档过）。
 *  2. 收到 SIGTERM / SIGINT 时优雅关闭：尽力 flush observability + 退出，避免
 *     DuckDB WAL 半写损坏。
 *
 * durable log 方案：**框架优先** 已确认 node_modules/@mastra 无 loggers 包
 * （只有 core/libsql/observability/schema-compat）→ 不新装包，用 Node
 * `fs.createWriteStream('.logs/server-<date>.log', { flags: 'a' })` 写极简进程内
 * file logger（append）；崩溃 handler 里用 `fs.appendFileSync` **同步**写崩溃栈，
 * 保证进程退出前一定落盘。现有 console 日志保留，file log 只是补充（崩溃留痕）。
 *
 * `.logs/` 已加进 .gitignore（`.logs/` + `.logs`，且 `*.log` 兜底匹配文件），不进 git。
 */

import { createWriteStream, mkdirSync, appendFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";

/** 日志目录（worktree 内持久目录，已 gitignore）。 */
const LOG_DIR = process.env.QINGAGENT_LOG_DIR ?? ".logs";

export interface DurableFileLoggerOptions {
  logDir: string;
  now?: () => Date;
}

export interface DurableFileLogger {
  path(): string;
  log(level: string, message: string, extra?: unknown): void;
  logSync(level: string, message: string, extra?: unknown): void;
  close(): Promise<void>;
}

/** 可注入时钟的 durable logger；生产与测试共走同一套跨日轮换逻辑。 */
export function createDurableFileLogger(options: DurableFileLoggerOptions): DurableFileLogger {
  const now = options.now ?? (() => new Date());
  let stream: WriteStream | undefined;
  let streamPath: string | undefined;
  const pendingCloses: Promise<void>[] = [];

  const pathFor = (date: Date) =>
    join(options.logDir, `server-${date.toISOString().slice(0, 10)}.log`);
  const closeStream = (target: WriteStream): Promise<void> => new Promise((resolve) => {
    target.end(resolve);
  });
  const rotateIfNeeded = (nextPath: string): void => {
    if (!stream || streamPath === nextPath) return;
    const previous = stream;
    stream = undefined;
    streamPath = undefined;
    pendingCloses.push(closeStream(previous));
  };
  const ensureStream = (nextPath: string): WriteStream | undefined => {
    rotateIfNeeded(nextPath);
    if (stream) return stream;
    try {
      mkdirSync(options.logDir, { recursive: true });
      const next = createWriteStream(nextPath, { flags: "a" });
      stream = next;
      streamPath = nextPath;
      // durable log 是旁路；磁盘错误必须静默，不能反向触发 uncaughtException。
      next.on("error", () => {
        if (stream === next) {
          stream = undefined;
          streamPath = undefined;
        }
      });
      return next;
    } catch {
      return undefined;
    }
  };
  const lineFor = (at: Date, level: string, message: string, extra?: unknown) =>
    JSON.stringify({
      ts: at.toISOString(),
      pid: process.pid,
      level,
      message,
      ...(extra !== undefined ? { extra } : {}),
    }) + "\n";

  return {
    path: () => pathFor(now()),
    log(level, message, extra) {
      try {
        const at = now();
        ensureStream(pathFor(at))?.write(lineFor(at, level, message, extra));
      } catch {
        // 静默：console 仍在，产品逻辑不受影响。
      }
    },
    logSync(level, message, extra) {
      try {
        const at = now();
        const nextPath = pathFor(at);
        rotateIfNeeded(nextPath);
        mkdirSync(options.logDir, { recursive: true });
        appendFileSync(nextPath, lineFor(at, level, message, extra));
      } catch {
        // 静默：崩溃路径上 console.error 仍会打印。
      }
    },
    async close() {
      if (stream) {
        const current = stream;
        stream = undefined;
        streamPath = undefined;
        pendingCloses.push(closeStream(current));
      }
      await Promise.all(pendingCloses.splice(0));
    },
  };
}

const durableLogger = createDurableFileLogger({ logDir: LOG_DIR });
export const getCrashLogPath = (): string => durableLogger.path();

/** 异步写一行 durable log（普通事件）。失败静默。 */
function durableLog(level: string, message: string, extra?: unknown): void {
  durableLogger.log(level, message, extra);
}

/** 同步写一行 durable log（崩溃/退出场景必须落盘）。 */
function durableLogSync(level: string, message: string, extra?: unknown): void {
  durableLogger.logSync(level, message, extra);
}

/** 是否已开始优雅关闭（防止重复触发）。 */
let shuttingDown = false;

type ExitFn = (code?: number) => never | void;

export interface ShutdownSignalOwnershipOptions {
  /** 宿主完成 drain 后使用的退出动作；桌面端注入 Electron app.exit。 */
  exit?: ExitFn;
}

interface GracefulShutdownDeps {
  exit?: ExitFn;
  drainActiveTurns?: () => Promise<void>;
  drainPersistence?: () => Promise<void>;
  cleanupBrowser?: () => Promise<void>;
  flushObservability?: () => Promise<void>;
}

/** 仅供真实信号子进程测试替换慢阶段；生产默认始终走 best-effort 实现。 */
let signalShutdownDepsForTest: GracefulShutdownDeps | undefined;
let ownedShutdownExit: ExitFn | undefined;

async function runShutdownPhase(
  label: string,
  timeoutMs: number,
  task: () => Promise<void>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });

  try {
    await Promise.race([task(), timeout]);
    durableLogSync("info", `${label} completed`);
  } catch (err) {
    durableLogSync("warn", `${label} failed or timed out`, {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 优雅关闭：依次 drain 活跃任务/会话持久化、关闭浏览器、flush observability，
 * 再退出。
 *
 * 框架优先：动态探测 Observability 实例上是否有 flush/shutdown/close 方法
 * （node_modules 未稳定确认有公开 close API → 用 best-effort 鸭子类型调用，
 * 有就调、没有就跳过），不硬依赖某个具体签名。给一个超时兜底，避免卡死不退出。
 */
async function gracefulShutdown(
  signal: string,
  deps: GracefulShutdownDeps = {},
): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const exit = deps.exit ?? process.exit;

  durableLogSync("info", `received ${signal}, shutting down gracefully`);
  console.log(`[crashGuard] received ${signal}, draining + flushing + shutting down`);

  // 超时兜底：6s active turn + 4s persistence + 1.5s browser + 2s observability，
  // 再留少量调度余量。
  const TIMEOUT_MS = 14_000;
  const timer = setTimeout(() => {
    durableLogSync("warn", "graceful shutdown timed out, forcing exit");
    exit(0);
  }, TIMEOUT_MS);
  // 别让超时定时器自身阻止进程退出。
  if (typeof timer.unref === "function") timer.unref();

  await runShutdownPhase(
    "active_turn_drain",
    6_000,
    deps.drainActiveTurns ?? drainActiveTurnsBestEffort,
  );
  await runShutdownPhase(
    "session_persistence_drain",
    4_000,
    deps.drainPersistence ?? drainSessionPersistenceBestEffort,
  );
  await runShutdownPhase(
    "browser_cleanup",
    1_500,
    deps.cleanupBrowser ?? cleanupBrowserBestEffort,
  );
  await runShutdownPhase(
    "observability_flush",
    2_000,
    deps.flushObservability ?? flushObservabilityBestEffort,
  );

  await durableLogger.close();

  clearTimeout(timer);
  durableLogSync("info", `shutdown complete (${signal})`);
  exit(0);
}

async function drainActiveTurnsBestEffort(): Promise<void> {
  try {
    const bridge = await import("./gateway/bridgeHandler.js");
    await bridge.disposeAllSessionsForShutdown?.();
  } catch (err) {
    durableLogSync("warn", "active turn drain failed during shutdown", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function drainSessionPersistenceBestEffort(): Promise<void> {
  try {
    const core = await import("@qingagent/core");
    // 略短于外层 4s phase，确保 core 有机会先记录“仍有未保存会话”的明确日志。
    await core.drainSessionPersistence?.(3_800);
  } catch (err) {
    durableLogSync("warn", "session persistence drain failed during shutdown", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 关闭 doc-render 共享浏览器池。
 * 延迟 import 公开 browser 入口，避免 crashGuard（最早 import）提前拉起 Playwright。
 * 阶段外层统一负责 1.5s 超时与失败降级，不阻断后续 observability flush。
 */
async function cleanupBrowserBestEffort(): Promise<void> {
  const browser = await import("@qingagent/doc-render/browser");
  await browser.closeBrowser();
}

/**
 * Best-effort 调用 Observability/DuckDB 上可能存在的 flush/shutdown/close 方法。
 * 延迟 import core，避免 crashGuard（最早 import）反向拉起 observability。
 */
async function flushObservabilityBestEffort(): Promise<void> {
  let obs: unknown;
  try {
    const core = await import("@qingagent/core");
    obs = core.getObservability?.();
  } catch {
    return;
  }
  if (!obs || typeof obs !== "object") return;

  // 鸭子类型：依次尝试常见的关闭/flush 方法名。
  const candidates = ["flush", "shutdown", "close", "dispose"] as const;
  const target = obs as Record<string, unknown>;
  for (const name of candidates) {
    const fn = target[name];
    if (typeof fn === "function") {
      try {
        await (fn as () => unknown).call(obs);
        durableLogSync("info", `observability.${name}() called on shutdown`);
        return;
      } catch (err) {
        durableLogSync("warn", `observability.${name}() threw`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  durableLogSync("info", "no observability flush/close method found (skipped)");
}

/** 安装所有 handler（幂等：重复调用只装一次）。 */
let installed = false;

const shutdownSignalHandlers = {
  SIGTERM: () => void gracefulShutdown("SIGTERM", signalShutdownDeps()),
  SIGINT: () => void gracefulShutdown("SIGINT", signalShutdownDeps()),
} satisfies Record<"SIGTERM" | "SIGINT", () => void>;

function signalShutdownDeps(): GracefulShutdownDeps {
  return {
    ...signalShutdownDepsForTest,
    exit: signalShutdownDepsForTest?.exit ?? ownedShutdownExit,
  };
}

function installShutdownSignalHandlers(): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const handler = shutdownSignalHandlers[signal];
    if (!process.listeners(signal).includes(handler)) {
      process.on(signal, handler);
    }
  }
}

export function installCrashGuard(): void {
  if (installed) return;
  installed = true;

  // 用同步写：保证「已安装」这行一定落盘，即使进程在毫秒级内就崩溃（如端口占用
  // 的 EADDRINUSE 同步抛错），也留下"crashGuard 确实装上了"的证据。
  durableLogSync("info", "crashGuard installed", { logPath: durableLogger.path() });

  // 1) uncaughtException：状态不可靠 → 记录后 exit(1) 让外层（tsx watch / 进程管理器）重启。
  process.on("uncaughtException", (err) => {
    durableLogSync("CRASH", "uncaughtException", {
      message: err?.message,
      stack: err?.stack,
    });
    console.error("[crashGuard] CRASH uncaughtException", err);
    process.exit(1);
  });

  // 2) unhandledRejection：Node 默认未来会以非零码退出。这里记录崩溃栈但**不主动退出**——
  //    多数 unhandledRejection 不代表进程状态不可恢复（如某个旁路 promise 漏 catch），
  //    贸然 exit 会误杀正常服务。落盘留痕足够开发期定位。（若后续发现确有需要，
  //    可改为同 uncaughtException 退出。）
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : undefined;
    durableLogSync("CRASH", "unhandledRejection", {
      message: err?.message ?? String(reason),
      stack: err?.stack,
    });
    console.error("[crashGuard] CRASH unhandledRejection", reason);
  });

  // 3) SIGTERM / SIGINT：优雅关闭（drain + 关浏览器 + flush + 关 DB stream + exit）。
  installShutdownSignalHandlers();
}

/**
 * 在真实 server 的依赖图加载完成后收口信号所有权。
 *
 * crashGuard 必须最早安装，才能覆盖启动期崩溃；但后续依赖仍可能在模块求值时追加
 * SIGTERM/SIGINT handler 并直接 process.exit，抢先掐断异步 drain。因此 index.ts 在
 * app/core/doc-render 全部加载后调用本函数，移除竞争 handler，再只装回 crashGuard。
 */
export function claimShutdownSignalOwnership(options: ShutdownSignalOwnershipOptions = {}): void {
  ownedShutdownExit = options.exit;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const listeners = process.listeners(signal);
    const competingCount = listeners.filter(
      (listener) => listener !== shutdownSignalHandlers[signal],
    ).length;
    process.removeAllListeners(signal);
    process.on(signal, shutdownSignalHandlers[signal]);
    if (competingCount > 0) {
      durableLogSync("info", `removed competing ${signal} shutdown handlers`, {
        count: competingCount,
      });
    }
  }
}

// 自安装：crashGuard 被 import 的瞬间就装 handler。ES module import 会先于同模块内
// 其他 import 的副作用求值，所以在 index.ts 里把本模块放最前面 import，即可保证
// 崩溃捕获早于 observability / app 初始化生效（不依赖调用顺序）。
installCrashGuard();

/** 导出供其他模块写 durable log（可选，当前主要是崩溃留痕）。 */
export async function gracefulShutdownForTest(
  signal: string,
  deps: GracefulShutdownDeps = {},
): Promise<void> {
  shuttingDown = false;
  await gracefulShutdown(signal, { ...deps, exit: deps.exit ?? (() => undefined) });
}

export function __resetCrashGuardForTest(): void {
  shuttingDown = false;
  signalShutdownDepsForTest = undefined;
  ownedShutdownExit = undefined;
}

export function __setSignalShutdownDepsForTest(deps: GracefulShutdownDeps): void {
  signalShutdownDepsForTest = deps;
}

export { durableLog };

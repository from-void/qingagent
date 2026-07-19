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

/** 当天日志文件路径，如 .logs/server-2026-05-31.log。 */
function logFilePath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(LOG_DIR, `server-${date}.log`);
}

const LOG_PATH = logFilePath();

/** 进程内 append write stream（懒创建；失败不致命）。 */
let stream: WriteStream | undefined;

function ensureStream(): WriteStream | undefined {
  if (stream) return stream;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    stream = createWriteStream(LOG_PATH, { flags: "a" });
    // 监听 stream 的 error 事件（如 EPIPE / 磁盘满）：否则未处理的 'error' 事件
    // 会反过来抛成 uncaughtException，讽刺地把崩溃守卫自己搞崩。静默吞掉即可
    // （durable log 是旁路，console 仍在）。
    stream.on("error", () => {
      stream = undefined;
    });
    return stream;
  } catch {
    // 落盘失败不致命：console 仍在，产品逻辑不受影响。
    return undefined;
  }
}

/** 异步写一行 durable log（普通事件）。失败静默。 */
function durableLog(level: string, message: string, extra?: unknown): void {
  try {
    const s = ensureStream();
    if (!s) return;
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        level,
        message,
        ...(extra !== undefined ? { extra } : {}),
      }) + "\n";
    s.write(line);
  } catch {
    // 静默
  }
}

/**
 * 同步写一行 durable log（崩溃/退出场景必须落盘）。
 * 用 appendFileSync 绕过异步 stream 缓冲，保证 process.exit 前写入。
 */
function durableLogSync(level: string, message: string, extra?: unknown): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        level,
        message,
        ...(extra !== undefined ? { extra } : {}),
      }) + "\n";
    appendFileSync(LOG_PATH, line);
  } catch {
    // 静默：崩溃路径上 console.error 仍会打印。
  }
}

/** 是否已开始优雅关闭（防止重复触发）。 */
let shuttingDown = false;

type ExitFn = (code?: number) => never | void;

interface GracefulShutdownDeps {
  exit?: ExitFn;
  drainActiveTurns?: () => Promise<void>;
  drainPersistence?: () => Promise<void>;
  flushObservability?: () => Promise<void>;
}

/** 仅供真实信号子进程测试替换慢阶段；生产默认始终走 best-effort 实现。 */
let signalShutdownDepsForTest: GracefulShutdownDeps | undefined;

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
 * 优雅关闭：尽力 flush observability（DuckDB exporter），再退出。
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

  // 超时兜底：6s active turn + 4s persistence + 2s observability，再留少量调度余量。
  const TIMEOUT_MS = 12_500;
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
    "observability_flush",
    2_000,
    deps.flushObservability ?? flushObservabilityBestEffort,
  );

  try {
    stream?.end();
  } catch {
    // 静默
  }

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
    await core.drainSessionPersistence?.(4_000);
  } catch (err) {
    durableLogSync("warn", "session persistence drain failed during shutdown", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

export function installCrashGuard(): void {
  if (installed) return;
  installed = true;

  ensureStream();
  // 用同步写：保证「已安装」这行一定落盘，即使进程在毫秒级内就崩溃（如端口占用
  // 的 EADDRINUSE 同步抛错），也留下"crashGuard 确实装上了"的证据。
  durableLogSync("info", "crashGuard installed", { logPath: LOG_PATH });

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

  // 3) SIGTERM / SIGINT：优雅关闭（flush observability + 关 DB stream + exit）。
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM", signalShutdownDepsForTest));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT", signalShutdownDepsForTest));
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
}

export function __setSignalShutdownDepsForTest(deps: GracefulShutdownDeps): void {
  signalShutdownDepsForTest = deps;
}

export { durableLog, LOG_PATH };

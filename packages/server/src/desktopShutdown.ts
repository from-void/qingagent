import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const DESKTOP_SHUTDOWN_TIMEOUT_MS = 10_000;
const MARKER_VERSION = 1;
const MAX_MARKER_BYTES = 64 * 1024;

interface DesktopShutdownRecoveryMarker {
  version: typeof MARKER_VERSION;
  createdAt: string;
  sessionIds: string[];
}

interface DesktopShutdownDeps {
  listRecoverableSessionIds: () => string[];
  drainActiveTurns: () => Promise<void>;
  drainPersistence: (timeoutMs: number) => Promise<void>;
}

interface DesktopRecoveryDeps {
  resumeSession: (sessionId: string) => Promise<boolean>;
}

export interface DesktopShutdownOptions {
  recoveryMarkerPath?: string;
  timeoutMs?: number;
  deadlineAtMs?: number;
  deps?: DesktopShutdownDeps;
}

export interface DesktopRecoveryOptions {
  recoveryMarkerPath?: string;
  deps?: DesktopRecoveryDeps;
}

export interface DesktopShutdownResult {
  completed: boolean;
  pendingSessionIds: string[];
}

export function desktopShutdownRecoveryMarkerPath(): string {
  return join(
    process.env.QINGAGENT_DATA_DIR ?? ".",
    ".desktop-shutdown-recovery.json",
  );
}

function uniqueSessionIds(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function writeRecoveryMarker(
  markerPath: string,
  sessionIds: readonly string[],
): void {
  const marker: DesktopShutdownRecoveryMarker = {
    version: MARKER_VERSION,
    createdAt: new Date().toISOString(),
    sessionIds: uniqueSessionIds(sessionIds),
  };
  mkdirSync(dirname(markerPath), { recursive: true });
  const tempPath = `${markerPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(marker), { mode: 0o600 });
    renameSync(tempPath, markerPath);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // rename 成功或临时文件本就不存在。
    }
  }
}

function removeRecoveryMarker(markerPath: string): void {
  try {
    unlinkSync(markerPath);
  } catch {
    // 不存在或清理失败均不影响正常退出；失败时下次启动会再次幂等恢复。
  }
}

function parseRecoveryMarker(raw: string): DesktopShutdownRecoveryMarker | null {
  if (raw.length > MAX_MARKER_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DesktopShutdownRecoveryMarker>;
  if (
    candidate.version !== MARKER_VERSION ||
    typeof candidate.createdAt !== "string" ||
    !Array.isArray(candidate.sessionIds) ||
    candidate.sessionIds.some((id) => typeof id !== "string")
  ) {
    return null;
  }
  return {
    version: MARKER_VERSION,
    createdAt: candidate.createdAt,
    sessionIds: uniqueSessionIds(candidate.sessionIds),
  };
}

async function defaultShutdownDeps(): Promise<DesktopShutdownDeps> {
  const [lifecycle, core] = await Promise.all([
    import("./gateway/sessionLifecycle.js"),
    import("@qingagent/core"),
  ]);
  return {
    listRecoverableSessionIds: lifecycle.listSessionIdsForShutdownRecovery,
    drainActiveTurns: lifecycle.disposeAllSessionsForShutdown,
    drainPersistence: (timeoutMs) => core.drainSessionPersistence(timeoutMs),
  };
}

async function defaultRecoveryDeps(): Promise<DesktopRecoveryDeps> {
  const [lifecycle, core] = await Promise.all([
    import("./gateway/sessionLifecycle.js"),
    import("@qingagent/core"),
  ]);
  return {
    resumeSession: async (sessionId) => {
      const session = await lifecycle.getOrRestoreSession(sessionId);
      if (!session) return false;
      await core.schedulePersist(session, "desktop_shutdown_recovery");
      return true;
    },
  };
}

/**
 * Electron 正常退出专用排空。active turn 与持久化共用一个 10 秒墙钟预算；
 * 超时或失败时同步落恢复标记，确保 app.quit 放行前标记已经 durable。
 */
export async function drainDesktopSessionsForShutdown(
  options: DesktopShutdownOptions = {},
): Promise<DesktopShutdownResult> {
  const markerPath = options.recoveryMarkerPath ?? desktopShutdownRecoveryMarkerPath();
  const requestedTimeoutMs = options.timeoutMs ?? DESKTOP_SHUTDOWN_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeoutMs)
    ? Math.max(1, Math.floor(requestedTimeoutMs))
    : DESKTOP_SHUTDOWN_TIMEOUT_MS;
  const deadline = Number.isFinite(options.deadlineAtMs)
    ? Math.floor(options.deadlineAtMs!)
    : Date.now() + timeoutMs;
  const deps = options.deps ?? await defaultShutdownDeps();
  const pendingSessionIds = uniqueSessionIds(deps.listRecoverableSessionIds());
  const remainingAtStartMs = deadline - Date.now();
  if (remainingAtStartMs <= 0) {
    writeRecoveryMarker(markerPath, pendingSessionIds);
    console.warn("[desktop] 会话排空启动时已到退出期限，已写入下次启动恢复标记", {
      pendingSessionCount: pendingSessionIds.length,
    });
    return { completed: false, pendingSessionIds };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("desktop shutdown drain reached quit deadline")),
      remainingAtStartMs,
    );
    timer.unref?.();
  });
  const drain = (async () => {
    await deps.drainActiveTurns();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("desktop shutdown drain reached quit deadline");
    }
    await deps.drainPersistence(remainingMs);
  })();

  try {
    await Promise.race([drain, timeout]);
    removeRecoveryMarker(markerPath);
    return { completed: true, pendingSessionIds: [] };
  } catch (error) {
    writeRecoveryMarker(markerPath, pendingSessionIds);
    console.warn("[desktop] 会话排空未完成，已写入下次启动恢复标记", {
      pendingSessionCount: pendingSessionIds.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return { completed: false, pendingSessionIds };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 启动时消费上次退出标记。冷恢复会把已不可能继续确认结果的 running/pending
 * 工具终态化，再立即持久化；全部成功后才删除标记，失败则留待下次启动重试。
 */
export async function resumeInterruptedDesktopShutdown(
  options: DesktopRecoveryOptions = {},
): Promise<{ recoveredSessionCount: number; pending: boolean }> {
  const markerPath = options.recoveryMarkerPath ?? desktopShutdownRecoveryMarkerPath();
  if (!existsSync(markerPath)) {
    return { recoveredSessionCount: 0, pending: false };
  }
  let marker: DesktopShutdownRecoveryMarker | null = null;
  try {
    marker = parseRecoveryMarker(readFileSync(markerPath, "utf8"));
  } catch {
    // 读取失败保留标记，下次启动仍可重试。
    return { recoveredSessionCount: 0, pending: true };
  }
  if (!marker) {
    removeRecoveryMarker(markerPath);
    return { recoveredSessionCount: 0, pending: false };
  }

  const deps = options.deps ?? await defaultRecoveryDeps();
  let recoveredSessionCount = 0;
  try {
    for (const sessionId of marker.sessionIds) {
      if (await deps.resumeSession(sessionId)) recoveredSessionCount++;
    }
    removeRecoveryMarker(markerPath);
    return { recoveredSessionCount, pending: false };
  } catch (error) {
    console.warn("[desktop] 上次未完成会话恢复失败，将在下次启动重试", {
      recoveredSessionCount,
      error: error instanceof Error ? error.message : String(error),
    });
    return { recoveredSessionCount, pending: true };
  }
}

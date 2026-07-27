import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drainDesktopSessionsForShutdown,
  resumeInterruptedDesktopShutdown,
} from "../desktopShutdown.js";

const tempDirs: string[] = [];

function markerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "qingagent-desktop-shutdown-"));
  tempDirs.push(dir);
  return join(dir, "recovery.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("desktop shutdown drain", () => {
  it("正常退出依次等待活跃轮与持久化，完成时不留下恢复标记", async () => {
    const path = markerPath();
    const order: string[] = [];
    const result = await drainDesktopSessionsForShutdown({
      recoveryMarkerPath: path,
      timeoutMs: 100,
      deps: {
        listRecoverableSessionIds: () => ["session-a"],
        drainActiveTurns: async () => {
          order.push("active");
        },
        drainPersistence: async () => {
          order.push("persistence");
        },
      },
    });

    expect(result).toEqual({ completed: true, pendingSessionIds: [] });
    expect(order).toEqual(["active", "persistence"]);
    expect(() => readFileSync(path)).toThrow();
  });

  it("共用预算超时时同步记录未完成会话，下次启动自动恢复并清除标记", async () => {
    const path = markerPath();
    const never = new Promise<void>(() => undefined);
    const result = await drainDesktopSessionsForShutdown({
      recoveryMarkerPath: path,
      timeoutMs: 10,
      deps: {
        listRecoverableSessionIds: () => ["session-a", "session-a", "session-b"],
        drainActiveTurns: () => never,
        drainPersistence: vi.fn(),
      },
    });

    expect(result).toEqual({
      completed: false,
      pendingSessionIds: ["session-a", "session-b"],
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      version: 1,
      sessionIds: ["session-a", "session-b"],
    });

    const resumeSession = vi.fn(async (_sessionId: string) => true);
    await expect(resumeInterruptedDesktopShutdown({
      recoveryMarkerPath: path,
      deps: { resumeSession },
    })).resolves.toEqual({
      recoveredSessionCount: 2,
      pending: false,
    });
    expect(resumeSession.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      "session-a",
      "session-b",
    ]);
    expect(() => readFileSync(path)).toThrow();
  });

  it("恢复失败保留标记，损坏标记则安全丢弃且不触发会话恢复", async () => {
    const path = markerPath();
    writeFileSync(path, JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      sessionIds: ["session-a"],
    }));
    const resumeSession = vi.fn(async (_sessionId: string) => {
      throw new Error("storage unavailable");
    });
    await expect(resumeInterruptedDesktopShutdown({
      recoveryMarkerPath: path,
      deps: { resumeSession },
    })).resolves.toEqual({
      recoveredSessionCount: 0,
      pending: true,
    });
    expect(readFileSync(path, "utf8")).toContain("session-a");

    writeFileSync(path, '{"version":1,"sessionIds":["truncated"]');
    resumeSession.mockClear();
    await expect(resumeInterruptedDesktopShutdown({
      recoveryMarkerPath: path,
      deps: { resumeSession },
    })).resolves.toEqual({
      recoveredSessionCount: 0,
      pending: false,
    });
    expect(resumeSession).not.toHaveBeenCalled();
    expect(() => readFileSync(path)).toThrow();
  });
});

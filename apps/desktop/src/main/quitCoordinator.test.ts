import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import {
  DESKTOP_SHUTDOWN_MARKER_TIMEOUT_MS,
  drainDesktopSessionsForShutdown,
} from "@qingagent/server/desktopShutdown";
import {
  createDesktopQuitCoordinator,
  DESKTOP_QUIT_DEADLINE_MS,
} from "./quitCoordinator.js";

const DESKTOP_QUIT_DRAIN_BUDGET_MS =
  DESKTOP_QUIT_DEADLINE_MS - DESKTOP_SHUTDOWN_MARKER_TIMEOUT_MS;

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("desktop quit coordinator", () => {
  it("生成中退出先明确确认，取消后不排空也不退出", async () => {
    const drainServer = mock.fn(async () => undefined);
    const quit = mock.fn();
    const confirmQuitDuringGeneration = mock.fn(async () => false);
    const coordinator = createDesktopQuitCoordinator({
      hasActiveGeneration: () => true,
      confirmQuitDuringGeneration,
      telemetryEnabled: () => false,
      captureAppClosed: mock.fn(),
      shutdownTelemetry: mock.fn(async () => undefined),
      drainServer,
      stopExternalInstance: mock.fn(async () => undefined),
      quit,
    });

    await coordinator.handleBeforeQuit({ preventDefault: mock.fn() });

    assert.equal(confirmQuitDuringGeneration.mock.callCount(), 1);
    assert.equal(drainServer.mock.callCount(), 0);
    assert.equal(quit.mock.callCount(), 0);
  });

  it("生成中确认退出后才排空 server 并恢复 app.quit", async () => {
    const order: string[] = [];
    const coordinator = createDesktopQuitCoordinator({
      hasActiveGeneration: async () => true,
      confirmQuitDuringGeneration: async () => {
        order.push("confirm");
        return true;
      },
      telemetryEnabled: () => false,
      captureAppClosed: mock.fn(),
      shutdownTelemetry: mock.fn(async () => undefined),
      drainServer: async () => { order.push("drain"); },
      stopExternalInstance: mock.fn(async () => undefined),
      quit: () => { order.push("quit"); },
    });

    await coordinator.handleBeforeQuit({ preventDefault: mock.fn() });
    assert.deepEqual(order, ["confirm", "drain", "quit"]);
  });

  it("非 macOS 关窗先改走 app.quit，确认取消时窗口仍保留", async () => {
    const quit = mock.fn();
    const closeEvent = { preventDefault: mock.fn() };
    const coordinator = createDesktopQuitCoordinator({
      hasActiveGeneration: () => true,
      confirmQuitDuringGeneration: async () => false,
      telemetryEnabled: () => false,
      captureAppClosed: mock.fn(),
      shutdownTelemetry: mock.fn(async () => undefined),
      drainServer: mock.fn(async () => undefined),
      stopExternalInstance: mock.fn(async () => undefined),
      quit,
    });

    coordinator.handleWindowClose(closeEvent);
    assert.equal(closeEvent.preventDefault.mock.callCount(), 1);
    assert.equal(quit.mock.callCount(), 1);
    await coordinator.handleBeforeQuit({ preventDefault: mock.fn() });
    assert.equal(quit.mock.callCount(), 1);
  });

  it("遥测关闭时仍等待 server 排空，完成后才恢复 app.quit", async () => {
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const quit = mock.fn();
    const preventDefault = mock.fn();
    const coordinator = createDesktopQuitCoordinator({
      telemetryEnabled: () => false,
      captureAppClosed: mock.fn(),
      shutdownTelemetry: mock.fn(async () => undefined),
      drainServer: mock.fn(() => drain),
      stopExternalInstance: mock.fn(async () => undefined),
      quit,
    });

    const completion = coordinator.handleBeforeQuit({ preventDefault });
    assert.equal(preventDefault.mock.callCount(), 1);
    assert.equal(quit.mock.callCount(), 0);

    releaseDrain();
    await completion;
    assert.equal(quit.mock.callCount(), 1);
  });

  it("重复退出复用同一排空任务，恢复后的递归事件不再阻止", async () => {
    const drainServer = mock.fn(async () => undefined);
    const quit = mock.fn();
    const coordinator = createDesktopQuitCoordinator({
      telemetryEnabled: () => true,
      captureAppClosed: mock.fn(),
      shutdownTelemetry: mock.fn(async () => undefined),
      drainServer,
      stopExternalInstance: mock.fn(async () => undefined),
      quit,
    });
    const firstEvent = { preventDefault: mock.fn() };
    const secondEvent = { preventDefault: mock.fn() };

    const first = coordinator.handleBeforeQuit(firstEvent);
    const second = coordinator.handleBeforeQuit(secondEvent);
    assert.equal(first, second);
    await first;
    assert.equal(drainServer.mock.callCount(), 1);
    assert.equal(quit.mock.callCount(), 1);

    const resumedEvent = { preventDefault: mock.fn() };
    assert.equal(coordinator.handleBeforeQuit(resumedEvent), undefined);
    assert.equal(resumedEvent.preventDefault.mock.callCount(), 0);
  });

  it("外部清理永不收敛时仍按总期限写恢复标记并放行退出", async (t) => {
    t.mock.timers.enable({
      apis: ["Date", "setTimeout"],
      now: 1_000_000,
    });
    const tempDir = mkdtempSync(join(tmpdir(), "qingagent-quit-coordinator-"));
    const recoveryMarkerPath = join(tempDir, "recovery.json");
    const activeTurns = createDeferred();
    const externalStop = createDeferred();
    const drainStarted = createDeferred();
    const drainFinished = createDeferred();
    const order: string[] = [];
    const quit = mock.fn(() => {
      order.push("quit");
    });
    const coordinator = createDesktopQuitCoordinator({
      telemetryEnabled: () => false,
      captureAppClosed: mock.fn(),
      shutdownTelemetry: mock.fn(async () => undefined),
      drainServer: async (deadlineAtMs) => {
        try {
          await drainDesktopSessionsForShutdown({
            recoveryMarkerPath,
            deadlineAtMs,
            deps: {
              listRecoverableSessionIds: () => ["session-never-settled"],
              drainActiveTurns: () => {
                drainStarted.resolve();
                return activeTurns.promise;
              },
              drainPersistence: mock.fn(async () => undefined),
            },
          });
          order.push("marker");
        } finally {
          drainFinished.resolve();
        }
      },
      stopExternalInstance: () => externalStop.promise,
      quit,
      deadlineMs: DESKTOP_QUIT_DEADLINE_MS,
    });
    const completion = coordinator.handleBeforeQuit({ preventDefault: mock.fn() });

    try {
      await drainStarted.promise;

      t.mock.timers.tick(DESKTOP_QUIT_DRAIN_BUDGET_MS - 1);
      await Promise.resolve();
      assert.equal(quit.mock.callCount(), 0);
      assert.equal(existsSync(recoveryMarkerPath), false);

      t.mock.timers.tick(1);
      await drainFinished.promise;
      assert.deepEqual(order, ["marker"]);

      t.mock.timers.tick(DESKTOP_SHUTDOWN_MARKER_TIMEOUT_MS - 1);
      await Promise.resolve();
      assert.equal(quit.mock.callCount(), 0);

      t.mock.timers.tick(1);
      await completion;
      assert.equal(quit.mock.callCount(), 1);
      assert.equal(existsSync(recoveryMarkerPath), true);
      assert.deepEqual(order, ["marker", "quit"]);
      assert.deepEqual(
        JSON.parse(readFileSync(recoveryMarkerPath, "utf8")).sessionIds,
        ["session-never-settled"],
      );
    } finally {
      activeTurns.resolve();
      externalStop.resolve();
      await Promise.all([activeTurns.promise, externalStop.promise]);
      await Promise.allSettled([completion, drainFinished.promise]);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("排空与恢复标记双双卡死时仍在绝对期限内放行退出", async (t) => {
    t.mock.timers.enable({
      apis: ["Date", "setTimeout"],
      now: 2_000_000,
    });
    const activeTurns = createDeferred();
    const marker = createDeferred();
    const telemetry = createDeferred();
    const externalStop = createDeferred();
    const drainStarted = createDeferred();
    const markerStarted = createDeferred();
    const drainFinished = createDeferred();
    const drainActiveTurns = mock.fn(() => {
      drainStarted.resolve();
      return activeTurns.promise;
    });
    const markerWrite = mock.fn(() => {
      markerStarted.resolve();
      return marker.promise;
    });
    const quit = mock.fn();
    const coordinator = createDesktopQuitCoordinator({
      telemetryEnabled: () => true,
      captureAppClosed: mock.fn(),
      shutdownTelemetry: () => telemetry.promise,
      drainServer: async (deadlineAtMs) => {
        try {
          await drainDesktopSessionsForShutdown({
            recoveryMarkerPath: join(
              tmpdir(),
              `qingagent-marker-hang-${process.pid}.json`,
            ),
            deadlineAtMs,
            deps: {
              listRecoverableSessionIds: () => ["session-double-hang"],
              drainActiveTurns,
              drainPersistence: mock.fn(async () => undefined),
              writeRecoveryMarker: markerWrite,
            },
          });
        } finally {
          drainFinished.resolve();
        }
      },
      stopExternalInstance: () => externalStop.promise,
      quit,
      deadlineMs: DESKTOP_QUIT_DEADLINE_MS,
    });

    const completion = coordinator.handleBeforeQuit({ preventDefault: mock.fn() });
    try {
      await drainStarted.promise;

      t.mock.timers.tick(DESKTOP_QUIT_DRAIN_BUDGET_MS - 1);
      await Promise.resolve();
      assert.equal(markerWrite.mock.callCount(), 0);
      assert.equal(quit.mock.callCount(), 0);

      t.mock.timers.tick(1);
      await markerStarted.promise;
      assert.equal(markerWrite.mock.callCount(), 1);
      assert.equal(quit.mock.callCount(), 0);

      t.mock.timers.tick(DESKTOP_SHUTDOWN_MARKER_TIMEOUT_MS - 1);
      await Promise.resolve();
      assert.equal(quit.mock.callCount(), 0);

      t.mock.timers.tick(1);
      await Promise.all([completion, drainFinished.promise]);

      assert.equal(drainActiveTurns.mock.callCount(), 1);
      assert.equal(markerWrite.mock.callCount(), 1);
      assert.equal(quit.mock.callCount(), 1);
    } finally {
      activeTurns.resolve();
      marker.resolve();
      telemetry.resolve();
      externalStop.resolve();
      await Promise.all([
        activeTurns.promise,
        marker.promise,
        telemetry.promise,
        externalStop.promise,
      ]);
      await Promise.allSettled([completion, drainFinished.promise]);
    }
  });
});

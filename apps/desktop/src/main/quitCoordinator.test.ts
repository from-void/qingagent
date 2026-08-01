import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { drainDesktopSessionsForShutdown } from "@qingagent/server/desktopShutdown";
import { createDesktopQuitCoordinator } from "./quitCoordinator.js";

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

  it("外部清理永不收敛时仍按总期限写恢复标记并放行退出", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "qingagent-quit-coordinator-"));
    const recoveryMarkerPath = join(tempDir, "recovery.json");
    const never = new Promise<void>(() => undefined);
    const order: string[] = [];
    const quit = mock.fn(() => {
      assert.equal(existsSync(recoveryMarkerPath), true);
      order.push("quit");
    });
    const startedAt = Date.now();
    const coordinator = createDesktopQuitCoordinator({
      telemetryEnabled: () => false,
      captureAppClosed: mock.fn(),
      shutdownTelemetry: mock.fn(async () => undefined),
      drainServer: async (deadlineAtMs) => {
        await drainDesktopSessionsForShutdown({
          recoveryMarkerPath,
          deadlineAtMs,
          deps: {
            listRecoverableSessionIds: () => ["session-never-settled"],
            drainActiveTurns: () => never,
            drainPersistence: mock.fn(async () => undefined),
          },
        });
        order.push("marker");
      },
      stopExternalInstance: () => never,
      quit,
      // 生产值为 10 秒；测试缩短同一墙钟 deadline，避免套件平白等待。
      // 30ms 在全套并行(27 个测试进程)下会被事件循环饥饿打穿而假红,放宽到 120ms,
      // 语义不变(清理永不收敛仍须在总期限内写标记放行),外层 <500ms 墙钟断言兜底。
      deadlineMs: 120,
    });

    try {
      await coordinator.handleBeforeQuit({ preventDefault: mock.fn() });
      assert.equal(quit.mock.callCount(), 1);
      assert.deepEqual(order, ["marker", "quit"]);
      assert.deepEqual(
        JSON.parse(readFileSync(recoveryMarkerPath, "utf8")).sessionIds,
        ["session-never-settled"],
      );
      assert.ok(Date.now() - startedAt < 500);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("排空与恢复标记双双卡死时仍在绝对期限内放行退出", async () => {
    const never = new Promise<void>(() => undefined);
    const drainActiveTurns = mock.fn(() => never);
    const markerWrite = mock.fn(() => never);
    const quit = mock.fn();
    const startedAt = Date.now();
    const coordinator = createDesktopQuitCoordinator({
      telemetryEnabled: () => true,
      captureAppClosed: mock.fn(),
      shutdownTelemetry: () => never,
      drainServer: (deadlineAtMs) =>
        drainDesktopSessionsForShutdown({
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
        }).then(() => undefined),
      stopExternalInstance: () => never,
      quit,
      // 生产值为 10 秒；测试保留真实 2 秒 marker 子预算，只缩短排空预算。
      deadlineMs: 2_100,
    });

    await coordinator.handleBeforeQuit({ preventDefault: mock.fn() });

    assert.equal(drainActiveTurns.mock.callCount(), 1);
    assert.equal(markerWrite.mock.callCount(), 1);
    assert.equal(quit.mock.callCount(), 1);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(
      elapsedMs >= 1_900 && elapsedMs < 3_000,
      `elapsed=${elapsedMs} 应在 2100ms 绝对期限附近退出`,
    );
  });
});

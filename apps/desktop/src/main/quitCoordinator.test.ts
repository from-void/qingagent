import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { createDesktopQuitCoordinator } from "./quitCoordinator.js";

describe("desktop quit coordinator", () => {
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
});

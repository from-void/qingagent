import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it, mock } from "node:test";
import {
  attachMainWindowProcessMonitor,
  handleChildProcessGone,
  logRenderingMode,
  type ProcessLifecycleLog,
} from "./processLifecycle.js";

it("每次启动以 processLifecycle 事件记录当前渲染模式", () => {
  const logs = createLogSink();

  logRenderingMode({ mode: "software", reason: "user-disabled" }, logs.log);

  assert.deepEqual(logs.entries, [{
    level: "info",
    event: "rendering-mode",
    details: { mode: "software", reason: "user-disabled" },
  }]);
});

class MockWebContents extends EventEmitter {
  readonly id = 59;
  destroyed = false;
  reload = mock.fn();

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getURL(): string {
    return "qingagent://app/#/workspace/session-r59";
  }

  getOSProcessId(): number {
    return 13250;
  }
}

function createLogSink(): {
  entries: Array<{ level: string; event: string; details: Record<string, unknown> }>;
  log: ProcessLifecycleLog;
} {
  const entries: Array<{
    level: string;
    event: string;
    details: Record<string, unknown>;
  }> = [];
  return {
    entries,
    log: (level, event, details) => entries.push({ level, event, details }),
  };
}

describe("main window process monitor", () => {
  it("renderer gone 详细落日志并在事件回调外 reload", () => {
    const contents = new MockWebContents();
    const scheduled: Array<() => void> = [];
    const logs = createLogSink();
    const showRecoveryStopped = mock.fn();

    attachMainWindowProcessMonitor(contents, {
      isQuitting: () => false,
      log: logs.log,
      now: () => 1_000,
      schedule: (task) => scheduled.push(task),
      showRecoveryStopped,
    });

    contents.emit("render-process-gone", {}, { reason: "oom", exitCode: 137 });

    assert.equal(contents.reload.mock.callCount(), 0);
    assert.equal(scheduled.length, 1);
    assert.deepEqual(logs.entries[0], {
      level: "error",
      event: "renderer-process-gone",
      details: {
        type: "Renderer",
        webContentsId: 59,
        osProcessId: 13250,
        url: "qingagent://app/#/workspace/session-r59",
        reason: "oom",
        exitCode: 137,
      },
    });

    scheduled.shift()?.();

    assert.equal(contents.reload.mock.callCount(), 1);
    assert.equal(showRecoveryStopped.mock.callCount(), 0);
    assert.equal(
      logs.entries.some((entry) =>
        entry.event === "renderer-recovery" && entry.details.action === "reload"
      ),
      true,
    );
  });

  it("30 秒内第二次 renderer gone 停止恢复并只显示一次产品提示", () => {
    const contents = new MockWebContents();
    const scheduled: Array<() => void> = [];
    const logs = createLogSink();
    const showRecoveryStopped = mock.fn();
    let now = 1_000;

    attachMainWindowProcessMonitor(contents, {
      isQuitting: () => false,
      log: logs.log,
      now: () => now,
      schedule: (task) => scheduled.push(task),
      showRecoveryStopped,
    });

    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: -1 });
    scheduled.shift()?.();
    now += 5_000;
    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: -1 });
    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: -1 });

    assert.equal(contents.reload.mock.callCount(), 1);
    assert.equal(showRecoveryStopped.mock.callCount(), 1);
    assert.equal(
      logs.entries.some((entry) =>
        entry.event === "renderer-recovery" &&
        entry.details.action === "stop" &&
        entry.details.reason === "repeated-process-failure" &&
        entry.details.elapsedMs === 5_000
      ),
      true,
    );
  });

  it("正常退出过程中记录但不 reload", () => {
    const contents = new MockWebContents();
    const scheduled: Array<() => void> = [];
    const logs = createLogSink();

    attachMainWindowProcessMonitor(contents, {
      isQuitting: () => true,
      log: logs.log,
      now: () => 1_000,
      schedule: (task) => scheduled.push(task),
      showRecoveryStopped: () => undefined,
    });

    contents.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });

    assert.equal(scheduled.length, 0);
    assert.equal(contents.reload.mock.callCount(), 0);
    assert.equal(
      logs.entries.some((entry) =>
        entry.event === "renderer-recovery" &&
        entry.details.action === "skip" &&
        entry.details.reason === "app-quitting"
      ),
      true,
    );
  });

  it("renderer gone 已排队后开始退出时仍取消 reload", () => {
    const contents = new MockWebContents();
    const scheduled: Array<() => void> = [];
    const logs = createLogSink();
    let quitting = false;

    attachMainWindowProcessMonitor(contents, {
      isQuitting: () => quitting,
      log: logs.log,
      now: () => 1_000,
      schedule: (task) => scheduled.push(task),
      showRecoveryStopped: () => undefined,
    });

    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    assert.equal(scheduled.length, 1);
    quitting = true;
    scheduled.shift()?.();

    assert.equal(contents.reload.mock.callCount(), 0);
    assert.equal(
      logs.entries.some((entry) =>
        entry.event === "renderer-recovery" &&
        entry.details.action === "skip" &&
        entry.details.reason === "app-quitting"
      ),
      true,
    );
  });

  it("unresponsive/responsive 记录持续时间和 renderer 上下文", () => {
    const contents = new MockWebContents();
    const logs = createLogSink();
    let now = 10_000;

    attachMainWindowProcessMonitor(contents, {
      isQuitting: () => false,
      log: logs.log,
      now: () => now,
      schedule: () => undefined,
      showRecoveryStopped: () => undefined,
    });

    contents.emit("unresponsive");
    now += 2_300;
    contents.emit("responsive");

    assert.deepEqual(logs.entries.map(({ event, details }) => ({ event, details })), [
      {
        event: "renderer-unresponsive",
        details: {
          webContentsId: 59,
          osProcessId: 13250,
          url: "qingagent://app/#/workspace/session-r59",
        },
      },
      {
        event: "renderer-responsive",
        details: {
          webContentsId: 59,
          osProcessId: 13250,
          url: "qingagent://app/#/workspace/session-r59",
          unresponsiveMs: 2_300,
        },
      },
    ]);
  });
});

describe("child process diagnostics", () => {
  it("GPU 异常退出详细落日志并请求主窗恢复", () => {
    const logs = createLogSink();
    const recoverGpu = mock.fn();

    handleChildProcessGone(
      {
        type: "GPU",
        reason: "crashed",
        exitCode: -1073741819,
        serviceName: "gpu-process",
        name: "GPU Process",
      },
      { log: logs.log, recoverGpu },
    );

    assert.deepEqual(logs.entries[0], {
      level: "error",
      event: "child-process-gone",
      details: {
        type: "GPU",
        reason: "crashed",
        exitCode: -1073741819,
        serviceName: "gpu-process",
        name: "GPU Process",
      },
    });
    assert.equal(recoverGpu.mock.callCount(), 1);
  });

  it("GPU clean-exit 与非 GPU 子进程只记录不恢复", () => {
    const logs = createLogSink();
    const recoverGpu = mock.fn();

    handleChildProcessGone(
      { type: "GPU", reason: "clean-exit", exitCode: 0 },
      { log: logs.log, recoverGpu },
    );
    handleChildProcessGone(
      { type: "Utility", reason: "oom", exitCode: 9 },
      { log: logs.log, recoverGpu },
    );

    assert.equal(recoverGpu.mock.callCount(), 0);
    assert.equal(logs.entries.filter((entry) => entry.event === "child-process-gone").length, 2);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  DIAGNOSTICS_EXPORT_CHANNEL,
  type DiagnosticsExportInput,
} from "../diagnosticsExportContract.js";
import { createExportDiagnostics } from "./diagnosticsExportBridgeCore.js";

const input: DiagnosticsExportInput = {
  privacyLevel: "L2",
  sessionIds: ["session-1"],
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("诊断导出 IPC 成功时返回包含落地路径的真实写盘结果", async () => {
  const invocations: Array<{ channel: string; input: DiagnosticsExportInput }> = [];
  const exportDiagnostics = createExportDiagnostics({
    async invoke(channel, receivedInput) {
      invocations.push({ channel, input: receivedInput });
      return { saved: true, path: "C:\\Users\\tester\\Downloads\\diag.zip" };
    },
  });

  assert.deepEqual(await exportDiagnostics(input), {
    saved: true,
    path: "C:\\Users\\tester\\Downloads\\diag.zip",
  });
  assert.deepEqual(invocations, [{ channel: DIAGNOSTICS_EXPORT_CHANNEL, input }]);
});

test("IPC 拒绝、畸形结果与无效输入都收口为固定失败原因", async () => {
  for (const [invoke, expected] of [
    [async () => { throw new Error("raw ipc error"); }, "request-failed"],
    [async () => ({ saved: true }), "not-started"],
    [async () => ({ saved: false, reason: "raw-internal-error" }), "not-started"],
  ] as const) {
    const exportDiagnostics = createExportDiagnostics({ invoke });
    assert.deepEqual(await exportDiagnostics(input), { saved: false, reason: expected });
  }

  let invoked = false;
  const exportDiagnostics = createExportDiagnostics({
    async invoke() {
      invoked = true;
      return { saved: true, path: "/downloads/diag.zip" };
    },
  });
  assert.deepEqual(
    await exportDiagnostics({ privacyLevel: "L2", sessionIds: [1] } as unknown as DiagnosticsExportInput),
    { saved: false, reason: "not-started" },
  );
  assert.equal(invoked, false);
});

test("诊断导出 IPC 在服务端已响应但保存链静默时限时失败，不让按钮永久等待", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const invoke = createDeferred<unknown>();
  const exportDiagnostics = createExportDiagnostics(
    { invoke: async () => invoke.promise },
    1_000,
  );
  let settled = false;
  const pendingExport = exportDiagnostics(input).then((result) => {
    settled = true;
    return result;
  });

  try {
    t.mock.timers.tick(999);
    await Promise.resolve();
    assert.equal(settled, false);

    t.mock.timers.tick(1);
    assert.deepEqual(await pendingExport, { saved: false, reason: "timeout" });
    assert.equal(settled, true, "保存分支静默后仍未解除 renderer 等待");
  } finally {
    invoke.resolve({ saved: false, reason: "window-closed" });
    await invoke.promise;
  }
});

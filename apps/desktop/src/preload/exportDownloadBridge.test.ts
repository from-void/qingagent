import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPORT_DOWNLOAD_SAVE_CHANNEL,
  type ExportDownloadSaveInput,
} from "../exportDownloadContract.js";
import { createSaveExportDownload } from "./exportDownloadBridgeCore.js";

const input: ExportDownloadSaveInput = {
  filename: "测试文档_20260802.html",
  format: "html",
  bytes: new Uint8Array(Buffer.from("<!doctype html><title>测试</title>")),
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("bridge 通过专用 IPC 传 Uint8Array 并返回主进程真实成功结果", async () => {
  const invocations: Array<{ channel: string; input: ExportDownloadSaveInput }> = [];
  const save = createSaveExportDownload({
    async invoke(channel, receivedInput) {
      invocations.push({ channel, input: receivedInput });
      return {
        saved: true,
        filename: receivedInput.filename,
        path: `/downloads/${receivedInput.filename}`,
        revealToken: "reveal-1",
      };
    },
  });

  assert.deepEqual(await save(input), {
    saved: true,
    filename: input.filename,
    path: `/downloads/${input.filename}`,
    revealToken: "reveal-1",
  });
  assert.equal(invocations[0]?.channel, EXPORT_DOWNLOAD_SAVE_CHANNEL);
  assert.equal(invocations[0]?.input, input);
  assert.deepEqual(Buffer.from(invocations[0]?.input.bytes ?? []), Buffer.from(input.bytes));
});

test("bridge 保留主进程的写盘失败原因，供 renderer 显示失败 toast", async () => {
  for (const reason of ["write-failed", "timeout", "window-closed"] as const) {
    const save = createSaveExportDownload({
      async invoke() {
        return { saved: false, filename: input.filename, reason };
      },
    });
    assert.deepEqual(await save(input), {
      saved: false,
      filename: input.filename,
      reason,
    });
  }
});

test("IPC 无 handler、拒绝或返回畸形结果时收口为 not-started", async () => {
  for (const invoke of [
    async () => {
      throw new Error("missing handler");
    },
    async () => ({ saved: true, filename: input.filename }),
    async () => ({ saved: false, filename: input.filename, reason: "raw-internal-error" }),
  ]) {
    const save = createSaveExportDownload({ invoke });
    assert.deepEqual(await save(input), {
      saved: false,
      filename: input.filename,
      reason: "not-started",
    });
  }
});

test("IPC 静默不返回时 bridge 自身超时，避免 renderer 永久等待", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const invoke = createDeferred<unknown>();
  const save = createSaveExportDownload(
    { invoke: async () => invoke.promise },
    1_000,
  );
  let settled = false;
  const pendingSave = save(input).then((result) => {
    settled = true;
    return result;
  });

  try {
    t.mock.timers.tick(999);
    await Promise.resolve();
    assert.equal(settled, false);

    t.mock.timers.tick(1);
    assert.deepEqual(await pendingSave, {
      saved: false,
      filename: input.filename,
      reason: "timeout",
    });
  } finally {
    invoke.resolve({
      saved: false,
      filename: input.filename,
      reason: "window-closed",
    });
    await invoke.promise;
    await Promise.resolve();
  }
});

test("bridge 拒绝 Blob URL/字符串等旧载荷，不再触发 anchor 下载", async () => {
  let invoked = false;
  const save = createSaveExportDownload({
    async invoke() {
      invoked = true;
      return null;
    },
  });
  const result = await save({
    filename: "测试文档_20260802.html",
    format: "html",
    bytes: "blob:qingagent://app/legacy",
  } as unknown as ExportDownloadSaveInput);
  assert.deepEqual(result, {
    saved: false,
    filename: "测试文档_20260802.html",
    reason: "not-started",
  });
  assert.equal(invoked, false);
});

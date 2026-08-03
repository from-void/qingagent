import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { ExportDownloadSaveInput } from "../exportDownloadContract.js";
import { exportDiagnosticsToDownloads } from "./diagnosticsExport.js";

test("服务端 200 后不等待原生保存框，直接把 ZIP 原子写入 Downloads 并返回完整路径", async () => {
  const saves: ExportDownloadSaveInput[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const result = await exportDiagnosticsToDownloads(
    {
      privacyLevel: "L2",
      report: "复现记录",
      sessionIds: ["session-1", "session-2"],
    },
    {
      serverOrigin: "http://127.0.0.1:45678",
      downloadsDirectory: path.join("C:", "Users", "tester", "Downloads"),
      authToken: "test-token",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          headers: {
            "Content-Disposition": "attachment; filename=\"fallback.zip\"; filename*=UTF-8''qingagent-diag-v1-20260803.zip",
          },
        });
      },
      save: async (input) => {
        saves.push(input);
        return {
          saved: true,
          filename: input.filename,
          path: path.join("C:", "Users", "tester", "Downloads", input.filename),
          revealToken: "reveal-diag",
        };
      },
    },
  );

  assert.deepEqual(result, {
    saved: true,
    path: path.join("C:", "Users", "tester", "Downloads", "qingagent-diag-v1-20260803.zip"),
  });
  assert.equal(requests[0]?.url, "http://127.0.0.1:45678/api/v1/diagnostics/export");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal((requests[0]?.init?.headers as Record<string, string>).Authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    privacyLevel: "L2",
    report: "复现记录",
    sessionIds: ["session-1", "session-2"],
  });
  assert.equal(saves[0]?.filename, "qingagent-diag-v1-20260803.zip");
  assert.equal(saves[0]?.format, "zip");
  assert.deepEqual(Array.from(saves[0]?.bytes ?? []), [0x50, 0x4b, 0x03, 0x04]);
});

test("服务端失败时不触发写盘并返回 request-failed", async () => {
  let saveCalled = false;
  const result = await exportDiagnosticsToDownloads(
    { privacyLevel: "L1", sessionIds: [] },
    {
      serverOrigin: "http://127.0.0.1:45678",
      downloadsDirectory: "/downloads",
      fetchImpl: async () => new Response("failed", { status: 503 }),
      save: async () => {
        saveCalled = true;
        return { saved: false, filename: "diag.zip", reason: "write-failed" };
      },
    },
  );

  assert.deepEqual(result, { saved: false, reason: "request-failed" });
  assert.equal(saveCalled, false);
});

test("写盘显式失败或异常时都返回失败，不误报文件路径", async () => {
  for (const save of [
    async () => ({
      saved: false as const,
      filename: "diag.zip",
      reason: "missing-file" as const,
    }),
    async () => {
      throw new Error("disk disconnected");
    },
  ]) {
    const result = await exportDiagnosticsToDownloads(
      { privacyLevel: "L1" },
      {
        serverOrigin: "http://127.0.0.1:45678",
        downloadsDirectory: "/downloads",
        fetchImpl: async () => new Response("PK", {
          headers: { "Content-Disposition": "attachment; filename=diag.zip" },
        }),
        save,
      },
    );

    assert.equal(result.saved, false);
    assert.ok(
      !result.saved && (result.reason === "missing-file" || result.reason === "write-failed"),
    );
  }
});

test("服务端请求静默时主动超时，且不触发写盘", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let saveCalled = false;
  const pending = exportDiagnosticsToDownloads(
    { privacyLevel: "L2", sessionIds: ["session-1"] },
    {
      serverOrigin: "http://127.0.0.1:45678",
      downloadsDirectory: "/downloads",
      requestTimeoutMs: 1_000,
      fetchImpl: async () => new Promise<Response>(() => undefined),
      save: async () => {
        saveCalled = true;
        return { saved: false, filename: "diag.zip", reason: "write-failed" };
      },
    },
  );

  t.mock.timers.tick(1_000);
  assert.deepEqual(await pending, { saved: false, reason: "timeout" });
  assert.equal(saveCalled, false);
});

test("服务端已返回 200 但响应体静默时仍主动超时，不进入写盘", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let saveCalled = false;
  const pending = exportDiagnosticsToDownloads(
    { privacyLevel: "L2", sessionIds: ["session-1"] },
    {
      serverOrigin: "http://127.0.0.1:45678",
      downloadsDirectory: "/downloads",
      requestTimeoutMs: 1_000,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({
          "Content-Disposition": "attachment; filename=\"diag.zip\"",
        }),
        arrayBuffer: async () => new Promise<ArrayBuffer>(() => undefined),
      } as Response),
      save: async () => {
        saveCalled = true;
        return { saved: false, filename: "diag.zip", reason: "write-failed" };
      },
    },
  );

  t.mock.timers.tick(1_000);
  assert.deepEqual(await pending, { saved: false, reason: "timeout" });
  assert.equal(saveCalled, false);
});

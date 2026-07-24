import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertTrustedRenderer,
  UntrustedRendererIpcError,
} from "./ipcTrust.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("IPC 只接受主窗口 mainFrame，其他 sender/子 frame 均拒绝", () => {
  const mainFrame = {};
  const trusted = { mainFrame, isDestroyed: () => false };

  assert.doesNotThrow(() => assertTrustedRenderer({ sender: trusted, senderFrame: mainFrame }, trusted));
  assert.throws(
    () => assertTrustedRenderer({ sender: { mainFrame: {} }, senderFrame: {} }, trusted),
    UntrustedRendererIpcError,
  );
  assert.throws(
    () => assertTrustedRenderer({ sender: trusted, senderFrame: {} }, trusted),
    UntrustedRendererIpcError,
  );
  assert.throws(
    () => assertTrustedRenderer({ sender: trusted, senderFrame: mainFrame }, null),
    UntrustedRendererIpcError,
  );
});

test("preload 只暴露目的明确的配置 API，不暴露整份 clientConfig 或通用 setter", () => {
  const preload = readFileSync(path.join(__dirname, "../preload/index.ts"), "utf8");
  assert.doesNotMatch(preload, /^\s*clientConfig\s*[,}]/m);
  assert.doesNotMatch(preload, /^\s*setClientConfig\s*:/m);
  for (const api of [
    "getDeepseekApiKey",
    "setDeepseekApiKey",
    "getCustomProvider",
    "setCustomProvider",
    "getVisionProvider",
    "setVisionProvider",
    "getOfficialModel",
    "setOfficialModel",
    "getModelTier",
    "setModelTier",
  ]) {
    assert.match(preload, new RegExp(`\\b${api}\\b`), `缺少具名 preload API: ${api}`);
  }
});

test("desktop main 的每个 IPC channel 都先校验 trusted renderer", () => {
  const main = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const registrations = [...main.matchAll(/ipcMain\.(?:handle|on)\(/g)];
  assert.ok(registrations.length > 0);
  for (const registration of registrations) {
    const start = registration.index ?? 0;
    const handlerPrefix = main.slice(start, start + 260);
    assert.match(
      handlerPrefix,
      /assertTrustedRenderer\(event\)/,
      `IPC 注册缺少统一 sender/mainFrame 校验：${handlerPrefix.split("\n")[0]}`,
    );
  }
});

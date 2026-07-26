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

test("IPC 只接受指定窗口的 mainFrame，主窗口/DevTools/其他 sender/子 frame 均拒绝", () => {
  const promptMainFrame = {};
  const prompt = { mainFrame: promptMainFrame, isDestroyed: () => false };
  const mainWindow = { mainFrame: {}, isDestroyed: () => false };
  const devtools = { mainFrame: {}, isDestroyed: () => false };

  assert.doesNotThrow(
    () => assertTrustedRenderer({ sender: prompt, senderFrame: promptMainFrame }, prompt),
  );
  assert.throws(
    () => assertTrustedRenderer({ sender: mainWindow, senderFrame: mainWindow.mainFrame }, prompt),
    UntrustedRendererIpcError,
  );
  assert.throws(
    () => assertTrustedRenderer({ sender: devtools, senderFrame: devtools.mainFrame }, prompt),
    UntrustedRendererIpcError,
  );
  assert.throws(
    () => assertTrustedRenderer({ sender: { mainFrame: {} }, senderFrame: {} }, prompt),
    UntrustedRendererIpcError,
  );
  assert.throws(
    () => assertTrustedRenderer({ sender: prompt, senderFrame: {} }, prompt),
    UntrustedRendererIpcError,
  );
  assert.throws(
    () => assertTrustedRenderer({ sender: prompt, senderFrame: promptMainFrame }, null),
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
    "getKimiApiKey",
    "setKimiApiKey",
    "getKimiCustomProvider",
    "setKimiCustomProvider",
    "getKimiOfficialModel",
    "setKimiOfficialModel",
    "getModelProvider",
    "setModelProvider",
  ]) {
    assert.match(preload, new RegExp(`\\b${api}\\b`), `缺少具名 preload API: ${api}`);
  }
});

test("桌面客户端配置白名单完整覆盖 Kimi 与厂商选择配置", () => {
  const main = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const preload = readFileSync(path.join(__dirname, "../preload/index.ts"), "utf8");
  const configSetStart = main.indexOf("const DESKTOP_CLIENT_CONFIG_KEYS");
  const configSetEnd = main.indexOf("]);", configSetStart);
  const configSetSource = main.slice(configSetStart, configSetEnd);
  for (const key of [
    "qingagent.kimi_api_key",
    "qingagent.kimi_custom_provider",
    "qingagent.kimi_official_model",
    "qingagent.model_provider",
  ]) {
    assert.ok(configSetSource.includes(`"${key}"`), `主进程白名单缺少：${key}`);
    assert.ok(preload.includes(`"${key}"`), `preload 白名单缺少：${key}`);
  }
  for (const secretKey of [
    "qingagent.kimi_api_key",
    "qingagent.kimi_custom_provider",
  ]) {
    const secretSetStart = main.indexOf("const DESKTOP_MODEL_SECRET_KEYS");
    const secretSetEnd = main.indexOf("]);", secretSetStart);
    assert.ok(
      main.slice(secretSetStart, secretSetEnd).includes(`"${secretKey}"`),
      `Kimi 敏感配置必须经 safeStorage 加密：${secretKey}`,
    );
  }
});

test("desktop main 的每个 IPC channel 都先校验 trusted renderer", () => {
  const main = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const registrations = [...main.matchAll(/ipcMain\.(?:handle|on)\(/g)];
  const rememberRegistration = "ipcMain.on(REMEMBER_PROMPT_DECISION_CHANNEL, handleDecision);";
  const rememberRegistrationIndex = main.indexOf(rememberRegistration);
  const rememberHandlerIndex = main.lastIndexOf(
    "const handleDecision =",
    rememberRegistrationIndex,
  );

  assert.ok(registrations.length > 0);
  assert.ok(rememberRegistrationIndex >= 0, "缺少记忆决策 IPC 注册");
  assert.ok(rememberHandlerIndex >= 0, "缺少记忆决策 IPC handler");
  assert.match(
    main.slice(rememberHandlerIndex, rememberHandlerIndex + 360),
    /const handleDecision = \([\s\S]{0,180}?\) => \{\s*try \{\s*assertTrustedRenderer\(event, promptWindow\.webContents\);\s*\} catch \{\s*return;\s*\}/,
    "记忆决策 IPC 必须先按独立确认窗的 webContents/mainFrame 校验并 fail closed",
  );
  assert.match(
    main,
    /function assertTrustedRenderer\([\s\S]{0,220}?expectedRenderer: WebContents \| null = mainWindow\?\.webContents \?\? null,[\s\S]{0,80}?assertTrustedRendererEvent\(event, expectedRenderer\);/,
    "统一 IPC 校验必须把显式指定的 renderer 传给底层身份/mainFrame 校验",
  );

  for (const registration of registrations) {
    const start = registration.index ?? 0;
    const handlerPrefix = main.slice(start, start + 260);
    if (handlerPrefix.startsWith(rememberRegistration)) continue;
    assert.match(
      handlerPrefix,
      /assertTrustedRenderer\(event\)/,
      `IPC 注册缺少统一 sender/mainFrame 校验：${handlerPrefix.split("\n")[0]}`,
    );
  }
});

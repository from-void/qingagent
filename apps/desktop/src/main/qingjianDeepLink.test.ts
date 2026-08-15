import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseQingjianDeepLink,
  QingjianDeepLinkDispatcher,
  registerQingjianProtocolClient,
} from "./qingjianDeepLink.js";

const SESSION_ID = "49a55065-4f9f-4f58-8f1b-5ff8ef41f7a2";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("解析 qingjian open 会话 URL", () => {
  assert.deepEqual(
    parseQingjianDeepLink(`qingjian://open?engineSessionId=${SESSION_ID}`),
    { engineSessionId: SESSION_ID },
  );
  assert.deepEqual(
    parseQingjianDeepLink(`QINGJIAN://OPEN?engineSessionId=${SESSION_ID.toUpperCase()}`),
    { engineSessionId: SESSION_ID.toUpperCase() },
  );
});

test("拒绝非 open 动作、非 UUID、额外字段及 URL 变体", () => {
  const rejected = [
    `qingjian://edit?engineSessionId=${SESSION_ID}`,
    "qingjian://open?engineSessionId=not-a-uuid",
    `qingjian://open?engineSessionId=${SESSION_ID}&next=https://example.com`,
    `qingjian://open/path?engineSessionId=${SESSION_ID}`,
    `qingjian://user@open?engineSessionId=${SESSION_ID}`,
    `qingjian://open?engineSessionId=${SESSION_ID}#/workspace`,
    `https://open?engineSessionId=${SESSION_ID}`,
  ];
  for (const url of rejected) assert.equal(parseQingjianDeepLink(url), null, url);
});

test("argv 调度器在 renderer 就绪前暂存，并采用最后一个合法 URL", () => {
  const latest = "be2b1d8c-0aa0-4eab-a4d7-ef4a9f418f50";
  const dispatcher = new QingjianDeepLinkDispatcher([
    "qingagent.exe",
    `qingjian://open?engineSessionId=${SESSION_ID}`,
    "--flag",
    `qingjian://open?engineSessionId=${latest}`,
  ]);
  const received: string[] = [];
  assert.equal(dispatcher.setHandler((intent) => received.push(intent.engineSessionId)), true);
  assert.deepEqual(received, [latest]);
});

test("开发态注册携带 Electron 入口脚本，打包态直接注册 scheme", () => {
  const calls: unknown[][] = [];
  const protocolApp = {
    setAsDefaultProtocolClient: (...args: [string, string?, string[]?]) => {
      calls.push(args);
      return true;
    },
  };
  assert.equal(registerQingjianProtocolClient(protocolApp, {
    defaultApp: true,
    execPath: "C:\\Electron\\electron.exe",
    entryScript: "C:\\repo\\apps\\desktop\\src\\main\\index.ts",
  }), true);
  assert.equal(registerQingjianProtocolClient(protocolApp, {
    defaultApp: false,
    execPath: "C:\\Program Files\\qingagent\\qingagent.exe",
  }), true);
  assert.deepEqual(calls, [
    ["qingjian", "C:\\Electron\\electron.exe", ["C:\\repo\\apps\\desktop\\src\\main\\index.ts"]],
    ["qingjian"],
  ]);
});

test("electron-builder 安装产物声明 qingjian 协议", () => {
  const builderConfig = readFileSync(
    path.join(__dirname, "../../electron-builder.yml"),
    "utf8",
  );
  assert.match(builderConfig, /protocols:\s*[\s\S]*schemes:\s*[\s\S]*- qingjian/);
});

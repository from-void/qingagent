import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createDesktopAppProxyHandler,
  DesktopAppDeepLinkDispatcher,
  DESKTOP_APP_ORIGIN,
  DESKTOP_APP_URL,
  resolveDesktopContentUrl,
} from "./desktopAppProtocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("打包 renderer 固定 origin 与监听端口解耦", () => {
  assert.equal(DESKTOP_APP_URL, "qingagent://app/");
  assert.equal(DESKTOP_APP_ORIGIN, "qingagent://app");
  assert.equal(DESKTOP_APP_ORIGIN.includes("21823"), false);
});

test("安装产物登记 qingagent 外部协议", () => {
  const builderConfig = readFileSync(
    path.join(__dirname, "../../electron-builder.yml"),
    "utf8",
  );
  assert.match(builderConfig, /protocols:\s*[\s\S]*schemes:\s*[\s\S]*- qingagent/);
});

test("冷启动 session 深链在内容导航就绪前只暂存，就绪后原样直达", () => {
  const sessionUrl = "qingagent://app/#/workspace?session=49a55065-cold-start";
  const navigated: string[] = [];
  const dispatcher = new DesktopAppDeepLinkDispatcher([
    "C:\\Program Files\\qingagent\\qingagent.exe",
    sessionUrl,
  ]);

  assert.equal(navigated.length, 0, "server/protocol 未就绪时不得提前导航");
  assert.equal(
    dispatcher.setNavigator((url) => navigated.push(url)),
    true,
    "绑定内容导航器时应自动排空冷启动深链",
  );
  assert.deepEqual(navigated, [sessionUrl]);
});

test("server 就绪前的二次实例深链覆盖旧目标且转成当前内容 origin", () => {
  const dispatcher = new DesktopAppDeepLinkDispatcher([
    "qingagent.exe",
    "qingagent://app/#/workspace?session=stale",
  ]);
  const latest = "qingagent://app/#/workspace?session=latest&viewingVersion=3";
  const navigated: string[] = [];

  assert.equal(dispatcher.offerCommandLine(["qingagent.exe", latest]), true);
  dispatcher.setNavigator((url) => navigated.push(
    resolveDesktopContentUrl("http://localhost:6173", url),
  ));

  assert.deepEqual(navigated, [
    "http://localhost:6173/#/workspace?session=latest&viewingVersion=3",
  ]);
});

test("深链入口只接受固定 app host 的根路径 hash 路由", () => {
  const dispatcher = new DesktopAppDeepLinkDispatcher();
  const navigated: string[] = [];
  dispatcher.setNavigator((url) => navigated.push(url));

  assert.equal(dispatcher.offerUrl("qingagent://app/#/workspace?session=ok"), true);
  assert.equal(dispatcher.offerUrl("qingagent://other/#/workspace?session=bad"), false);
  assert.equal(dispatcher.offerUrl("qingagent://app/api/v1/home#/workspace?session=bad"), false);
  assert.equal(dispatcher.offerUrl("qingagent://app/?source=bad#/workspace?session=bad"), false);
  assert.equal(dispatcher.offerUrl("https://example.com/#/workspace?session=bad"), false);
  assert.deepEqual(navigated, ["qingagent://app/#/workspace?session=ok"]);
});

test("固定 origin 请求按路径、方法和请求体流式转发到实际随机端口", async () => {
  const forwarded: Request[] = [];
  const handler = createDesktopAppProxyHandler(43127, async (request) => {
    forwarded.push(request);
    return new Response("ok");
  });
  const request = new Request("qingagent://app/api/v1/commands?source=desktop", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: DESKTOP_APP_ORIGIN,
    },
    body: JSON.stringify({ command: "write" }),
    duplex: "half",
  } as RequestInit);

  const response = await handler(request);

  assert.equal(await response.text(), "ok");
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]?.url, "http://127.0.0.1:43127/api/v1/commands?source=desktop");
  assert.equal(forwarded[0]?.method, "POST");
  assert.equal(forwarded[0]?.headers.get("origin"), "http://127.0.0.1:43127");
  assert.deepEqual(await forwarded[0]?.json(), { command: "write" });
});

test("固定协议拒绝其他 host，避免变成任意本机代理", async () => {
  let fetchCalls = 0;
  const handler = createDesktopAppProxyHandler(43127, async () => {
    fetchCalls += 1;
    return new Response("unexpected");
  });

  const response = await handler(new Request("qingagent://other/api/v1/home"));

  assert.equal(response.status, 404);
  assert.equal(fetchCalls, 0);
});

test("正确 host 的双斜杠路径仍只能转发到实际回环端口", async () => {
  const forwarded: Request[] = [];
  const handler = createDesktopAppProxyHandler(43127, async (request) => {
    forwarded.push(request);
    return new Response("ok");
  });

  const response = await handler(
    new Request("qingagent://app//example.invalid/steal?x=1"),
  );

  assert.equal(response.status, 200);
  assert.equal(forwarded.length, 1);
  assert.equal(
    forwarded[0]?.url,
    "http://127.0.0.1:43127//example.invalid/steal?x=1",
  );
  assert.equal(new URL(forwarded[0]!.url).origin, "http://127.0.0.1:43127");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDesktopAppProxyHandler,
  DESKTOP_APP_ORIGIN,
  DESKTOP_APP_URL,
} from "./desktopAppProtocol.js";

test("打包 renderer 固定 origin 与监听端口解耦", () => {
  assert.equal(DESKTOP_APP_URL, "qingagent://app/");
  assert.equal(DESKTOP_APP_ORIGIN, "qingagent://app");
  assert.equal(DESKTOP_APP_ORIGIN.includes("21823"), false);
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

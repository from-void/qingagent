import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isAllowedMainFrameNavigation,
  shouldOpenMainWindowNavigationExternally,
} from "./navigationPolicy.js";

const currentUrl = "http://localhost:8080/projects/123";
const devUrl = "http://localhost:6173";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("will-navigate 仅放行当前同源 http(s) 与开发服务器", () => {
  assert.equal(isAllowedMainFrameNavigation("http://localhost:8080/settings", currentUrl, devUrl), true);
  assert.equal(isAllowedMainFrameNavigation("https://localhost:8080/settings", currentUrl, devUrl), false);
  assert.equal(isAllowedMainFrameNavigation("http://localhost:6173/@vite/client", currentUrl, devUrl), true);
});

test("will-navigate 拦截 file、about、跨源与畸形 URL", () => {
  assert.equal(isAllowedMainFrameNavigation("file:///tmp/untrusted.html", currentUrl, devUrl), false);
  assert.equal(isAllowedMainFrameNavigation("about:blank", currentUrl, devUrl), false);
  assert.equal(isAllowedMainFrameNavigation("https://example.com", currentUrl, devUrl), false);
  assert.equal(isAllowedMainFrameNavigation("not a url", currentUrl, devUrl), false);
});

test("will-redirect 拦截同源入口 30x 到跨源目标", () => {
  assert.equal(isAllowedMainFrameNavigation("https://evil.example/path", currentUrl, devUrl), false);
  assert.equal(isAllowedMainFrameNavigation("http://localhost:8080/redirected", currentUrl, devUrl), true);
  assert.equal(isAllowedMainFrameNavigation("http://localhost:6173/@vite/client", currentUrl, devUrl), true);
});

test("主窗口同时注册 will-navigate 与 will-redirect 导航守卫", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  assert.match(source, /\.on\("will-navigate", \(event, url\) =>/);
  assert.match(source, /\.on\("will-redirect", guardMainFrameNavigation\)/);
});

test("data 启动壳阶段的外部 http(s) 导航仍会交给系统浏览器", () => {
  const allowedAppOrigins = new Set([
    "http://localhost:21823",
    "http://127.0.0.1:21823",
    "http://localhost:6173",
  ]);

  assert.equal(
    shouldOpenMainWindowNavigationExternally("https://example.com/article", allowedAppOrigins),
    true,
  );
  assert.equal(
    shouldOpenMainWindowNavigationExternally("http://localhost:21823/workspace", allowedAppOrigins),
    false,
  );
  assert.equal(
    shouldOpenMainWindowNavigationExternally("http://127.0.0.1:21823/workspace", allowedAppOrigins),
    false,
  );
  assert.equal(
    shouldOpenMainWindowNavigationExternally("http://localhost:6173/workspace", allowedAppOrigins),
    false,
  );
});

test("启动壳切入已登记的内置服务 origin，同时继续拒绝非 Web scheme", () => {
  const allowedAppOrigins = new Set(["http://localhost:21823"]);
  assert.equal(
    isAllowedMainFrameNavigation(
      "http://localhost:21823/workspace",
      "data:text/html,loading",
      undefined,
      allowedAppOrigins,
    ),
    true,
  );
  assert.equal(
    isAllowedMainFrameNavigation(
      "file:///tmp/untrusted.html",
      "data:text/html,loading",
      undefined,
      allowedAppOrigins,
    ),
    false,
  );
});

test("启动壳只允许登记后的固定桌面 scheme 与精确 host", () => {
  const allowedAppOrigins = new Set(["qingagent://app"]);
  assert.equal(
    isAllowedMainFrameNavigation(
      "qingagent://app/#/workspace",
      "data:text/html,loading",
      undefined,
      allowedAppOrigins,
    ),
    true,
  );
  assert.equal(
    isAllowedMainFrameNavigation(
      "qingagent://other/#/workspace",
      "data:text/html,loading",
      undefined,
      allowedAppOrigins,
    ),
    false,
  );
});

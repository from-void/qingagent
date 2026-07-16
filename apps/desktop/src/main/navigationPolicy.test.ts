import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedMainFrameNavigation } from "./navigationPolicy.js";

const currentUrl = "http://localhost:8080/projects/123";
const devUrl = "http://localhost:6173";

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

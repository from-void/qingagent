import "@qingagent/ui-kit";

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./system/ErrorBoundary";
import { installAuthFetchInterceptor } from "./system/authGate";
import { initPerfMetrics } from "./system/perf/perfMetrics";
import { initPerfTier } from "./system/perf/motionTier";
import {
  clearPreloadReloadMarker,
  createPreloadErrorHandler,
} from "./system/preloadRecovery";

// 标题栏带上打包信息(桌面原生标题栏/浏览器标签都能看到),便于一眼确认这个包是什么时候打的。
document.title = `青简 · ${__BUILD_INFO__}`;

// vite:preloadError:动态 import 的 chunk 预加载失败(最常见于 VPS 部署后换了 chunk hash、
// 旧 tab 点进 lazy 路由,旧 chunk URL 已 404)。自动 reload 一次拉取最新 index.html + chunk;
// sessionStorage 或 URL 标志防 reload 死循环(已刷过一次仍失败→不再刷,交给 ErrorBoundary 兜底)。
window.addEventListener("vite:preloadError", createPreloadErrorHandler(window));

installAuthFetchInterceptor();
initPerfTier();
initPerfMetrics();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// 应用成功挂载并存活一段时间后清除 reload 标志:证明这次加载没再 chunk 失败,
// 让未来的新部署仍能再触发一次自动 reload(否则首次刷过后标志永留、后续部署不再自愈)。
window.setTimeout(() => {
  clearPreloadReloadMarker(window);
}, 10_000);

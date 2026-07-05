// 渲染端埋点(注入到页面主世界,由桌面主进程 executeJavaScript 注入;apps/web 零侵入、零风险)。
// 经同源中继上报。全部包 try/catch、静默失败,绝不影响页面。
// 只采集:pageview(分屏)+ 渲染端错误。语义事件(发消息/应用编辑/导出/配key)由主进程
// API 观察钩子负责——渲染端不做 click/工具块观测(噪音大、省额度,产品决策)。
// 隐私:url 去 query;错误消息脱敏截断;不取任何输入值/正文。
import { redactPotentialPii } from "../main/telemetry/redact.js";

type CommonProps = {
  appVersion: string;
  platform: string;
  arch: string;
  locale: string;
  electronVersion: string;
  nodeVersion: string;
};

type TelemetryBootstrap = {
  endpoint: string;
  websiteId: string;
  distinctId: string;
  commonProperties: CommonProps;
};

declare global {
  interface Window {
    __QING_TELEMETRY__?: TelemetryBootstrap;
    __QING_PH_INITED__?: boolean;
  }
}

function getCfg(): TelemetryBootstrap | null {
  const c = window.__QING_TELEMETRY__;
  if (!c?.endpoint || !c.websiteId || !c.distinctId) return null;
  return c;
}

// hash 路由 → /#/xxx,去掉 ? 之后的 query(含 hash-query),防敏感参数外泄。
function cleanHashPath(): string {
  const raw = window.location.hash || "#/";
  const noQuery = raw.split("?")[0];
  const hash = noQuery.startsWith("#") ? noQuery : `#${noQuery}`;
  return `/${hash}`;
}

function post(body: unknown): void {
  const c = getCfg();
  if (!c) return;
  const json = JSON.stringify(body);
  try {
    // 同源中继:发给 app 内嵌 localhost 服务器的 /__telemetry/send,由主进程转发 Umami。
    // 渲染端绝不直连公网——直连会栽在 CORS(sendBeacon 强制带凭据 vs ACAO:*)或用户机器的
    // 系统代理/防火墙拦 Chromium 直连 IP(实测:主进程 Node 通、渲染端不通)。同源相对路径
    // 无 CORS、无预检、Chromium 对 localhost 默认绕过代理,整类问题消失。
    void fetch("/__telemetry/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: json,
      keepalive: true,
      credentials: "omit",
    }).catch(() => {});
  } catch {
    // 埋点失败不影响页面。
  }
}

function basePayload(extra: Record<string, unknown>): unknown {
  const c = getCfg() as TelemetryBootstrap;
  return {
    type: "event",
    payload: {
      website: c.websiteId,
      hostname: "desktop",
      language: c.commonProperties.locale,
      url: cleanHashPath(),
      ...extra,
    },
  };
}

function sendPageview(): void {
  post(basePayload({})); // 无 name = pageview
}

function sendEvent(name: string, data: Record<string, unknown>): void {
  const c = getCfg() as TelemetryBootstrap;
  post(basePayload({ name, data: { ...data, device_id: c.distinctId } }));
}

function installPageviews(): void {
  sendPageview();
  let last = cleanHashPath();
  window.addEventListener("hashchange", () => {
    const next = cleanHashPath();
    if (next === last) return;
    last = next;
    sendPageview();
  });
}


// 设置弹框展示:HomeSettingsSheet 是条件渲染(open 才挂载),根节点 .qj-sheet-backdrop
// 出现一次 = 打开一次,如实上报;粒度由服务端网关规则决定。
function installSettingsObserver(): void {
  try {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of Array.from(m.addedNodes)) {
          if (!(n instanceof Element)) continue;
          if (n.matches?.(".qj-sheet-backdrop") || n.querySelector?.(".qj-sheet-backdrop")) {
            sendEvent("settings_shown", {});
            return;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  } catch {
    /* 观测失败不影响页面 */
  }
}

function safeMessage(reason: unknown): string {
  const m = reason instanceof Error ? reason.message : String(reason);
  return redactPotentialPii(m).slice(0, 500);
}

function installErrorCapture(): void {
  window.addEventListener("error", (ev) => {
    const err = (ev as ErrorEvent).error;
    sendEvent("app_error_renderer", {
      errorName: err instanceof Error ? err.name : "Error",
      errorMessage: safeMessage((ev as ErrorEvent).message),
    });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const reason = (ev as PromiseRejectionEvent).reason;
    sendEvent("app_error_renderer", {
      errorName: reason instanceof Error ? reason.name : "UnhandledRejection",
      errorMessage: safeMessage(reason),
    });
  });
}

function initTelemetry(): void {
  if (window.__QING_PH_INITED__) return;
  if (!getCfg()) return;
  window.__QING_PH_INITED__ = true;
  installPageviews();
  installSettingsObserver();
  installErrorCapture();
}

initTelemetry();

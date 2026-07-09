import { createTool } from "@mastra/core/tools";
import type { Browser, Page } from "playwright";
import { z } from "zod";
import { browserLaunchCandidates } from "../browser/pool.js";
import {
  getCredentialsForPlatform,
  saveCredentialRecord,
} from "../credentials/credentialsRepo.js";
import { startToolHeartbeat } from "./toolHeartbeat.js";

const WECHAT_PLATFORM = "wechat";
// **单用户桌面的单实例假设**:scope 恒 "default",authState/activeAuthBrowser 为模块级全局。
// 多会话托管时会互相干扰(互关 browser、状态串写),届时需按 session 隔离状态与 browser。
const WECHAT_SCOPE = "default";
const WECHAT_LOGIN_URL = "https://mp.weixin.qq.com/";
const WECHAT_HOME_URL_RE = /\/cgi-bin\/home/;
const WECHAT_QR_SELECTOR = ".login__type__container__scan__qrcode";
const WECHAT_AUTH_TIMEOUT_MS = 240_000;
const WECHAT_AUTH_EXPIRES_IN_SEC = 240;
const WECHAT_CREDENTIAL_TTL_MS = 80 * 3600 * 1000;
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type AuthState = "authorizing" | "ready" | "failed";

const authState = new Map<string, AuthState>();
// 同一时刻只保留一个扫码 browser:新扫码先关旧的,防后台轮询(240s)期间 headless chromium 进程堆积拖慢新 launch。
let activeAuthBrowser: Browser | null = null;

function applyStealthInitScript(): void {
  (globalThis as unknown as { __name?: (fn: unknown) => unknown }).__name ||= (fn) => fn;
  try {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  } catch {
    /* ignore */
  }
  try {
    if (!(window as unknown as { chrome?: unknown }).chrome) {
      (window as unknown as { chrome?: unknown }).chrome = { runtime: {} };
    }
  } catch {
    /* ignore */
  }
  try {
    Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
  } catch {
    /* ignore */
  }
  try {
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5].map((i) => ({ name: `Plugin ${i}` })),
    });
  } catch {
    /* ignore */
  }
  try {
    const perms = navigator.permissions as unknown as {
      query?: (d: { name: string }) => Promise<unknown>;
    };
    const orig = perms?.query?.bind(navigator.permissions);
    if (orig) {
      perms.query = (d: { name: string }) =>
        d && d.name === "notifications"
          ? Promise.resolve({ state: Notification.permission } as unknown)
          : orig(d);
    }
  } catch {
    /* ignore */
  }
}

async function readMpName(page: Page): Promise<string> {
  const selectors = [
    ".weui-desktop-account__nickname",
    ".weui-desktop-account__info",
    ".account_meta_info",
    ".weui-desktop-head__account",
  ];
  for (const selector of selectors) {
    try {
      const text = (await page.locator(selector).innerText({ timeout: 1000 })).trim();
      if (text) return text;
    } catch {
      // 后台顶栏结构可能变化,公众号名不是登录态凭据的硬依赖。
    }
  }
  return "";
}

function cookieHeaderFromCookies(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

// 扫码专用:独立 launch 一个 browser(复用 pool 的启动候选顺序),与共享抓取池隔离。
// 扫码要等用户扫码 ~240s,若共用抓取池的并发槽会把槽占满、拖垮文章抓取。
async function launchStandaloneBrowser(): Promise<Browser> {
  let lastError: unknown;
  for (const candidate of browserLaunchCandidates()) {
    try {
      return await candidate.launch();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export const wechatAuthStartTool = createTool({
  id: "wechat_auth_start",
  description: "打开微信公众号后台登录页,返回扫码二维码图片,并在后台等待扫码成功后保存微信登录凭据。",
  inputSchema: z.object({}),
  outputSchema: z.object({
    ok: z.boolean(),
    imageDataUri: z.string(),
    expiresInSec: z.number(),
  }),
  execute: async (_input, context) => {
    // 路由评测短路:只测"模型是否选中本工具",不真开浏览器截码(WECHAT_AUTH_EVAL_NOOP=1)。
    if (process.env.WECHAT_AUTH_EVAL_NOOP === "1") {
      return { ok: true, imageDataUri: "data:image/png;base64,ZVZBTA==", expiresInSec: 240 };
    }
    const stop = startToolHeartbeat(context, { tool: "wechat_auth_start" });
    try {
      authState.set(WECHAT_SCOPE, "authorizing");
      let settled = false;
      // 新扫码作废上一张未完成的:关掉上一个扫码 browser,防其后台轮询期间 chromium 堆积。
      await activeAuthBrowser?.close().catch(() => {});
      activeAuthBrowser = null;

      let authBrowser: Browser | null = null;
      const imageDataUri = await new Promise<string>((resolve, reject) => {
        void (async () => {
          // 扫码用独立 browser(见 launchStandaloneBrowser),不占共享抓取池的并发槽——
          // 否则多次扫码的后台轮询(各 240s)会把 3 个槽占满、拖垮文章抓取(实测:server 里卡死不返回)。
          try {
            authBrowser = await launchStandaloneBrowser();
            activeAuthBrowser = authBrowser;
            const browserContext = await authBrowser.newContext({
              userAgent: DESKTOP_UA,
              locale: "zh-CN",
            });
            await browserContext.addInitScript(applyStealthInitScript);
            const page = await browserContext.newPage();
            await page.goto(WECHAT_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
            const qrElement = await page.waitForSelector(WECHAT_QR_SELECTOR, { timeout: 10_000 });
            // .login__type__container__scan__qrcode 本身是个 <img>(src=scanloginqrcode 接口),
            // waitForSelector 只保证元素在、二维码图未必已下载完 → 立即截图会得到白框。
            // 先等该 img 的 naturalWidth 有值(图已解码),再截;仍偏小(空框仅几百字节)则再等再截。
            await page
              .waitForFunction(
                (sel) => {
                  const img = document.querySelector(sel);
                  return img instanceof HTMLImageElement && img.naturalWidth > 50;
                },
                WECHAT_QR_SELECTOR,
                { timeout: 10_000 },
              )
              .catch(() => {});
            let screenshot = await qrElement.screenshot({ type: "png" });
            for (let i = 0; i < 5 && screenshot.length < 1500; i += 1) {
              await page.waitForTimeout(400);
              screenshot = await qrElement.screenshot({ type: "png" });
            }
            settled = true;
            resolve(`data:image/png;base64,${screenshot.toString("base64")}`);

            await page.waitForURL(WECHAT_HOME_URL_RE, { timeout: WECHAT_AUTH_TIMEOUT_MS });
            const token = page.url().match(/token=([^&]+)/)?.[1];
            if (!token) throw new Error("微信登录成功后未找到 token");

            const cookie = cookieHeaderFromCookies(await browserContext.cookies());
            const mpName = await readMpName(page);
            const expiry = new Date(Date.now() + WECHAT_CREDENTIAL_TTL_MS).toISOString();
            await saveCredentialRecord({ platform: WECHAT_PLATFORM, key: "token", value: token });
            await saveCredentialRecord({ platform: WECHAT_PLATFORM, key: "cookie", value: cookie });
            await saveCredentialRecord({ platform: WECHAT_PLATFORM, key: "expiry", value: expiry });
            await saveCredentialRecord({ platform: WECHAT_PLATFORM, key: "mp_name", value: mpName });
            // 只有自己仍是当前 active 扫码时才写状态:被新扫码取代的旧调用(其 browser 已被新调用
            // close、waitForURL 抛错走 catch)不该把新调用的 authorizing 覆盖成 failed。
            if (activeAuthBrowser === authBrowser) authState.set(WECHAT_SCOPE, "ready");
          } catch (error) {
            if (activeAuthBrowser === authBrowser) authState.set(WECHAT_SCOPE, "failed");
            if (!settled) reject(error);
          } finally {
            await authBrowser?.close().catch(() => {});
            if (activeAuthBrowser === authBrowser) activeAuthBrowser = null;
          }
        })();
      });

      return { ok: true, imageDataUri, expiresInSec: WECHAT_AUTH_EXPIRES_IN_SEC };
    } finally {
      stop();
    }
  },
});

export const wechatAuthStatusTool = createTool({
  id: "wechat_auth_status",
  description: "查询微信公众号后台扫码登录凭据状态。",
  inputSchema: z.object({}),
  outputSchema: z.object({
    ok: z.boolean(),
    state: z.string(),
    mpName: z.string(),
    message: z.string(),
  }),
  execute: async () => {
    const creds = await getCredentialsForPlatform(WECHAT_PLATFORM);
    const mpName = creds.mp_name ?? "";
    if (creds.token && creds.expiry) {
      if (new Date(creds.expiry).getTime() > Date.now()) {
        return { ok: true, state: "READY", mpName, message: "已授权" };
      }
      return { ok: false, state: "EXPIRED", mpName, message: "授权已过期" };
    }
    if (authState.get(WECHAT_SCOPE) === "authorizing") {
      return { ok: false, state: "AUTHORIZING", mpName, message: "正在等待扫码授权" };
    }
    return { ok: false, state: "NO_CREDENTIAL", mpName, message: "未授权" };
  },
});

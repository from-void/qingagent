import { createTool } from "@mastra/core/tools";
import type { BrowserContext, Page } from "playwright";
import { z } from "zod";
import { getBrowser, withBrowserContextSlot } from "../browser/pool.js";
import {
  getCredentialsForPlatform,
  saveCredentialRecord,
} from "../credentials/credentialsRepo.js";
import { startToolHeartbeat } from "./toolHeartbeat.js";

const WECHAT_PLATFORM = "wechat";
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
    const stop = startToolHeartbeat(context, { tool: "wechat_auth_start" });
    try {
      authState.set(WECHAT_SCOPE, "authorizing");
      let settled = false;

      const imageDataUri = await new Promise<string>((resolve, reject) => {
        void withBrowserContextSlot(async () => {
          let browserContext: BrowserContext | null = null;
          try {
            const browser = await getBrowser();
            browserContext = await browser.newContext({
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
            authState.set(WECHAT_SCOPE, "ready");
          } catch (error) {
            authState.set(WECHAT_SCOPE, "failed");
            if (!settled) reject(error);
          } finally {
            await browserContext?.close().catch(() => {});
          }
        }).catch((error) => {
          authState.set(WECHAT_SCOPE, "failed");
          if (!settled) reject(error);
        });
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

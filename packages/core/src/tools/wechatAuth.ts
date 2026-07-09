import { createTool } from "@mastra/core/tools";
import type { Browser, Page } from "playwright";
import { z } from "zod";
import { browserLaunchCandidates } from "../browser/pool.js";
import {
  getCredentialsForPlatform,
  saveCredentialRecord,
} from "../credentials/credentialsRepo.js";
import { startToolHeartbeat } from "./toolHeartbeat.js";
import { probeWechatSearchbiz } from "./wechatSearch.js";

const WECHAT_PLATFORM = "wechat";
// **单用户桌面的单实例假设**:scope 恒 "default",authState/activeAuthBrowser 为模块级全局。
// 多会话托管时会互相干扰(互关 browser、状态串写),届时需按 session 隔离状态与 browser。
const WECHAT_SCOPE = "default";
const WECHAT_LOGIN_URL = "https://mp.weixin.qq.com/";
// 登录成功后的落地页判据:放宽到「mp.weixin.qq.com 下任意带 token= 的 URL」(home / acctclose 都认)。
// 它只用于"提取凭据",不再当成功判据——成功判据=能力验证探针(见 probeWechatSearchbiz)。
// 病根:曾死等 /cgi-bin/home,真实登录却落 /cgi-bin/acctclose?...&token=... → token 就在眼前却被当失败死等。
const WECHAT_AUTH_LANDING_RE = /^https:\/\/mp\.weixin\.qq\.com\/.*[?&]token=/;
const WECHAT_QR_SELECTOR = ".login__type__container__scan__qrcode";
const WECHAT_AUTH_TIMEOUT_MS = 240_000;
const WECHAT_AUTH_EXPIRES_IN_SEC = 240;
const WECHAT_CREDENTIAL_TTL_MS = 80 * 3600 * 1000;
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// authorizing:等扫码中;ready:已授权;failed_account_unusable:探针判定账号后台不可用;
// failed_timeout:没等到扫码确认/瞬时失败。后两者供 wechat_auth_status 给不同话术。
type AuthState =
  | "authorizing"
  | "ready"
  | "failed_account_unusable"
  | "failed_timeout";

const authState = new Map<string, AuthState>();
// 同一时刻只保留一个扫码 browser:新扫码先关旧的,防后台轮询(240s)期间 headless chromium 进程堆积拖慢新 launch。
let activeAuthBrowser: Browser | null = null;
// 幂等守卫用:当前 authorizing 期间已产出的二维码——模型一轮内重复调 start 时复用,不新开浏览器、不关旧的。
let pendingQr: { imageDataUri: string; generatedAt: number } | null = null;

// 日志脱敏:URL 里的 token=xxx 一律打成 token=***(明文 token 绝不落日志/入库)。
function redactToken(text: string): string {
  return text.replace(/([?&]token=)[^&]+/g, "$1***");
}

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

// 落地 URL 未带 token 时的兜底:带已登录 cookie 请求首页,fetch 默认跟随重定向,从最终 URL 提取 token。
async function extractTokenViaHomeRequest(cookie: string): Promise<string | null> {
  try {
    const res = await fetch(WECHAT_LOGIN_URL, {
      headers: { "User-Agent": DESKTOP_UA, Cookie: cookie, Referer: WECHAT_LOGIN_URL },
      redirect: "follow",
    });
    return res.url.match(/[?&]token=([^&]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
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
    // 幂等守卫:模型一轮内常重复调本工具(实证)。若已有进行中的授权且二维码仍在有效期,直接复用同一张码——
    // 不新开浏览器、不 close 正在等扫码的旧浏览器(否则用户扫着扫着码就失效)。
    if (authState.get(WECHAT_SCOPE) === "authorizing" && pendingQr) {
      const remainingSec =
        WECHAT_AUTH_EXPIRES_IN_SEC - Math.floor((Date.now() - pendingQr.generatedAt) / 1000);
      if (remainingSec > 5) {
        return { ok: true, imageDataUri: pendingQr.imageDataUri, expiresInSec: remainingSec };
      }
    }
    const stop = startToolHeartbeat(context, { tool: "wechat_auth_start" });
    try {
      authState.set(WECHAT_SCOPE, "authorizing");
      let settled = false;
      // 新扫码作废上一张未完成的:关掉上一个扫码 browser,防其后台轮询期间 chromium 堆积。
      await activeAuthBrowser?.close().catch(() => {});
      activeAuthBrowser = null;
      pendingQr = null;

      let authBrowser: Browser | null = null;
      const imageDataUri = await new Promise<string>((resolve, reject) => {
        void (async () => {
          // 扫码用独立 browser(见 launchStandaloneBrowser),不占共享抓取池的并发槽——
          // 否则多次扫码的后台轮询(各 240s)会把 3 个槽占满、拖垮文章抓取(实测:server 里卡死不返回)。
          try {
            authBrowser = await launchStandaloneBrowser();
            activeAuthBrowser = authBrowser;
            console.info("[wechat-auth] launch ok");
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
            const dataUri = `data:image/png;base64,${screenshot.toString("base64")}`;
            pendingQr = { imageDataUri: dataUri, generatedAt: Date.now() };
            console.info(`[wechat-auth] qr screenshot done (${screenshot.length} bytes)`);
            resolve(dataUri);

            // 扫码后主框架每次跳转记 URL(token 脱敏)——定位真实落地页,不再猜 URL 形状。
            page.on("framenavigated", (frame) => {
              if (frame === page.mainFrame()) {
                console.info(`[wechat-auth] nav -> ${redactToken(frame.url())}`);
              }
            });

            // 等登录成功落地(任意带 token= 的 mp 页,不限 /cgi-bin/home)。落地只用于取凭据,成败看探针。
            await page.waitForURL(WECHAT_AUTH_LANDING_RE, { timeout: WECHAT_AUTH_TIMEOUT_MS });
            const cookie = cookieHeaderFromCookies(await browserContext.cookies());
            let token = page.url().match(/[?&]token=([^&]+)/)?.[1] ?? null;
            // 兜底:落地 URL 无 token → 带已登录 cookie 请求首页,跟随重定向从最终 URL 提取。
            if (!token) token = await extractTokenViaHomeRequest(cookie);
            if (!token) throw new Error("微信登录成功后未找到 token");

            // 能力验证:token+cookie 真打一次 searchbiz,通过才算授权成功(不猜 acctclose 语义)。
            let probe = await probeWechatSearchbiz(token, cookie);
            if (!probe.ok && probe.kind === "transient") {
              probe = await probeWechatSearchbiz(token, cookie); // 瞬时失败重试一次
            }
            console.info(
              `[wechat-auth] probe ${probe.ok ? "ok" : `fail(${probe.kind}: ${probe.message})`}`,
            );

            // 只在自己仍是当前 active 扫码时才写状态(被新扫码取代的旧调用不该回写)。
            if (!probe.ok) {
              if (activeAuthBrowser === authBrowser) {
                authState.set(
                  WECHAT_SCOPE,
                  probe.kind === "unusable" ? "failed_account_unusable" : "failed_timeout",
                );
              }
              return; // 探针不过=不存凭据
            }

            // 探针通过 → 存凭据。token 最后写:半途中断时"有 token 必有 cookie/expiry",
            // requireWechatAuth 才不会拿半授权(有 token 无 expiry)当已授权用。
            const mpName = await readMpName(page);
            const expiry = new Date(Date.now() + WECHAT_CREDENTIAL_TTL_MS).toISOString();
            await saveCredentialRecord({ platform: WECHAT_PLATFORM, key: "cookie", value: cookie });
            await saveCredentialRecord({ platform: WECHAT_PLATFORM, key: "expiry", value: expiry });
            await saveCredentialRecord({ platform: WECHAT_PLATFORM, key: "mp_name", value: mpName });
            await saveCredentialRecord({ platform: WECHAT_PLATFORM, key: "token", value: token });
            console.info("[wechat-auth] credentials saved");
            if (activeAuthBrowser === authBrowser) authState.set(WECHAT_SCOPE, "ready");
          } catch (error) {
            // 走到这多是 waitForURL 超时(用户没扫完/没在手机点确认)→ 归 timeout 话术。
            if (activeAuthBrowser === authBrowser) authState.set(WECHAT_SCOPE, "failed_timeout");
            if (!settled) reject(error);
          } finally {
            await authBrowser?.close().catch(() => {});
            if (activeAuthBrowser === authBrowser) {
              activeAuthBrowser = null;
              pendingQr = null;
            }
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
    const st = authState.get(WECHAT_SCOPE);
    if (st === "authorizing") {
      return { ok: false, state: "AUTHORIZING", mpName, message: "正在等待扫码授权" };
    }
    if (st === "failed_account_unusable") {
      return {
        ok: false,
        state: "ACCOUNT_UNUSABLE",
        mpName,
        message: "该公众号后台不可用(可能注销中/未认证),请重扫并在手机上选另一个已认证公众号",
      };
    }
    if (st === "failed_timeout") {
      return { ok: false, state: "TIMEOUT", mpName, message: "没等到扫码确认,请重新发起授权" };
    }
    return { ok: false, state: "NO_CREDENTIAL", mpName, message: "未授权" };
  },
});

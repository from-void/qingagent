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

// authorizing:等扫码中;verifying:已扫码落地、正在验证搜索能力;ready:已授权;
// failed_account_unusable:探针判定当前公众号没有搜索能力;failed_timeout:没等到扫码确认/核验瞬时失败。
// 后两者供 wechat_auth_status 给不同话术。
type AuthState =
  | "authorizing"
  | "verifying"
  | "ready"
  | "failed_account_unusable"
  | "failed_timeout";

const authState = new Map<string, AuthState>();
// 同一时刻只保留一个扫码 browser:新扫码先关旧的,防后台轮询(240s)期间 headless chromium 进程堆积拖慢新 launch。
let activeAuthBrowser: Browser | null = null;
// 幂等守卫用:当前扫码/核验期间已产出的二维码——模型一轮内重复调 start 时复用,不新开浏览器、不关旧的。
let pendingQr: { imageDataUri: string; generatedAt: number } | null = null;
// 状态查询只在已扫码后的核验阶段短等这一个 deferred。browser 是本次授权尝试的身份，
// 新扫码替换旧 browser 后，旧尝试的结束绝不能误唤醒新尝试的状态查询。
let authVerification:
  | { browser: Browser; promise: Promise<void>; resolve: () => void }
  | null = null;
let authFailureMessage: string | null = null;

function beginAuthVerification(browser: Browser): void {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  authVerification = { browser, promise, resolve };
}

function settleAuthVerification(browser: Browser): void {
  if (authVerification?.browser !== browser) return;
  authVerification.resolve();
  authVerification = null;
}

function setAuthTerminalState(
  browser: Browser | null,
  state: Extract<AuthState, "ready" | "failed_account_unusable" | "failed_timeout">,
  message: string | null = null,
): void {
  if (!browser) {
    authState.set(WECHAT_SCOPE, state);
    authFailureMessage = message;
    return;
  }
  if (activeAuthBrowser === browser) {
    authState.set(WECHAT_SCOPE, state);
    authFailureMessage = message;
  }
  settleAuthVerification(browser);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    if (
      (authState.get(WECHAT_SCOPE) === "authorizing" ||
        authState.get(WECHAT_SCOPE) === "verifying") &&
      pendingQr
    ) {
      const remainingSec =
        WECHAT_AUTH_EXPIRES_IN_SEC - Math.floor((Date.now() - pendingQr.generatedAt) / 1000);
      if (remainingSec > 5) {
        return { ok: true, imageDataUri: pendingQr.imageDataUri, expiresInSec: remainingSec };
      }
    }
    const stop = startToolHeartbeat(context, { tool: "wechat_auth_start" });
    try {
      authState.set(WECHAT_SCOPE, "authorizing");
      authFailureMessage = null;
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
            // waitForURL 返回代表用户已在手机端完成扫码落地。必须在首个 await 前同步改态，
            // 否则紧随「我已扫码完成」发起的 status 会误读为 authorizing。
            if (activeAuthBrowser === authBrowser) {
              authState.set(WECHAT_SCOPE, "verifying");
              beginAuthVerification(authBrowser);
            }
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
              setAuthTerminalState(
                authBrowser,
                probe.kind === "capability_denied"
                  ? "failed_account_unusable"
                  : "failed_timeout",
                probe.kind === "capability_denied"
                  ? "当前所选公众号无法使用搜索能力(可能已注销或受限),请重扫并在手机上换一个正常的已认证公众号"
                  : "扫码已收到,但未能完成公众号能力核验,请稍后重新发起授权或换一个正常的公众号",
              );
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
            setAuthTerminalState(authBrowser, "ready");
          } catch (error) {
            // 走到这多是 waitForURL 超时(用户没扫完/没在手机点确认)→ 归 timeout 话术。
            setAuthTerminalState(authBrowser, "failed_timeout", "没等到扫码确认,请重新发起授权");
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
    const readStatus = async (): Promise<{
      ok: true;
      state:
        | "READY"
        | "NO_CREDENTIAL"
        | "AUTHORIZING"
        | "VERIFYING"
        | "EXPIRED"
        | "CAPABILITY_DENIED"
        | "TIMEOUT";
      mpName: string;
      message: string;
    }> => {
      const creds = await getCredentialsForPlatform(WECHAT_PLATFORM);
      const mpName = creds.mp_name ?? "";
      const st = authState.get(WECHAT_SCOPE);
      if (st === "authorizing") {
        return { ok: true, state: "AUTHORIZING", mpName, message: "正在等待扫码授权" };
      }
      if (st === "verifying") {
        return {
          ok: true,
          state: "VERIFYING",
          mpName,
          message: "扫码已收到,正在核验该公众号是否可用,请稍候再检查",
        };
      }
      if (creds.token && creds.expiry && new Date(creds.expiry).getTime() > Date.now()) {
        return { ok: true, state: "READY", mpName, message: "已授权" };
      }
      if (st === "failed_account_unusable") {
        return {
          ok: true,
          state: "CAPABILITY_DENIED",
          mpName,
          message:
            "当前所选公众号无法使用搜索能力(可能已注销或受限),请重扫并在手机上换一个正常的已认证公众号",
        };
      }
      if (st === "failed_timeout") {
        return {
          ok: true,
          state: "TIMEOUT",
          mpName,
          message: authFailureMessage ?? "没等到扫码确认,请重新发起授权",
        };
      }
      if (creds.token && creds.expiry) {
        return { ok: true, state: "EXPIRED", mpName, message: "授权已过期" };
      }
      return { ok: true, state: "NO_CREDENTIAL", mpName, message: "未授权" };
    };

    let status = await readStatus();
    // 授权落地后仅在核验阶段短等；还没扫码的 authorizing 必须立即返回，避免模型误以为 status 卡死。
    const verification = authVerification;
    if (status.state === "VERIFYING" && verification) {
      await Promise.race([verification.promise, delay(15_000)]);
      // 等待结束必须重读凭据与状态：探针可能已保存凭据，也可能刚写入终态。
      status = await readStatus();
    }
    return status;
  },
});

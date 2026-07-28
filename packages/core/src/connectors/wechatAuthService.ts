import type { Browser, Page } from "@qingagent/doc-render/browser";
import { browserLaunchCandidates } from "@qingagent/doc-render/browser";
import {
  saveConnectorCredentialBundle,
} from "../credentials/credentialsRepo.js";
import { PendingStore, PendingStoreError } from "./pendingStore.js";
import {
  readWechatCredentialBundle,
  type WechatCredentialPayload,
} from "./wechatCredentials.js";
import { probeWechatSearchbiz } from "../tools/wechatSearch.js";

// 微信 bundle 本身是单用户全局凭据，因此并发会话共享同一个授权 scope：重复/并发 start
// 必须单飞复用同一 pending；每次尝试的 browser/二维码/deferred 则封装在该 pendingId 的 value 内。
const WECHAT_SCOPE = "default";
const WECHAT_LOGIN_URL = "https://mp.weixin.qq.com/";
const WECHAT_AUTH_LANDING_RE = /^https:\/\/mp\.weixin\.qq\.com\/.*[?&]token=/;
// 登录成功后的落地页判据:放宽到「mp.weixin.qq.com 下任意带 token= 的 URL」(home / acctclose 都认)。
// 它只用于"提取凭据",不再当成功判据——成功判据=能力验证探针(见 probeWechatSearchbiz)。
// 病根:曾死等 /cgi-bin/home,真实登录却落 /cgi-bin/acctclose?...&token=... → token 就在眼前却被当失败死等。
const WECHAT_QR_SELECTOR = ".login__type__container__scan__qrcode";
const WECHAT_AUTH_TIMEOUT_MS = 240_000;
const WECHAT_HOME_REQUEST_TIMEOUT_MS = 10_000;
const WECHAT_AUTH_EXPIRES_IN_SEC = 240;
const WECHAT_CREDENTIAL_TTL_MS = 80 * 3600 * 1000;
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// authorizing:等扫码中;verifying:已扫码落地、正在验证搜索能力;ready:已授权;
// failed_account_unusable:探针判定当前公众号没有搜索能力；failed_timeout:仅表示用户扫码落地超时；
// failed_error:二维码交付后的其余中性故障。三者供 wechat_auth_status 给不同话术。
export type WechatAuthState =
  | "authorizing"
  | "verifying"
  | "ready"
  | "failed_account_unusable"
  | "failed_timeout"
  | "failed_error";

interface WechatPendingAuth {
  state: WechatAuthState;
  browser: Browser | null;
  imageDataUri: string | null;
  verification: { promise: Promise<void>; resolve: () => void } | null;
  failureMessage: string | null;
  imageReady: Promise<string>;
  resolveImage: (value: string) => void;
  rejectImage: (error: unknown) => void;
  task: Promise<void>;
  /** 登录页扫码区文本已变化(=手机扫到了码,等手机端确认)。给前端「已扫到」反馈用。 */
  scanned: boolean;
}

export interface WechatAuthStartResult {
  ok: true;
  imageDataUri: string;
  expiresInSec: number;
  expiresAt: number;
  connectorId: "wechat-mp";
  pendingId: string;
  reused: boolean;
}

const pendingStore = new PendingStore<WechatPendingAuth>({ ttlMs: WECHAT_AUTH_TIMEOUT_MS });
pendingStore.attachProcessCleanup();

function remainingAuthMs(expiresAt: number): number {
  return Math.max(1, expiresAt - Date.now());
}

function isWechatCredentialPayload(value: unknown): value is WechatCredentialPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  if (
    payload.strategy !== "qr-session"
    || payload.version !== 1
    || typeof payload.account !== "string"
    || typeof payload.cookie !== "string"
    || typeof payload.token !== "string"
    || typeof payload.expiry !== "string"
  ) {
    return false;
  }
  if (payload.sessionIssue === undefined) return true;
  if (!payload.sessionIssue || typeof payload.sessionIssue !== "object") return false;
  const issue = payload.sessionIssue as Record<string, unknown>;
  return issue.reasonCode === "needs_reauth" && typeof issue.lastCheckedAt === "string";
}

function beginAuthVerification(pending: WechatPendingAuth): void {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  pending.verification = { promise, resolve };
}

function settleAuthVerification(pending: WechatPendingAuth): void {
  pending.verification?.resolve();
  pending.verification = null;
}

function setAuthTerminalState(
  pending: WechatPendingAuth,
  state: Extract<
    WechatAuthState,
    "ready" | "failed_account_unusable" | "failed_timeout" | "failed_error"
  >,
  message: string | null = null,
): void {
  pending.state = state;
  pending.failureMessage = message;
  settleAuthVerification(pending);
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

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
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
async function extractTokenViaHomeRequest(cookie: string, signal: AbortSignal): Promise<string | null> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  if (signal.aborted) forwardAbort();
  else signal.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException("微信首页兜底请求超时", "TimeoutError")),
    WECHAT_HOME_REQUEST_TIMEOUT_MS,
  );
  timer.unref?.();
  try {
    const res = await fetch(WECHAT_LOGIN_URL, {
      headers: { "User-Agent": DESKTOP_UA, Cookie: cookie, Referer: WECHAT_LOGIN_URL },
      redirect: "follow",
      signal: controller.signal,
    });
    return res.url.match(/[?&]token=([^&]+)/)?.[1] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", forwardAbort);
  }
}

export class WechatAuthService {
  async start(): Promise<WechatAuthStartResult> {
    if (process.env.WECHAT_AUTH_EVAL_NOOP === "1") {
      const expiresAt = Date.now() + WECHAT_AUTH_TIMEOUT_MS;
      return { ok: true, imageDataUri: "data:image/png;base64,ZVZBTA==", expiresInSec: WECHAT_AUTH_EXPIRES_IN_SEC, expiresAt, connectorId: "wechat-mp", pendingId: "eval-pending", reused: false };
    }
    const current = pendingStore.current("wechat-mp", WECHAT_SCOPE);
    if (current && current.value.state !== "authorizing" && current.value.state !== "verifying") {
      pendingStore.disconnect("wechat-mp", WECHAT_SCOPE);
    }
    const started = pendingStore.start({
      connectorId: "wechat-mp",
      scope: WECHAT_SCOPE,
      create: ({ pendingId, signal }) => {
        let resolveImage!: (value: string) => void;
        let rejectImage!: (error: unknown) => void;
        const imageReady = new Promise<string>((resolve, reject) => { resolveImage = resolve; rejectImage = reject; });
        const pending: WechatPendingAuth = {
          state: "authorizing", browser: null, imageDataUri: null,
          verification: null, failureMessage: null, imageReady, resolveImage, rejectImage,
          task: Promise.resolve(),
          scanned: false,
        };
        pending.task = this.runAuth(pending, pendingId, signal);
        return pending;
      },
    });
    const pending = started.entry.value;
    const imageDataUri = pending.imageDataUri ?? await pending.imageReady;
    const expiresAt = pendingStore.get(
      started.entry.pendingId,
      "wechat-mp",
      WECHAT_SCOPE,
    ).expiresAt;
    const remainingSec = Math.max(1, Math.ceil(remainingAuthMs(expiresAt) / 1000));
    return { ok: true, imageDataUri, expiresInSec: remainingSec, expiresAt, connectorId: "wechat-mp", pendingId: started.entry.pendingId, reused: started.reused };
  }

  private async runAuth(
    pending: WechatPendingAuth,
    pendingId: string,
    signal: AbortSignal,
  ): Promise<void> {
      let imageSettled = false;
      let authBrowser: Browser | null = null;
      const abort = () => { void authBrowser?.close().catch(() => {}); };
      signal.addEventListener("abort", abort, { once: true });
      // 扫码用独立 browser(见 launchStandaloneBrowser),不占共享抓取池的并发槽——
          // 否则多次扫码的后台轮询(各 240s)会把 3 个槽占满、拖垮文章抓取(实测:server 里卡死不返回)。
      try {
            authBrowser = await launchStandaloneBrowser();
            pending.browser = authBrowser;
            console.info("[wechat-auth] launch ok");
            const browserContext = await authBrowser.newContext({
              userAgent: DESKTOP_UA,
              locale: "zh-CN",
            });
            await browserContext.addInitScript(applyStealthInitScript);
            const page = await browserContext.newPage();
            page.on("framenavigated", (frame) => {
              if (frame === page.mainFrame()) {
                console.info(`[wechat-auth] nav -> ${redactToken(frame.url())}`);
              }
            });
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
            const expiresAt = pendingStore.renew(
              pendingId,
              "wechat-mp",
              WECHAT_SCOPE,
            ).expiresAt;
            imageSettled = true;
            const dataUri = `data:image/png;base64,${screenshot.toString("base64")}`;
            pending.imageDataUri = dataUri;
            console.info(`[wechat-auth] qr screenshot done (${screenshot.length} bytes)`);
            pending.resolveImage(dataUri);

            // 并行监听扫码信号:登录页扫码区文本一变(实测初始恒为「微信扫一扫,选择公众平台账号登录」,
            // 扫到后微信页面切「请在手机上确认」态)即置 scanned,给前端「已扫到」反馈。
            // 只是增强信号:任何失败(页面落地导航销毁上下文/测试桩没有这些方法)都不阻断授权主流程。
            try {
              const initialScanText = await page
                .evaluate((sel) => document.querySelector(sel)?.parentElement?.textContent?.trim() ?? "", WECHAT_QR_SELECTOR)
                .catch(() => "");
              void page
                .waitForFunction(
                  ({ sel, initial }) => {
                    const text = document.querySelector(sel)?.parentElement?.textContent?.trim() ?? "";
                    return text !== initial;
                  },
                  { sel: WECHAT_QR_SELECTOR, initial: initialScanText },
                  { timeout: remainingAuthMs(expiresAt) },
                )
                .then(() => { pending.scanned = true; })
                .catch(() => {});
            } catch { /* 扫码信号获取失败不影响授权 */ }
            // 等登录成功落地(任意带 token= 的 mp 页,不限 /cgi-bin/home)。落地只用于取凭据,成败看探针。
            try {
              await page.waitForURL(WECHAT_AUTH_LANDING_RE, {
                timeout: remainingAuthMs(expiresAt),
              });
            } catch (error) {
              if (signal.aborted) return;
              if (isTimeoutError(error)) {
                setAuthTerminalState(
                  pending,
                  "failed_timeout",
                  "没等到扫码确认,请重新发起授权",
                );
              } else {
                setAuthTerminalState(
                  pending,
                  "failed_error",
                  "授权未能完成,请重新发起授权",
                );
              }
              return;
            }
            pending.scanned = true;
            // waitForURL 返回代表用户已在手机端完成扫码落地。必须在首个 await 前同步改态，
            // 否则紧随「我已扫码完成」发起的 status 会误读为 authorizing。
            if (signal.aborted) return;
            pending.state = "verifying";
            beginAuthVerification(pending);
            const cookie = cookieHeaderFromCookies(await browserContext.cookies());
            let token = page.url().match(/[?&]token=([^&]+)/)?.[1] ?? null;
            // 兜底:落地 URL 无 token → 带已登录 cookie 请求首页,跟随重定向从最终 URL 提取。
            if (!token) token = await extractTokenViaHomeRequest(cookie, signal);
            if (!token) throw new Error("微信登录成功后未找到 token");

            // 能力验证:token+cookie 真打一次 searchbiz,通过才算授权成功(不猜 acctclose 语义)。
            let probe = await probeWechatSearchbiz(token, cookie, signal);
            if (!probe.ok && probe.kind === "transient") {
              probe = await probeWechatSearchbiz(token, cookie, signal); // 瞬时失败重试一次
            }
            console.info(
              `[wechat-auth] probe ${probe.ok ? "ok" : `fail(${probe.kind}: ${probe.message})`}`,
            );

            // 只在自己仍是当前 active 扫码时才写状态(被新扫码取代的旧调用不该回写)。
            if (!probe.ok) {
              setAuthTerminalState(
                pending,
                probe.kind === "capability_denied"
                  ? "failed_account_unusable"
                  : "failed_error",
                probe.kind === "capability_denied"
                  ? "当前所选公众号无法使用搜索能力(可能已注销或受限),请重扫并在手机上换一个正常的已认证公众号"
                  : "扫码已收到,但未能完成公众号能力核验,请稍后重新发起授权或换一个正常的公众号",
              );
              return; // 探针不过=不存凭据
            }

            // 探针通过 → 存凭据。token 最后写:半途中断时"有 token 必有 cookie/expiry",
            // requireWechatAuth 才不会拿半授权(有 token 无 expiry)当已授权用。
            const mpName = await readMpName(page);
            // disconnect/过期可能发生在慢探针或 DOM 读取期间；迟到尝试绝不能重新落凭据。
            if (signal.aborted) return;
            const expiry = new Date(Date.now() + WECHAT_CREDENTIAL_TTL_MS).toISOString();
            await saveConnectorCredentialBundle("wechat-mp", {
              strategy: "qr-session" as const,
              version: 1 as const,
              account: mpName,
              cookie,
              token,
              expiry,
            }, { writeGuard: () => !signal.aborted });
            console.info("[wechat-auth] credentials saved");
            setAuthTerminalState(pending, "ready");
          } catch (error) {
            if (!imageSettled) {
              // 二维码尚未生成时属于浏览器/页面加载故障，不得伪装成用户扫码超时。
              // 立即移除 pending，既允许下一次 start 新建授权，也避免 status 在 TTL 内误报 TIMEOUT。
              pendingStore.disconnect("wechat-mp", WECHAT_SCOPE);
              pending.rejectImage(new Error("授权页面加载失败，请稍后重试"));
            } else if (!signal.aborted) {
              // waitForURL 的 TimeoutError 已在本阶段内单独处理；其余二维码后故障
              // 只能进入中性非超时终态，绝不能把 cookie/token/探针/落库失败冒充用户未扫码。
              setAuthTerminalState(pending, "failed_error", "授权未能完成,请重新发起授权");
            }
          } finally {
            await authBrowser?.close().catch(() => {});
            pending.browser = null;
            signal.removeEventListener("abort", abort);
      }
  }

  async status(pendingId?: string) {
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
      /** 仅 AUTHORIZING/VERIFYING 有意义:手机已扫到二维码(等确认或核验中)。 */
      scanned?: boolean;
      mpName: string;
      message: string;
    }> => {
      let credentialCorrupt = false;
      const candidate = await readWechatCredentialBundle().catch(() => {
        credentialCorrupt = true;
        return null;
      });
      const bundle = candidate && isWechatCredentialPayload(
        (candidate as { payload?: unknown }).payload,
      )
        ? candidate
        : null;
      if (candidate && !bundle) credentialCorrupt = true;
      const mpName = bundle?.payload.account ?? "";
      let pending: WechatPendingAuth | null = null;
      if (pendingId) pending = pendingStore.get(pendingId, "wechat-mp", WECHAT_SCOPE).value;
      else pending = pendingStore.current("wechat-mp", WECHAT_SCOPE)?.value ?? null;
      const st = pending?.state;
      if (st === "authorizing") {
        return pending?.scanned
          ? { ok: true, state: "AUTHORIZING", scanned: true, mpName, message: "已扫到二维码,请在手机上确认登录" }
          : { ok: true, state: "AUTHORIZING", scanned: false, mpName, message: "正在等待扫码授权" };
      }
      if (st === "verifying") {
        return {
          ok: true,
          state: "VERIFYING",
          scanned: true,
          mpName,
          message: "扫码已收到,正在核验该公众号是否可用,请稍候再检查",
        };
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
          message: pending?.failureMessage ?? "没等到扫码确认,请重新发起授权",
        };
      }
      if (st === "failed_error") {
        return {
          ok: true,
          state: "NO_CREDENTIAL",
          mpName,
          message: pending?.failureMessage ?? "授权未能完成,请重新发起授权",
        };
      }
      if (bundle?.payload.sessionIssue?.reasonCode === "needs_reauth") {
        return {
          ok: true,
          state: "EXPIRED",
          mpName,
          message: "微信登录态已失效,请重新扫码登录",
        };
      }
      if (bundle && new Date(bundle.payload.expiry).getTime() > Date.now()) {
        return { ok: true, state: "READY", mpName, message: "已授权" };
      }
      if (bundle) {
        return { ok: true, state: "EXPIRED", mpName, message: "授权已过期" };
      }
      if (credentialCorrupt) {
        return {
          ok: true,
          state: "NO_CREDENTIAL",
          mpName,
          message: "授权信息已损坏，请重新扫码登录",
        };
      }
      return { ok: true, state: "NO_CREDENTIAL", mpName, message: "未授权" };
    };

    let status = await readStatus();
    // 授权落地后仅在核验阶段短等；还没扫码的 authorizing 必须立即返回，避免模型误以为 status 卡死。
    let verification: WechatPendingAuth["verification"] = null;
    if (pendingId) verification = pendingStore.get(pendingId, "wechat-mp", WECHAT_SCOPE).value.verification;
    else verification = pendingStore.current("wechat-mp", WECHAT_SCOPE)?.value.verification ?? null;
    if (status.state === "VERIFYING" && verification) {
      await Promise.race([verification.promise, delay(15_000)]);
      // 等待结束必须重读凭据与状态：探针可能已保存凭据，也可能刚写入终态。
      status = await readStatus();
    }
    return status;
  }

  disconnectPending(): void {
    pendingStore.disconnect("wechat-mp", WECHAT_SCOPE);
  }

  resetForTests(): void { this.disconnectPending(); }
}

export const wechatAuthService = new WechatAuthService();

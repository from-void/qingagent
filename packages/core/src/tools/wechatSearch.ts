import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { markWechatSessionNeedsReauth, readWechatCredentialBundle } from "../connectors/wechatCredentials.js";
import { startToolHeartbeat } from "./toolHeartbeat.js";

// 路径B:用扫码登录拿到的 token+cookie,调微信公众平台后台内部接口搜号/列文。
// 接口形状来自 P0 预研(we-mp-rss 实证):searchbiz 搜号、appmsgpublish 列文。
const WECHAT_PLATFORM = "wechat";
const WECHAT_CGI_BASE = "https://mp.weixin.qq.com/cgi-bin";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
// 限速:防触发微信风控(we-mp-rss 号间默认 ~60s;这里单次交互式抓取,取每请求 ≥1.2s 间隔)。
const REQUEST_MIN_INTERVAL_MS = 1200;
let lastRequestAt = 0;

// 微信后台风控/失效的 base_resp.ret 语义(实证常见值)。
const RET_OK = 0;
const RET_SESSION_INVALID = new Set([-6, 200003, 200002]); // 登录态失效/需重新登录
const RET_RATE_LIMITED = new Set([200013, 200040]); // 频控/操作过于频繁
const ACCESS_DENIED = new Set([200007]); // 当前所选公众号没有搜索能力
const DEFAULT_CGI_TIMEOUT_MS = 15_000;
const WECHAT_AUTH_PROBE_TIMEOUT_MS = 6_000;

interface AuthOk {
  ok: true;
  token: string;
  cookie: string;
  revision: number;
}
interface AuthErr {
  ok: false;
  state: "NO_CREDENTIAL" | "EXPIRED";
  error: string;
}

/** 读登录态凭据;缺失或过期时返回可识别错误,交由 SKILL 引导重新扫码。 */
async function requireWechatAuth(): Promise<AuthOk | AuthErr> {
  const bundle = await readWechatCredentialBundle().catch(() => null);
  const creds = bundle?.payload;
  // 与 wechat_auth_status 判据对齐:token 与 expiry 都要有。缺 expiry=半授权(凭据非原子写、中途断),
  // 若放行会被当"永不过期"照用,和 status 说"未授权"矛盾——统一视为未授权。
  if (!creds?.token || !creds.expiry) {
    return { ok: false, state: "NO_CREDENTIAL", error: "尚未扫码登录微信公众号后台" };
  }
  if (new Date(creds.expiry).getTime() <= Date.now()) {
    return { ok: false, state: "EXPIRED", error: "微信登录态本地最多保留约 80 小时，微信可能提前要求重新登录，需重新扫码" };
  }
  return { ok: true, token: creds.token, cookie: creds.cookie ?? "", revision: bundle!.revision };
}

function normalizeWechatBusinessError(error: unknown, revision: number): { state: string; error: string } {
  if (error instanceof WechatCgiError) {
    if (error.kind === "SESSION") {
      markWechatSessionNeedsReauth(revision);
      return { state: "needs_reauth", error: error.message };
    }
    if (error.kind === "RATE_LIMIT") return { state: "rate_limit", error: error.message };
    if (error.kind === "ACCESS_DENIED") return { state: "ACCESS_DENIED", error: error.message };
    return { state: "transient", error: error.message };
  }
  return { state: "transient", error: error instanceof Error ? error.message : String(error) };
}

// 串行化:并发调用排队,防 read-then-write 竞态(两并发都算出 wait≈0 同时发,限速形同虚设)。
// 注:lastRequestAt/rateLimitChain 为模块级——**单用户桌面的单实例假设**;多会话托管需按 session 隔离。
let rateLimitChain: Promise<void> = Promise.resolve();
async function rateLimit(): Promise<void> {
  const prev = rateLimitChain;
  let release!: () => void;
  rateLimitChain = new Promise<void>((r) => (release = r));
  try {
    await prev;
    const wait = REQUEST_MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
  } finally {
    release();
  }
}

/** 带登录态请求后台 cgi 接口,返回解析后的 JSON。 */
async function wechatCgiGet(
  path: string,
  params: Record<string, string>,
  cookie: string,
  timeoutMs = DEFAULT_CGI_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  await rateLimit();
  const url = `${WECHAT_CGI_BASE}/${path}?${new URLSearchParams(params).toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": DESKTOP_UA,
        Referer: "https://mp.weixin.qq.com/",
        Cookie: cookie,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (res.status === 429) {
      throw new WechatCgiError("RATE_LIMIT", "微信临时限制了访问,请过一阵再试");
    }
    if (res.status >= 500 && res.status <= 599) {
      throw new WechatCgiError("TRANSIENT", `微信服务暂时不可用(HTTP ${res.status}),请稍后再试`);
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // 非 JSON 多见于验证页/风控页,不能据此断言账号不可用；按瞬时问题允许一次重试。
      throw new WechatCgiError("TRANSIENT", "微信返回了非预期内容,可能触发临时验证或风控,请稍后再试");
    }
  } finally {
    clearTimeout(timeout);
  }
}

class WechatCgiError extends Error {
  constructor(
    public kind: "SESSION" | "RATE_LIMIT" | "ACCESS_DENIED" | "TRANSIENT" | "UNKNOWN",
    message: string,
  ) {
    super(message);
  }
}

/** 校验 base_resp.ret,把风控/失效翻译成可识别错误。 */
function assertBaseResp(data: Record<string, unknown>): void {
  const baseResp = data.base_resp as { ret?: number; err_msg?: string } | undefined;
  const ret = baseResp?.ret;
  if (ret === RET_OK) return;
  if (ret === undefined) {
    // 无 base_resp:只有确实带了数据(list/publish_page)才算正常;否则是畸形/被重定向到验证页的响应,
    // 这是畸形 JSON 响应,不能据此断言登录态或公众号能力失效。
    if (Array.isArray(data.list) || typeof data.publish_page === "string") return;
    throw new WechatCgiError("UNKNOWN", "微信返回了无法识别的响应(无 base_resp 也无数据)");
  }
  if (RET_SESSION_INVALID.has(ret)) {
    throw new WechatCgiError("SESSION", "微信登录态已失效,请重新扫码登录");
  }
  if (RET_RATE_LIMITED.has(ret)) {
    throw new WechatCgiError("RATE_LIMIT", "操作过于频繁,已被微信临时限制,请过一阵再试");
  }
  if (ACCESS_DENIED.has(ret)) {
    throw new WechatCgiError("ACCESS_DENIED", "当前所选公众号无法使用搜索能力");
  }
  throw new WechatCgiError("UNKNOWN", `微信接口返回错误(ret=${ret}${baseResp?.err_msg ? ", " + baseResp.err_msg : ""})`);
}

/**
 * 授权探针:用刚拿到的 token+cookie 打一次 searchbiz(良性 query),验证凭据是否真能用。
 * 复用 wechatCgiGet(含 rateLimit)+ assertBaseResp,不另造请求路径。授权成功判据 = 本探针通过,
 * 而非落地页 URL 形状(URL 形状判断脆,曾死等 /cgi-bin/home 把成功当失败)。
 * - ok:true          → 凭据可用(账号良性,可搜号)
 * - kind:"capability_denied" → 当前所选公众号没有搜索能力 → 不存凭据,引导换号
 * - kind:"reauth"            → 登录态已失效 → 重新扫码
 * - kind:"transient"         → 频控、服务端、网络或风控页等瞬时失败 → 调用方可重试一次
 * - kind:"unknown"           → 微信返回未知业务错误 → 保守引导重试/换号,不误判账号不可用
 */
export type WechatAuthProbeResult =
  | { ok: true }
  | {
      ok: false;
      kind: "capability_denied" | "reauth" | "rate_limit" | "transient" | "unknown";
      message: string;
    };

export async function probeWechatSearchbiz(
  token: string,
  cookie: string,
): Promise<WechatAuthProbeResult> {
  try {
    const data = await wechatCgiGet(
      "searchbiz",
      {
        action: "search_biz",
        begin: "0",
        count: "1",
        query: "人民日报",
        token,
        lang: "zh_CN",
        f: "json",
        ajax: "1",
      },
      cookie,
      WECHAT_AUTH_PROBE_TIMEOUT_MS,
    );
    assertBaseResp(data);
    return { ok: true };
  } catch (error) {
    if (error instanceof WechatCgiError) {
      const kind =
        error.kind === "ACCESS_DENIED"
          ? "capability_denied"
          : error.kind === "SESSION"
            ? "reauth"
            : error.kind === "RATE_LIMIT"
              ? "rate_limit"
              : error.kind === "TRANSIENT"
                ? "transient"
              : "unknown";
      return { ok: false, kind, message: error.message };
    }
    // fetch 网络异常=瞬时。
    return { ok: false, kind: "transient", message: error instanceof Error ? error.message : String(error) };
  }
}

export const wechatSearchMpTool = createTool({
  id: "wechat_search_mp",
  description:
    "按公众号名/关键词搜索微信公众号(需已扫码登录)。返回候选公众号列表(名称/简介/头像/fakeid)。" +
    "拿到 fakeid 后用 wechat_list_articles 列该号文章。搜到多个同名号时须让用户确认选哪个。",
  inputSchema: z.object({
    query: z.string().min(1).describe("公众号名称或关键词"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    state: z.string(),
    accounts: z.array(
      z.object({
        nickname: z.string(),
        fakeid: z.string(),
        alias: z.string(),
        avatar: z.string(),
        signature: z.string(),
      }),
    ),
    error: z.string().nullable(),
  }),
  execute: async (input, context) => {
    const stop = startToolHeartbeat(context, { tool: "wechat_search_mp" });
    let credentialRevision = 0;
    try {
      const auth = await requireWechatAuth();
      if (!auth.ok) {
        return { ok: false, state: auth.state, accounts: [], error: auth.error };
      }
      credentialRevision = auth.revision;
      const data = await wechatCgiGet(
        "searchbiz",
        {
          action: "search_biz",
          begin: "0",
          count: "5",
          query: input.query,
          token: auth.token,
          lang: "zh_CN",
          f: "json",
          ajax: "1",
        },
        auth.cookie,
      );
      assertBaseResp(data);
      const list = Array.isArray(data.list) ? (data.list as Array<Record<string, unknown>>) : [];
      const accounts = list.map((item) => ({
        nickname: String(item.nickname ?? ""),
        fakeid: String(item.fakeid ?? ""),
        alias: String(item.alias ?? ""),
        avatar: String(item.round_head_img ?? ""),
        signature: String(item.signature ?? ""),
      }));
      return { ok: true, state: "READY", accounts, error: null };
    } catch (error) {
      const normalized = normalizeWechatBusinessError(error, credentialRevision);
      return {
        ok: false,
        state: normalized.state,
        accounts: [],
        error: normalized.error,
      };
    } finally {
      stop();
    }
  },
});

/** 解析 appmsgpublish 的多层嵌套(publish_page → publish_list[].publish_info → appmsgex[])。 */
function parsePublishedArticles(publishPageRaw: unknown): Array<{
  title: string;
  link: string;
  cover: string;
  updateTime: number;
}> {
  if (typeof publishPageRaw !== "string" || !publishPageRaw) return [];
  let page: Record<string, unknown>;
  try {
    page = JSON.parse(publishPageRaw) as Record<string, unknown>;
  } catch {
    return [];
  }
  const publishList = Array.isArray(page.publish_list)
    ? (page.publish_list as Array<Record<string, unknown>>)
    : [];
  const out: Array<{ title: string; link: string; cover: string; updateTime: number }> = [];
  for (const entry of publishList) {
    const infoRaw = entry.publish_info;
    if (typeof infoRaw !== "string") continue;
    let info: Record<string, unknown>;
    try {
      info = JSON.parse(infoRaw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const appmsgex = Array.isArray(info.appmsgex)
      ? (info.appmsgex as Array<Record<string, unknown>>)
      : [];
    for (const art of appmsgex) {
      out.push({
        title: String(art.title ?? ""),
        link: String(art.link ?? ""),
        cover: String(art.cover ?? ""),
        updateTime: Number(art.update_time ?? 0),
      });
    }
  }
  return out;
}

export const wechatListArticlesTool = createTool({
  id: "wechat_list_articles",
  description:
    "列出指定公众号(fakeid,来自 wechat_search_mp)已发布的文章(需已扫码登录)。返回标题/链接/封面/发布时间。" +
    "拿到文章 link 后用 fetchArticle 抓正文(link 是 mp.weixin.qq.com/s 链接,走微信专用清洗)。默认取最近 5 篇。",
  inputSchema: z.object({
    fakeid: z.string().min(1).describe("公众号 fakeid(来自 wechat_search_mp 的结果)"),
    count: z.number().min(1).max(20).optional().describe("取多少篇,默认 5,上限 20"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    state: z.string(),
    articles: z.array(
      z.object({
        title: z.string(),
        link: z.string(),
        cover: z.string(),
        updateTime: z.number(),
      }),
    ),
    error: z.string().nullable(),
  }),
  execute: async (input, context) => {
    const stop = startToolHeartbeat(context, { tool: "wechat_list_articles" });
    let credentialRevision = 0;
    try {
      const auth = await requireWechatAuth();
      if (!auth.ok) {
        return { ok: false, state: auth.state, articles: [], error: auth.error };
      }
      credentialRevision = auth.revision;
      const count = Math.min(input.count ?? 5, 20);
      const data = await wechatCgiGet(
        "appmsgpublish",
        {
          sub: "list",
          sub_action: "list_ex",
          begin: "0",
          count: String(count),
          fakeid: input.fakeid,
          token: auth.token,
          lang: "zh_CN",
          f: "json",
          ajax: "1",
        },
        auth.cookie,
      );
      assertBaseResp(data);
      // 注:appmsgpublish 的 count 是"群发条数",每条群发可含多篇文章;这里 flatten 所有文章后再按
      // "文章数"截到 count 篇——所以实际请求的群发条数=count,拿到的文章数≈count(可能略多/少),要精确需翻页。
      const articles = parsePublishedArticles(data.publish_page).slice(0, count);
      return { ok: true, state: "READY", articles, error: null };
    } catch (error) {
      const normalized = normalizeWechatBusinessError(error, credentialRevision);
      return {
        ok: false,
        state: normalized.state,
        articles: [],
        error: normalized.error,
      };
    } finally {
      stop();
    }
  },
});

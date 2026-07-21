/**
 * qrContentResolver —— show_qr 出码前的确定性验真。
 *
 * 背景:授权类 CLI 打印的文字链接常是"桌面出码展示页"(打开又是一张二维码),真正扫码
 * 直达的授权 URL 只嵌在页面里(如企微 gen 页的 window.settings.auth_url)。让模型自己
 * curl 验真已实证不可靠(提示词明令禁止后仍会只探状态码),故在 qrCard 渲染前由产品
 * 代码兜底:拉 content URL 的正文,发现内嵌真实授权 URL 就自动替换。
 *
 * 字段名单刻意收窄到"本页二维码编码的目标"语义(auth_url/qr_url/scan_url 系),
 * 不收 redirect_uri/login_url——它们在正经 OAuth 授权页里太常见,替换会误伤直达链接。
 * 任何失败(超时/非文本/无匹配)一律放行原 URL,只替换、不拦截。
 */

const EMBED_FIELD_RE =
  /(?:auth_url|authUrl|qr_url|qrUrl|qrcode_url|qrcodeUrl|qrCodeUrl|scan_url|scanUrl)["']?\s*[:=]\s*["'](https:\/\/[^"'\s]+)["']/i;

const FETCH_TIMEOUT_MS = 4_000;
const MAX_BODY_BYTES = 512 * 1024;

/** 从页面正文提取内嵌授权 URL;没有(或不合法)返回 null。纯函数,可单测。 */
export function extractEmbeddedAuthUrl(pageText: string): string | null {
  // JSON 转义的 \/ 先还原,统一匹配
  const normalized = pageText.replace(/\\\//g, "/");
  const match = EMBED_FIELD_RE.exec(normalized);
  if (!match?.[1]) return null;
  const url = match[1].replace(/\\u0026/gi, "&").replace(/&amp;/g, "&");
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return url;
}

/**
 * 若 content 是 http(s) 链接且其页面内嵌真实授权 URL,返回该 URL;否则返回 null(用原值)。
 * 网络失败/超时/超限一律 null——验真只做增强,绝不把卡片渲染搞挂。
 */
export async function resolveQrContent(
  content: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (typeof content !== "string" || !/^https?:\/\//i.test(content)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(content, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/text\/html|application\/json|text\/plain/i.test(type)) return null;
    if (!res.body) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    while (bytes < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    void reader.cancel().catch(() => {});
    const embedded = extractEmbeddedAuthUrl(text);
    if (!embedded || embedded === content) return null;
    return embedded;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

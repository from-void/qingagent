import { describe, expect, it } from "vitest";
import { extractEmbeddedAuthUrl, resolveQrContent } from "../qrContentResolver.js";

// 企微 gen 展示页真实结构(window.settings 内嵌 auth_url)——260719 真机套娃事故的回归锚点
const WECOM_GEN_PAGE = `<!DOCTYPE html><html><body><script>window.settings = {"NODE_ENV":"production","scode":"F9xZGFBuaHuTNiX_","auth_url":"https://work.weixin.qq.com/ai/qc/c?s=F9xZGFBuaHuTNiX_&hide_more_btn=true&for_native=true","expired":true}</script></body></html>`;

describe("extractEmbeddedAuthUrl", () => {
  it("从企微 gen 展示页提取内嵌 auth_url", () => {
    expect(extractEmbeddedAuthUrl(WECOM_GEN_PAGE)).toBe(
      "https://work.weixin.qq.com/ai/qc/c?s=F9xZGFBuaHuTNiX_&hide_more_btn=true&for_native=true",
    );
  });

  it("还原 JSON 转义斜杠与 \\u0026/&amp;", () => {
    const page = `{"auth_url":"https:\\/\\/example.com\\/auth?a=1\\u0026b=2"}`;
    expect(extractEmbeddedAuthUrl(page)).toBe("https://example.com/auth?a=1&b=2");
    const htmlEscaped = `qr_url = 'https://example.com/auth?a=1&amp;b=2'`;
    expect(extractEmbeddedAuthUrl(htmlEscaped)).toBe("https://example.com/auth?a=1&b=2");
  });

  it("不认 redirect_uri/login_url 等常见 OAuth 字段(防误伤直达授权页)", () => {
    expect(
      extractEmbeddedAuthUrl(`{"redirect_uri":"https://evil.example/cb","login_url":"https://x.example/login"}`),
    ).toBeNull();
  });

  it("非 https 或不合法 URL 不提取", () => {
    expect(extractEmbeddedAuthUrl(`{"auth_url":"http://insecure.example/a"}`)).toBeNull();
    expect(extractEmbeddedAuthUrl(`{"auth_url":"https://"}`)).toBeNull();
    expect(extractEmbeddedAuthUrl("plain text without fields")).toBeNull();
  });
});

function fakeFetch(body: string, init?: { status?: number; contentType?: string }): typeof fetch {
  return (async () =>
    new Response(body, {
      status: init?.status ?? 200,
      headers: { "content-type": init?.contentType ?? "text/html; charset=utf-8" },
    })) as unknown as typeof fetch;
}

describe("resolveQrContent", () => {
  it("展示页链接被替换为内嵌授权 URL", async () => {
    const resolved = await resolveQrContent(
      "https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=F9xZGFBuaHuTNiX_",
      fakeFetch(WECOM_GEN_PAGE),
    );
    expect(resolved).toBe(
      "https://work.weixin.qq.com/ai/qc/c?s=F9xZGFBuaHuTNiX_&hide_more_btn=true&for_native=true",
    );
  });

  it("直达授权页(无内嵌字段)放行原 URL", async () => {
    expect(
      await resolveQrContent("https://example.com/auth", fakeFetch("<html>请点击授权</html>")),
    ).toBeNull();
  });

  it("非 URL content / 非文本响应 / 非 2xx / fetch 抛错一律放行", async () => {
    expect(await resolveQrContent("ABCD-1234", fakeFetch(WECOM_GEN_PAGE))).toBeNull();
    expect(
      await resolveQrContent("https://example.com/x", fakeFetch(WECOM_GEN_PAGE, { contentType: "image/png" })),
    ).toBeNull();
    expect(
      await resolveQrContent("https://example.com/x", fakeFetch(WECOM_GEN_PAGE, { status: 500 })),
    ).toBeNull();
    const throwing = (async () => {
      throw new Error("net down");
    }) as unknown as typeof fetch;
    expect(await resolveQrContent("https://example.com/x", throwing)).toBeNull();
  });

  it("提取结果与原 content 相同则不替换", async () => {
    const url = "https://example.com/auth?a=1";
    expect(
      await resolveQrContent(url, fakeFetch(`{"auth_url":"https://example.com/auth?a=1"}`)),
    ).toBeNull();
  });
});

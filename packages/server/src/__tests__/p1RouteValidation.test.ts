import { describe, expect, it } from "vitest";
import { app } from "../app";

/**
 * D6-P1 回归:各路由 c.req.json() 改走 parseBody 后,非法 JSON / 坏形状仍 400,
 * 且个别路由的自定义错误文案(中文)保持不变。合法输入的正常受理由各路由既有专项测试覆盖
 * (credentials/modelSettings/searchSettings/uploadRoutes/folderBridgeRoutes),这里只补
 * parseBody 边界(非法输入)这一新分支。
 */

function post(path: string, body: string, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}
function put(path: string, body: string) {
  return app.request(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

function nestedJson(depth: number): string {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i += 1) {
    value = { child: value };
  }
  return JSON.stringify(value);
}

describe("D6-P1 parseBody 边界", () => {
  it("写请求只接受 application/json Content-Type", async () => {
    const textPlain = await app.request("/api/v1/clientlog", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: '{"events":[]}',
    });
    expect(textPlain.status).toBe(400);
    expect(await textPlain.json()).toMatchObject({
      error: "Content-Type must be application/json",
    });

    const withCharset = await app.request("/api/v1/clientlog", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: '{"events":[]}',
    });
    expect(withCharset.status).toBe(200);
  });

  it("clientlog:非法 JSON / events 非数组 → 400;合法 → 200", async () => {
    expect((await post("/api/v1/clientlog", "{bad")).status).toBe(400);
    expect((await post("/api/v1/clientlog", '{"events":"x"}')).status).toBe(400);
    const ok = await post("/api/v1/clientlog", '{"events":[]}');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true });
  });

  it("upload:缺 filename/content → 400", async () => {
    expect((await post("/api/v1/upload", "{bad")).status).toBe(400);
    const empty = await post("/api/v1/upload", '{"filename":"","content":""}');
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({
      error: expect.stringContaining("filename"),
      issues: expect.arrayContaining([expect.objectContaining({ path: "filename" })]),
    });
    expect((await post("/api/v1/upload", "{}")).status).toBe(400);
  });

  it("parseBody:深嵌套超限 → 400 统一错误契约", async () => {
    const res = await post("/api/v1/clientlog", JSON.stringify({ events: [JSON.parse(nestedJson(70))] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("maximum nesting depth"),
      issues: expect.arrayContaining([expect.objectContaining({ code: "too_big" })]),
    });
  });

  it("credentials:非法 JSON 保留中文文案 / 未知平台 → 400", async () => {
    const badJson = await post("/api/v1/credentials", "{bad");
    expect(badJson.status).toBe(400);
    expect((await badJson.json()).error).toContain("请求内容格式不正确");
    const unknown = await post("/api/v1/credentials", '{"platform":"evil","values":{}}');
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toContain("未知平台");
  });

  it("modelSettings PUT:数组 body → 400 Body must be an object", async () => {
    const res = await put("/api/v1/settings/model", "[]");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Body must be an object");
  });

  it("modelSettings test-custom:非法 JSON 保留 ok:false 形状 + 中文文案", async () => {
    const res = await post("/api/v1/settings/model/test-custom", "{bad");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "请求格式错误" });
  });

  it("searchSettings PUT primary:数组 body → 400 Body must be an object", async () => {
    const res = await put("/api/v1/settings/search/primary", "[]");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Body must be an object");
  });

  it("vision test:非法 JSON 保留 errorKind 形状", async () => {
    const res = await post("/api/v1/settings/vision/test", "{bad");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, errorKind: "invalid_config" });
  });
});

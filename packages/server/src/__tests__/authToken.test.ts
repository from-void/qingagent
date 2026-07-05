import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { authTokenMiddleware, tokensMatch } from "../lib/authToken";
import { authRoutes } from "../routes/auth";

function makeApp() {
  const app = new Hono();
  app.use("/api/*", authTokenMiddleware);
  app.route("/api/v1", authRoutes);
  app.get("/api/v1/protected", (c) => c.json({ ok: true, method: "GET" }));
  app.post("/api/v1/protected", (c) => c.json({ ok: true, method: "POST" }));
  return app;
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

afterEach(() => {
  delete process.env.QINGAGENT_AUTH_TOKEN;
});

describe("authTokenMiddleware", () => {
  it("QINGAGENT_AUTH_TOKEN 未设时完全直通", async () => {
    const app = makeApp();
    const requests = [
      Promise.resolve(app.request("/api/v1/protected")),
      Promise.resolve(app.request("/api/v1/protected", { headers: { Authorization: "Bearer wrong" } })),
      Promise.resolve(app.request("/api/v1/protected", { headers: { Cookie: "qa_auth=wrong" } })),
      Promise.resolve(app.request("/api/v1/protected?auth=wrong")),
      Promise.resolve(app.request("/api/v1/protected", jsonPost({ any: true }))),
    ];

    const responses = await Promise.all(requests);

    expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
  });

  it("Authorization Bearer 正确通过、错误或缺失返回 401", async () => {
    process.env.QINGAGENT_AUTH_TOKEN = "secret-xyz";
    const app = makeApp();

    await expect(app.request("/api/v1/protected", {
      headers: { Authorization: "Bearer secret-xyz" },
    })).resolves.toMatchObject({ status: 200 });

    const wrong = await app.request("/api/v1/protected", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toEqual({ error: "unauthorized" });

    const missing = await app.request("/api/v1/protected");
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("cookie qa_auth 正确通过、错误返回 401", async () => {
    process.env.QINGAGENT_AUTH_TOKEN = "secret-xyz";
    const app = makeApp();

    const ok = await app.request("/api/v1/protected", {
      headers: { Cookie: "qa_auth=secret-xyz" },
    });
    expect(ok.status).toBe(200);

    const wrong = await app.request("/api/v1/protected", {
      headers: { Cookie: "qa_auth=wrong" },
    });
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("query auth 正确通过、错误返回 401", async () => {
    process.env.QINGAGENT_AUTH_TOKEN = "secret-xyz";
    const app = makeApp();

    expect((await app.request("/api/v1/protected?auth=secret-xyz")).status).toBe(200);

    const wrong = await app.request("/api/v1/protected?auth=wrong");
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("畸形/超长凭据输入不会抛错或绕过鉴权", async () => {
    process.env.QINGAGENT_AUTH_TOKEN = "secret-xyz";
    const app = makeApp();
    const longToken = "x".repeat(128 * 1024);

    const malformedAuth = await app.request("/api/v1/protected", {
      headers: { Authorization: "Bearer" },
    });
    expect(malformedAuth.status).toBe(401);

    const longAuth = await app.request("/api/v1/protected", {
      headers: { Authorization: `Bearer ${longToken}` },
    });
    expect(longAuth.status).toBe(401);

    const longCookie = await app.request("/api/v1/protected", {
      headers: { Cookie: `qa_auth=${longToken}` },
    });
    expect(longCookie.status).toBe(401);

    const longQuery = await app.request(`/api/v1/protected?auth=${longToken}`);
    expect(longQuery.status).toBe(401);
  });

  it("OPTIONS 和 /auth/session 不被中间件拦截", async () => {
    process.env.QINGAGENT_AUTH_TOKEN = "secret-xyz";
    const app = makeApp();

    const preflight = await app.request("/api/v1/protected", { method: "OPTIONS" });
    expect(preflight.status).not.toBe(401);

    const session = await app.request("/api/v1/auth/session", { method: "POST" });
    expect(session.status).toBe(400);
    await expect(session.json()).resolves.toMatchObject({ error: "invalid body", issues: [] });
  });

  it("auth/session 用正确 token 换发 HttpOnly cookie", async () => {
    process.env.QINGAGENT_AUTH_TOKEN = "secret-xyz";
    const app = makeApp();

    const res = await app.request("/api/v1/auth/session", jsonPost({ token: "secret-xyz" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("qa_auth=secret-xyz");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/api");
  });

  it("auth/session 错误 token 返回 401 且不设置 cookie", async () => {
    process.env.QINGAGENT_AUTH_TOKEN = "secret-xyz";
    const app = makeApp();

    const res = await app.request("/api/v1/auth/session", jsonPost({ token: "wrong" }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("auth/session 非法 body 返回 400", async () => {
    process.env.QINGAGENT_AUTH_TOKEN = "secret-xyz";
    const app = makeApp();

    const res = await app.request("/api/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid body", issues: [] });
  });

  it("auth/session token 类型错误返回统一校验错误契约", async () => {
    process.env.QINGAGENT_AUTH_TOKEN = "secret-xyz";
    const app = makeApp();

    const res = await app.request("/api/v1/auth/session", jsonPost({ token: 1 }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("token"),
      issues: [expect.objectContaining({ path: "token" })],
    });
  });
});

describe("tokensMatch", () => {
  it("正确、错误、不同长度都稳定返回且不抛错", () => {
    expect(tokensMatch("secret-xyz", "secret-xyz")).toBe(true);
    expect(tokensMatch("wrong", "secret-xyz")).toBe(false);
    expect(() => tokensMatch("x", "secret-xyz")).not.toThrow();
    expect(tokensMatch("x", "secret-xyz")).toBe(false);
  });
});

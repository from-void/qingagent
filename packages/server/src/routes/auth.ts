import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import { AUTH_COOKIE_NAME, tokensMatch } from "../lib/authToken";
import { parseBody } from "../lib/validation";

export const authRoutes = new Hono();

const authSessionBodySchema = z.object({ token: z.string() });

// 拿 token 换 HttpOnly cookie,供 EventSource(带不了 header)同源自动携带。
// 该路由被 authTokenMiddleware 豁免,但仍受 csrfMutationGuard(POST 需可信 Origin,web 同源天然通过)。
authRoutes.post("/auth/session", async (c) => {
  const expected = process.env.QINGAGENT_AUTH_TOKEN;
  if (!expected) return c.json({ ok: true }); // 未启用鉴权时无操作,便于前端统一调用
  const parsed = await parseBody(c, authSessionBodySchema, {
    invalidJsonMessage: "invalid body",
  });
  if (!parsed.ok) return parsed.response;
  const token = parsed.data.token;
  if (!token || !tokensMatch(token, expected)) return c.json({ error: "unauthorized" }, 401);

  // https 下加 Secure。判定:x-forwarded-proto=https(nginx 反代)或请求本身是 https。
  const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
  const secure = proto === "https";
  setCookie(c, AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/api",
    secure,
    maxAge: 60 * 60 * 24 * 30,
  });
  return c.json({ ok: true });
});

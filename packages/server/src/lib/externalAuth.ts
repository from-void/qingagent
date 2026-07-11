import type { MiddlewareHandler } from "hono";
import { tokensMatch } from "./authToken";
import { getExternalToken } from "./externalInstance";

export const externalTokenMiddleware: MiddlewareHandler = async (c, next) => {
  const expected = getExternalToken();
  const auth = c.req.header("Authorization");
  const provided = auth && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : null;
  if (expected && provided && tokensMatch(provided, expected)) return next();
  return c.json({ error: "unauthorized", code: "AUTH_FAILED" }, 401);
};

import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createHash, timingSafeEqual } from "node:crypto";
import { randomBytes } from "node:crypto";

export const AUTH_COOKIE_NAME = "qa_auth";
let desktopGlobalToken: string | null = null;

export function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function extractAuthToken(c: Context): string | null {
  const auth = c.req.header("Authorization");
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const cookie = getCookie(c, AUTH_COOKIE_NAME);
  if (cookie) return cookie;
  const query = c.req.query("auth");
  return query || null;
}

/** desktop embedded 的非持久 global principal；与 instance credential 严格分离。 */
export function issueDesktopGlobalToken(): string {
  desktopGlobalToken = `qa_global_${randomBytes(32).toString("hex")}`;
  return desktopGlobalToken;
}

export function getDesktopGlobalToken(): string | null {
  return desktopGlobalToken;
}

export function clearDesktopGlobalToken(): void {
  desktopGlobalToken = null;
}

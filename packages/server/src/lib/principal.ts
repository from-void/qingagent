import type { Context, MiddlewareHandler } from "hono";
import { extractAuthToken, getDesktopGlobalToken, tokensMatch } from "./authCredentials";
import {
  ATTACH_SESSION_TOKEN_PREFIX,
  resolveAttachSession,
  type AttachSession,
} from "./attachSessions";
import { getExternalInstance, getExternalToken, INSTANCE_TOKEN_PREFIX } from "./externalInstance";

export type RequestPrincipal =
  | { kind: "anonymous" }
  | { kind: "global" }
  | { kind: "externalInstance"; instanceId: string }
  | { kind: "attachSession"; session: AttachSession };

export type PrincipalAuthFailure =
  | "ATTACH_SESSION_EXPIRED"
  | "INSTANCE_AUTH_FAILED";

declare module "hono" {
  interface ContextVariableMap {
    principal: RequestPrincipal;
    principalAuthFailure: PrincipalAuthFailure | null;
  }
}

export function bearerToken(c: Context): string | null {
  const auth = c.req.header("Authorization");
  if (!auth || !/^Bearer\s+/i.test(auth)) return null;
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  return token || null;
}

/** 固定顺序：global → external instance → attach session → anonymous。 */
export const principalMiddleware: MiddlewareHandler = async (c, next) => {
  const configuredGlobal = process.env.QINGAGENT_AUTH_TOKEN;
  const desktopGlobal = getDesktopGlobalToken();
  const globalCandidate = extractAuthToken(c);
  const bearer = bearerToken(c);
  let principal: RequestPrincipal = { kind: "anonymous" };
  let failure: PrincipalAuthFailure | null = null;

  if (
    globalCandidate &&
    (
      (configuredGlobal && tokensMatch(globalCandidate, configuredGlobal))
      || (desktopGlobal && tokensMatch(globalCandidate, desktopGlobal))
    )
  ) {
    principal = { kind: "global" };
  } else {
    const externalToken = getExternalToken();
    if (externalToken && bearer && tokensMatch(bearer, externalToken)) {
      const instance = getExternalInstance();
      principal = {
        kind: "externalInstance",
        instanceId: instance?.instanceId ?? "unpublished",
      };
    } else if (bearer) {
      const session = resolveAttachSession(bearer);
      if (session) {
        principal = { kind: "attachSession", session };
      } else if (bearer.startsWith(ATTACH_SESSION_TOKEN_PREFIX)) {
        failure = "ATTACH_SESSION_EXPIRED";
      } else if (bearer.startsWith(INSTANCE_TOKEN_PREFIX)) {
        failure = "INSTANCE_AUTH_FAILED";
      }
    }
  }

  c.set("principal", principal);
  c.set("principalAuthFailure", failure);
  return next();
};

export function getRequestPrincipal(c: Context): RequestPrincipal {
  return c.get("principal") ?? { kind: "anonymous" };
}

export function getPrincipalAuthFailure(c: Context): PrincipalAuthFailure | null {
  return c.get("principalAuthFailure") ?? null;
}

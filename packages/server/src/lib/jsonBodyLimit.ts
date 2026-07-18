import { bodyLimit } from "hono/body-limit";
import type { MiddlewareHandler } from "hono";

export const DEFAULT_JSON_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

export function resolveJsonBodyLimit(
  raw = process.env.QINGAGENT_JSON_BODY_LIMIT,
): number {
  if (raw == null || raw.trim() === "") return DEFAULT_JSON_BODY_LIMIT_BYTES;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_JSON_BODY_LIMIT_BYTES;
}

/**
 * API 通用请求体护栏。upload 自带更大的 base64 上传限额，必须继续由其路由级
 * bodyLimit 处理；其余 /api/* 请求在鉴权和路由解析前统一限流。
 */
export function createJsonBodyLimitMiddleware(
  maxSize = resolveJsonBodyLimit(),
): MiddlewareHandler {
  const limit = bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: "请求体过大" }, 413),
  });

  return (c, next) => {
    if (c.req.path === "/api/v1/upload") return next();
    return limit(c, next);
  };
}

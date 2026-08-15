import type { Context } from "hono";

/**
 * /commands 与 /ask-more 实际消费的全部 x-model-* / x-vision-* 头。
 * M2 代理剥除清单必须直接复用此常量，禁止另抄一份前缀或人工列表。
 */
export const COMMANDS_MODEL_OVERRIDE_HEADERS = [
  "x-model-provider",
  "x-model-key",
  "x-model-base-url",
  "x-model-flash",
  "x-model-pro",
  "x-model-tier",
  "x-model-protocol",
  "x-vision-key",
  "x-vision-base-url",
  "x-vision-model",
  "x-vision-protocol",
] as const;

export type CommandsModelOverrideHeader = (typeof COMMANDS_MODEL_OVERRIDE_HEADERS)[number];

export function readCommandsModelOverrideHeaders(
  c: Context,
): Record<CommandsModelOverrideHeader, string | undefined> {
  return Object.fromEntries(
    COMMANDS_MODEL_OVERRIDE_HEADERS.map((name) => [name, c.req.header(name)]),
  ) as Record<CommandsModelOverrideHeader, string | undefined>;
}

export function hasCommandsModelOverrideHeader(c: Context): boolean {
  return COMMANDS_MODEL_OVERRIDE_HEADERS.some((name) => c.req.header(name) !== undefined);
}

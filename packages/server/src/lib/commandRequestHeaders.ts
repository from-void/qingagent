import type { Context } from "hono";
import { ATTACH_MODEL_OVERRIDE_HEADERS } from "@qingagent/contract-ts";

/**
 * /commands 与 /ask-more 实际消费的全部 x-model-* / x-vision-* 头。
 * M2 代理剥除清单必须直接复用此常量，禁止另抄一份前缀或人工列表。
 */
export const COMMANDS_MODEL_OVERRIDE_HEADERS = ATTACH_MODEL_OVERRIDE_HEADERS;

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

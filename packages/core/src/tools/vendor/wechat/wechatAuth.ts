import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wechatAuthService } from "../../../connectors/wechatAuthService.js";
import { startToolHeartbeat } from "../../toolHeartbeat.js";

export const wechatAuthStartTool = createTool({
  id: "wechat_auth_start",
  description: "打开微信公众号后台登录页,返回扫码二维码图片,并在后台等待扫码成功后保存微信登录凭据。",
  inputSchema: z.object({}),
  outputSchema: z.object({
    ok: z.boolean(), imageDataUri: z.string(), expiresInSec: z.number(),
    connectorId: z.literal("wechat-mp"), pendingId: z.string(), reused: z.boolean(),
  }),
  execute: async (_input, context) => {
    const stop = startToolHeartbeat(context, { tool: "wechat_auth_start" });
    try { return await wechatAuthService.start(); } finally { stop(); }
  },
});

export const wechatAuthStatusTool = createTool({
  id: "wechat_auth_status",
  description: "查询微信公众号后台扫码登录凭据状态。",
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean(), state: z.string(), mpName: z.string(), message: z.string() }),
  execute: async () => wechatAuthService.status(),
});

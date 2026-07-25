import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wechatAuthService } from "../../../connectors/wechatAuthService.js";
import { askUserQuestionInputSchema } from "../../askUserQuestionAdapter.js";
import { startToolHeartbeat } from "../../toolHeartbeat.js";

// 公众号未登录路由是产品定稿文案；保留完整字节串，避免局部改词或选项换序悄悄漂移。
const WECHAT_SEARCH_ROUTE_QUESTIONNAIRE_LITERAL = `{"id":"wechat-search-route","rationale":"先选一种查找方式，我再继续帮你找这篇公众号文章。","questions":[{"header":"查找方式","question":"你想用哪种方式查找公众号文章？","multiSelect":false,"options":[{"value":"login-owned","label":"我有公众号，直接扫码登录（推荐）","description":"借用公众号后台自带的搜索能力，你的公众号只是登录入口。"},{"value":"login-register","label":"我没有，先去 mp.weixin.qq.com 免费注册再扫码","description":"注册后借用公众号后台自带的搜索能力，你的公众号只是登录入口。"},{"value":"fallback-websearch","label":"先用联网搜索（效果较差，只有零散公开网页）","description":"不登录公众号后台，改用公开网页检索，结果可能不完整。"}]}]}`;

function createWechatSearchRouteQuestionnaire(): z.infer<typeof askUserQuestionInputSchema> {
  return JSON.parse(WECHAT_SEARCH_ROUTE_QUESTIONNAIRE_LITERAL) as z.infer<
    typeof askUserQuestionInputSchema
  >;
}

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
  description: "查询微信公众号后台扫码登录凭据状态；未 READY 时同时返回可原样传给 askUserQuestion 的 questionnaire。",
  inputSchema: z.object({}),
  outputSchema: z.object({
    ok: z.boolean(),
    state: z.string(),
    mpName: z.string(),
    message: z.string(),
    questionnaire: askUserQuestionInputSchema.nullable(),
  }),
  execute: async () => {
    const status = await wechatAuthService.status();
    return {
      ...status,
      questionnaire: status.state === "READY" ? null : createWechatSearchRouteQuestionnaire(),
    };
  },
});

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * show_qr —— 在对话流里渲染一个统一的二维码卡片(UI 指令型工具,无副作用)。
 *
 * 真正的卡片由 bridge 在「工具调用」时映射成 qrCard body 帧并渲染(见 processAgentStream);
 * 本工具的 execute 只回 {ok:true} 标记完成。卡片特点:渲染瞬间按 expiresInSec 起算过期,
 * 过期后码被作废,悬停变「刷新」按钮,点击发送 refreshQuery 让 agent 重新生成。
 *
 * 抽象统一:扫码授权(飞书/钉钉/企微 device flow 的 verification URL)、配对、分享链接等都复用它。
 */
export const showQrTool = createTool({
  id: "show_qr",
  description:
    "在对话里渲染一个二维码卡片给用户扫码/点击(授权登录、配对、分享通用)。" +
    "典型场景:平台 OAuth device flow —— 先用对应 CLI 拿到 verification URL(如 lark-cli auth login --no-wait --json)," +
    "再调本工具把该 URL 渲染成二维码 + 可点链接交给用户。" +
    "若 CLI 会阻塞等待扫码(init/login 类,打印字符画二维码后停在「等待扫码」不退出):" +
    "用 execute_command 的 background:true 后台跑,再用 mastra_workspace_get_process_output 轮询输出、" +
    "从中提取授权 URL 来调本工具;不要前台死等,也绝不要把字符画二维码原样贴进聊天(渲染不出来)。" +
    "传入:content(要编码的 URL/字符串)、title、可选 code(配对码,没有就不传)、" +
    "expiresInSec(有效期秒数,用 device flow 的 expires_in;服务端会换算成绝对过期时间)、" +
    "note(说明文案,支持 markdown,可把说明和可点授权链接写在一起,如 用飞书 App 扫码,或 [点此授权](URL))、" +
    "refreshQuery(过期后点刷新发送的话术)、" +
    "confirmQuery(授权场景:点「我已完成授权」发送的话术,卡片渲染 10 秒后才出现该按钮,用于触发 agent 收尾)。" +
    "卡片会自动在过期后作废并给出刷新入口。" +
    "【位置】二维码卡片展示在**对话流中、你这条回复的下方**(不在右侧文档面板);向用户说明时务必说『下方/对话中』,**绝不能说『在右侧』**。",
  inputSchema: z.object({
    content: z
      .string()
      .min(1)
      .optional()
      .describe("要编码进二维码的字符串,如 OAuth 验证 URL(图片模式传 imageDataUri 时可省略)"),
    imageDataUri: z
      .string()
      .optional()
      .describe(
        "直接展示的二维码图片(data:image/...;base64 URI)。用于码本身是一张图、无法用字符串编码的场景" +
          "(如微信公众平台后台登录码);传了它就直接显示图片,不再编码 content。content 与 imageDataUri 至少给一个",
      ),
    title: z.string().nullable().optional().describe("标题,如 扫码授权飞书"),
    code: z.string().nullable().optional().describe("配对码/用户码;不是每个平台都有,没有就不传"),
    note: z
      .string()
      .nullable()
      .optional()
      .describe("说明文案(可选),支持轻量 markdown(链接 [文字](url)/粗体);把说明与可点授权链接写在一起"),
    expiresInSec: z
      .number()
      .positive()
      .optional()
      .describe("有效期秒数,到点把码作废;用 device flow 返回的 expires_in;不传则按卡片协议默认 300 秒"),
    refreshQuery: z
      .string()
      .min(1)
      .optional()
      .describe("过期后点击「刷新」时发送的预设 query,如 飞书授权二维码过期了,请帮我重新生成"),
    confirmQuery: z
      .string()
      .nullable()
      .optional()
      .describe(
        "点确认按钮时发送的预设 query(授权类场景传,如 我已完成飞书扫码授权,请继续收尾);" +
          "卡片渲染 10 秒后才出现该按钮,用于触发 agent 去跑 device flow 收尾",
      ),
    confirmLabel: z
      .string()
      .nullable()
      .optional()
      .describe(
        "确认按钮的显示文案(可选,要短、贴场景,如 我已创建好 / 我已完成授权);不传则默认「我已完成授权」。" +
          "与 confirmQuery 解耦:label 给用户看要短,confirmQuery 是点击后发送给 agent 的话术可更明确",
      ),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

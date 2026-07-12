import type { AskUserSpec } from "./AskUserSpec";
import type { DocSuggestionBody } from "./DocSuggestionBody";
import type { ResourceRef } from "./ResourceRef";
import type { WriteDraftCardBody } from "./WriteDraftCardBody";
import type { CommandCardBody } from "./CommandCardBody";
import type { ResearchCardBody } from "./ResearchCardBody";

export type GenerateSvgProgressStage = "starting" | "streaming" | "sanitizing" | "done" | "failed";

export interface GenerateSvgProgress {
  stage: GenerateSvgProgressStage;
  elapsedMs: number;
  rawKb: number;
  message: string;
  error: string | null;
  src: string | null;
  width: number | null;
  height: number | null;
  /** 流式草稿预览:streaming 阶段下后端把"自动闭合 + 基础防 XSS"的半截 SVG 节流推上来,
   *  前端 running 时用 dangerouslySetInnerHTML 渲染草稿;done 后切换到最终 sanitized 的 src。
   *  非 streaming 阶段为 null。 */
  partialSvg: string | null;
}

export interface GenerateSvgCardBody {
  prompt: string;
  style: string | null;
  aspect: string | null;
  progress: GenerateSvgProgress | null;
}

export type ToolCallBody = { "kind": "askUser", "data": AskUserSpec } | { "kind": "docSuggestion", "data": DocSuggestionBody } | { "kind": "spawnSubAgent", "data": { subAgentId: string, name: string, description: string, rootTaskId: string, } } | { "kind": "extractFile", "data": { resourceRef: ResourceRef, } } | { "kind": "extractImage", "data": { resourceRef: ResourceRef, } } | { "kind": "generateSvg", "data": GenerateSvgCardBody } | { "kind": "readImageCard", "data": { prompt: string, thumbnailSrc: string | null, excerpt: string | null, } } | { "kind": "webFetch", "data": { urlRef: ResourceRef, } } | { "kind": "browserOpen", "data": { urlRef: ResourceRef, requireInteraction: boolean, } } | { "kind": "browserAct", "data": { action: string, } } | { "kind": "writeDraftCard", "data": WriteDraftCardBody } | { "kind": "commandCard", "data": CommandCardBody } | { "kind": "researchCard", "data": ResearchCardBody } | { "kind": "qrCard", "data": QrCardBody } | { "kind": "generic", "data": { argsJson: string, } };

/**
 * 对话流内置二维码卡:agent 调 show_qr 工具输出。到 expiresAt(绝对时间戳)码作废、置灰打码,
 * 悬停变「刷新」按钮,点击发送 refreshQuery(预设文案)让 agent 重新生成。抽象统一,任意平台授权/分享均可复用。
 */
export interface QrCardBody {
  /** 要编码进二维码的字符串(如 OAuth 验证 URL)。图片模式(imageDataUri 非空)下可为空串。 */
  content: string;
  /** 直接展示的二维码图片(data URI)。用于码本身就是一张图、无法用字符串编码的场景
   *  (如微信公众平台后台登录码是页面渲染的图片元素);非空时前端直接显示它,不再编码 content。
   *  可选(向后兼容:编码模式不传);缺省即走 content 编码模式。 */
  imageDataUri?: string | null;
  /** 标题,如「扫码授权飞书」。 */
  title: string | null;
  /** 附带展示的用户码/配对码;不是每个平台都有,没有则传 null,前端隐藏。 */
  code: string | null;
  /** 说明文案(可选),支持轻量 markdown(链接 [文字](url)/粗体)。由模型按场景自产,
   *  把说明与可点授权链接合在一起,替代写死的兜底链接。 */
  note: string | null;
  /** 过期的绝对时间戳(epoch 毫秒)。服务端用「收到工具调用时刻 + expiresInSec」换算,
   *  比「相对秒数 + 前端渲染时起算」准——不受 agent 思考/网络/渲染延迟影响。 */
  expiresAt: number;
  /** 过期后点击「刷新」时发送的预设 query。 */
  refreshQuery: string;
  /** 点「我已完成授权」时发送的预设 query(可选,授权类场景传)。卡片渲染 10 秒后才出现该按钮——
   *  让用户先扫码、在外部确认完再点,触发 agent 去收尾(device flow 的 --device-code);null 则不显示。 */
  confirmQuery: string | null;
  /** 确认按钮的显示文案(可选,短,如「我已创建好」)。缺省/null 则用默认「我已完成授权」。
   *  与 confirmQuery 解耦:label 给用户看(要短、贴场景),query 是点击后发送给 agent 的话术(可更明确)。 */
  confirmLabel?: string | null;
  /** 仅 connector bridge/service 可生成；show_qr 模型 schema 不含这些字段。 */
  connectorId?: "github" | "feishu" | "wechat-mp";
  /** 进程内 pending 的不可猜标识；M1b 仅预留兼容字段，不启动轮询。 */
  pendingId?: string;
  /** 可信 service 可回填的公开成功态；旧卡缺失时完全沿用 confirm/refresh 行为。 */
  success?: {
    account: string | null;
    message: string;
  };
}

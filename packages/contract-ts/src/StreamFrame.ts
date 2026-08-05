import type { EndReason } from "./EndReason";
import type { PmDoc } from "./PmDoc";

export type StreamErrorCategory =
  | "auth"
  | "quota"
  | "request"
  | "rate_limit"
  | "timeout"
  | "upstream"
  | "network"
  | "blocked_address"
  | "unknown";

export type StreamErrorAction =
  | "retry"
  | "check_model_settings"
  | "check_balance"
  | "reload"
  | "none";

export const MODEL_CONTEXT_LENGTH_EXCEEDED_MESSAGE =
  "素材或对话内容超出模型上下文长度。请删除部分素材、改用摘要，或拆分后分段处理。";

export const MODEL_REQUEST_TOO_LARGE_MESSAGE =
  "请求中的素材或内容体量过大，模型服务拒绝接收。请删除部分素材、改用摘要，或拆分后分段处理。";

export interface FinalDocumentReceipt {
  version: number;
  contentHash: string;
  doc: PmDoc;
}

export type StreamFrame =
  | { kind: "start"; data: { streamId: string } }
  | {
      kind: "end";
      data: {
        streamId: string;
        reason: EndReason;
        finalDocument?: FinalDocumentReceipt;
      };
    }
  | {
      kind: "draftingFailed";
      data: {
        streamId: string;
        reason: string;
        retriable: boolean;
        statusCode?: number;
        category?: StreamErrorCategory;
        userMessage?: string;
        action?: StreamErrorAction;
      };
    };

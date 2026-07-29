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

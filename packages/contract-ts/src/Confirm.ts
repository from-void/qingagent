export type ConfirmKind = "install" | "connect" | "send" | "command";
// 四类确认都允许记住"始终允许"(是否给出「记住」仍由各确认卡的 rememberCategory 声明决定)
export type RememberableConfirmKind = ConfirmKind;

export interface RememberCategory {
  kind: RememberableConfirmKind;
  label: string;
  riskHint?: string;
  /** 仅本地开发显式放宽时为 true；生产 Web 不得据此显示记忆入口。 */
  insecureWithoutDesktop?: boolean;
}

export interface ConfirmOption {
  value: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export type ConfirmWidget =
  | {
      type: "options";
      options: ConfirmOption[];
    }
  | {
      type: "secretInput";
      placeholder: string;
    };

export interface ConfirmSpec {
  id: string;
  kind: ConfirmKind;
  title: string;
  sub?: string;
  say: string;
  /** 状态变化后的非阻断解释；不得承载内部机制词。 */
  notice?: string;
  commandPreview?: string;
  widget?: ConfirmWidget;
  rememberCategory?: RememberCategory;
  footHint?: string;
  primaryLabel: string;
  secondaryLabel: string;
}

export interface ConfirmDecision {
  id: string;
  accepted: boolean;
  optionValue?: string;
  secretValue?: string;
  remember?: boolean;
  uiGrantNonce?: string;
}

export interface SubmitConfirmDecision {
  sessionId: string;
  toolCallId: string;
  decisionId: string;
  decision: ConfirmDecision;
}

export interface CancelConfirmedCommand {
  sessionId: string;
  toolCallId: string;
}

export interface ConfirmRequested {
  toolCallId: string;
  spec: ConfirmSpec;
  requestedAt: string;
  expiresAt: string;
}

export interface ConfirmResolved {
  id: string;
  toolCallId: string;
  resolution: "accepted" | "rejected" | "expired" | "aborted" | "failed";
  message?: string;
}

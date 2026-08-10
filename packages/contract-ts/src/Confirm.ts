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

/**
 * 确认卡上的「以后不用再问我」勾选项。
 *
 * 260811 起产品默认档为「不再询问」。用户显式选了「每次询问」且确认卡实际出现时,
 * 这个勾选允许他从本次批准起切回全局「不再询问」;之后仍可在 设置 → 安全 里改回。
 */
export interface ConfirmBypassOption {
  /** 勾选项主文案,面向普通用户,不得出现任何内部机制词。 */
  label: string;
  /** 一句副说明:讲清后果 + 去哪改回。 */
  hint: string;
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
  /** 声明本张卡可以勾「以后不用再问我」。声明了就优先于 rememberCategory 渲染,卡面只出现一个勾选。 */
  bypassOption?: ConfirmBypassOption;
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
  /** 用户在卡上勾了「以后不用再问我」:批准的同时全局永久关闭询问。 */
  bypassAll?: boolean;
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

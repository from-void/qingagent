export type ConfirmKind = "install" | "connect" | "send" | "command";

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
  widget?: ConfirmWidget;
  footHint: string;
  primaryLabel: string;
  secondaryLabel: string;
}

export interface ConfirmDecision {
  id: string;
  accepted: boolean;
  optionValue?: string;
  secretValue?: string;
}

export interface SubmitConfirmDecision {
  sessionId: string;
  toolCallId: string;
  decisionId: string;
  decision: ConfirmDecision;
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

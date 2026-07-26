import type { ToolCallSpec } from "@qingagent/contract-ts";

export const DUPLICATE_AUTH_CARD_NOOP = "已有授权卡,已忽略";

export interface TrustedAuthCardSignal {
  verificationUri: string;
  userCode: string | null;
}

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function trustedAuthCardSignal(
  spec: ToolCallSpec,
): TrustedAuthCardSignal | null {
  if (
    spec.body.kind !== "qrCard" ||
    !spec.body.data.connectorId ||
    !spec.body.data.content
  ) {
    return null;
  }
  return {
    verificationUri: normalized(spec.body.data.content),
    userCode: normalized(spec.body.data.code) || null,
  };
}

export function showQrDuplicatesTrustedAuthCard(
  args: Record<string, unknown>,
  trustedCards: readonly TrustedAuthCardSignal[],
): boolean {
  const content = normalized(args.content);
  const code = normalized(args.code);
  if (!content && !code) return false;
  return trustedCards.some((card) => {
    if (content === card.verificationUri) return true;
    if (card.userCode && (content === card.userCode || code === card.userCode)) {
      return true;
    }
    return false;
  });
}

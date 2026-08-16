import { decideAttachMode, type AttachModeDecision } from "./attachModeDecision.js";
import type { DiscoveryReport } from "./attachDiscoveryTypes.js";

export type AttachHandshakeFailureResolution =
  | { kind: "embedded" }
  | { kind: "blocked"; decision: AttachModeDecision };

/**
 * health 通过到握手之间可能发生退出竞态。只有未绑定且重新发现确定
 * 全部 absent 时才能回退 embedded；其余情形均保持阻断。
 */
export function resolveAttachHandshakeFailure(
  report: DiscoveryReport,
  boundLibraryId: string | null,
): AttachHandshakeFailureResolution {
  const decision = decideAttachMode(report, boundLibraryId);
  return boundLibraryId === null && decision.kind === "embedded"
    ? { kind: "embedded" }
    : { kind: "blocked", decision };
}

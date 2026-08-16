import type {
  DiscoveredInstance,
  DiscoveryErrorCode,
  DiscoveryReport,
} from "./attachDiscoveryTypes.js";
import { reportValidInstances } from "./attachDiscoveryTypes.js";

export type AttachModeDecision =
  | { kind: "embedded" }
  | { kind: "attach"; instance: DiscoveredInstance }
  | { kind: "select"; candidates: DiscoveredInstance[]; reason: "multiple" | "bound-conflict" }
  | {
      kind: "blocked";
      reason: "discovery" | "bound-missing-other" | "bound-missing" | "catch-all";
      errorCodes: DiscoveryErrorCode[];
      allowUnbind: boolean;
    };

const PROBLEM_STATES = new Set(["indeterminate", "incompatible", "conflict"]);

/** 规格 §4.2 的唯一模式决策函数；调用方不得另写平行分支。 */
export function decideAttachMode(
  report: DiscoveryReport,
  boundLibraryId: string | null,
): AttachModeDecision {
  const valid = reportValidInstances(report);
  const problems = report.observations.filter((entry) => PROBLEM_STATES.has(entry.state));
  const errorCodeSet = new Set<DiscoveryErrorCode>();
  for (const entry of problems) {
    if ("errorCode" in entry && entry.errorCode) errorCodeSet.add(entry.errorCode);
  }
  const errorCodes = [...errorCodeSet];

  if (!boundLibraryId) {
    if (problems.length > 0) {
      return { kind: "blocked", reason: "discovery", errorCodes, allowUnbind: false };
    }
    if (valid.length === 1) return { kind: "attach", instance: valid[0]! };
    if (valid.length >= 2) return { kind: "select", candidates: valid, reason: "multiple" };
    if (
      valid.length === 0
      && report.observations.length > 0
      && report.observations.every((entry) => entry.state === "absent")
    ) {
      return { kind: "embedded" };
    }
    return { kind: "blocked", reason: "catch-all", errorCodes, allowUnbind: false };
  }

  const matching = valid.filter((instance) => instance.libraryId === boundLibraryId);
  if (matching.length === 1) return { kind: "attach", instance: matching[0]! };
  if (matching.length >= 2) {
    return { kind: "select", candidates: matching, reason: "bound-conflict" };
  }
  if (problems.length > 0) {
    return { kind: "blocked", reason: "discovery", errorCodes, allowUnbind: false };
  }
  if (valid.length > 0) {
    return {
      kind: "blocked",
      reason: "bound-missing-other",
      errorCodes: [],
      allowUnbind: true,
    };
  }
  if (
    report.observations.length > 0
    && report.observations.every((entry) => entry.state === "absent")
  ) {
    return { kind: "blocked", reason: "bound-missing", errorCodes: [], allowUnbind: true };
  }
  return { kind: "blocked", reason: "catch-all", errorCodes, allowUnbind: false };
}

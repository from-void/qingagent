import type {
  DiscoveredInstance,
  DiscoveryErrorCode,
  DiscoveryReport,
} from "./attachDiscoveryTypes.js";
import {
  isLocalObservationSource,
  isSameNamespaceSource,
  normalizeEndpoint,
} from "./attachDiscoveryTypes.js";

export type AttachModeDecision =
  | {
      kind: "embedded";
      /**
       * 绑定被确认指向跨命名空间文库时的自动降级标记：调用方必须把绑定标记为
       * 失效（而不是等用户解绑），并向用户明确告知已改用本机文库。该文库在
       * 原系统环境中保持原样，本分支不会触碰它。
       */
      demotedBinding?: "cross-namespace";
    }
  | { kind: "attach"; instance: DiscoveredInstance }
  | { kind: "select"; candidates: DiscoveredInstance[]; reason: "multiple" | "bound-conflict" }
  | {
      kind: "blocked";
      reason:
        | "discovery"
        | "bound-missing-other"
        | "bound-missing"
        | "cross-namespace-only"
        | "catch-all";
      errorCodes: DiscoveryErrorCode[];
      allowUnbind: boolean;
    };

const PROBLEM_STATES = new Set(["indeterminate", "incompatible", "conflict"]);

/**
 * 按 endpoint+instanceId 去重后按命名空间分桶。同一逻辑实例被本机与跨系统
 * 来源同时观测到时，本机观测优先——跨系统副本不得把本机候选挤出候选集。
 */
function partitionValidInstances(report: DiscoveryReport): {
  valid: DiscoveredInstance[];
  crossValid: DiscoveredInstance[];
} {
  const byKey = new Map<string, {
    instance: DiscoveredInstance;
    sameNamespace: boolean;
  }>();
  for (const observation of report.observations) {
    if (observation.state !== "valid") continue;
    const instance = observation.instance;
    const key = `${normalizeEndpoint(instance.endpoint)}\n${instance.instanceId}`;
    const existing = byKey.get(key);
    const sameNamespace = isSameNamespaceSource(observation.source);
    if (
      !existing
      || (!existing.sameNamespace && sameNamespace)
    ) {
      byKey.set(key, { instance, sameNamespace });
    }
  }
  const valid: DiscoveredInstance[] = [];
  const crossValid: DiscoveredInstance[] = [];
  for (const entry of byKey.values()) {
    (entry.sameNamespace ? valid : crossValid).push(entry.instance);
  }
  return { valid, crossValid };
}

/**
 * 规格 §4.2 的唯一模式决策函数；调用方不得另写平行分支。
 *
 * 命名空间铁律（P83）：只有 `local` 来源的实例可作 attach 候选；`wsl:*` 等
 * 跨命名空间观测只参与两类判定——①绑定文库被确认在跨系统侧 valid 时自动
 * 降级 embedded；②本机无任何实例而跨系统侧有 valid 时给出明确阻断文案。
 * 跨命名空间的不确定观测（UNREACHABLE 等）不再阻断本机决策。
 *
 */
export function decideAttachMode(
  report: DiscoveryReport,
  boundLibraryId: string | null,
): AttachModeDecision {
  const { valid, crossValid } = partitionValidInstances(report);
  const localObservations = report.observations.filter((entry) => (
    isLocalObservationSource(entry.source)
  ));
  const problems = localObservations.filter((entry) => PROBLEM_STATES.has(entry.state));
  const errorCodeSet = new Set<DiscoveryErrorCode>();
  for (const entry of problems) {
    if ("errorCode" in entry && entry.errorCode) errorCodeSet.add(entry.errorCode);
  }
  const errorCodes = [...errorCodeSet];
  const localAllAbsent = localObservations.length > 0
    && localObservations.every((entry) => entry.state === "absent");

  if (!boundLibraryId) {
    if (problems.length > 0) {
      return { kind: "blocked", reason: "discovery", errorCodes, allowUnbind: false };
    }
    if (valid.length === 1) return { kind: "attach", instance: valid[0]! };
    if (valid.length >= 2) return { kind: "select", candidates: valid, reason: "multiple" };
    if (crossValid.length > 0) {
      // 本机没有可用实例，只在其他系统环境里发现了引擎：明确阻断，绝不
      // 静默在本机再造一个文库。此前是否曾自动降级不改变这条未绑定规则。
      return {
        kind: "blocked",
        reason: "cross-namespace-only",
        errorCodes: [],
        allowUnbind: false,
      };
    }
    if (localAllAbsent) {
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
  // 绑定文库被确认只在跨系统侧 valid：自动降级 embedded 并交由调用方把绑定
  // 标记为失效。不能落到任何"等用户输入"的分支——渲染不可用时那就是永等。
  if (crossValid.some((instance) => instance.libraryId === boundLibraryId)) {
    return { kind: "embedded", demotedBinding: "cross-namespace" };
  }
  if (valid.length > 0) {
    return {
      kind: "blocked",
      reason: "bound-missing-other",
      errorCodes: [],
      allowUnbind: true,
    };
  }
  if (localAllAbsent) {
    return { kind: "blocked", reason: "bound-missing", errorCodes: [], allowUnbind: true };
  }
  return { kind: "blocked", reason: "catch-all", errorCodes, allowUnbind: false };
}

import type { AttachIdentity } from "@qingagent/contract-ts";

export type DiscoveryErrorCode =
  | "WSL_NOT_INSTALLED"
  | "WSL_STOPPED"
  | "ENUM_FAILED"
  | "HOME_FAILED"
  | "HOME_UNREACHABLE"
  | "READ_TIMEOUT"
  | "MALFORMED"
  | "UNREACHABLE"
  | "AUTH_FAILED"
  | "INCOMPATIBLE"
  | "CONFLICT"
  | "STARTING_LEASE";

export interface DiscoveredInstance extends AttachIdentity {
  token: string;
  endpoint: string;
  source: string;
}

export type DiscoveryObservation =
  | { source: string; state: "valid"; instance: DiscoveredInstance }
  | {
      source: string;
      state: "absent";
      errorCode?: "WSL_NOT_INSTALLED" | "WSL_STOPPED" | "HOME_FAILED";
    }
  | {
      source: string;
      state: "indeterminate" | "incompatible" | "conflict";
      errorCode: DiscoveryErrorCode;
    };

export interface DiscoveryReport {
  observations: DiscoveryObservation[];
}

/**
 * 客户端自身命名空间的唯一实例来源标记。其余来源（`wsl:*` 及任何未来来源）
 * 只作诊断展示，永不作为 attach 候选：跨系统实例的 127.0.0.1 端点在本机
 * 命名空间内语义不同，attach 过去轻则不可达、重则把别的系统的文库当成本机文库。
 * 反向同理：WSL/Linux 客户端只枚举本机 HOME，天然不会看到 Windows 实例。
 */
export const LOCAL_NAMESPACE_SOURCE = "local";

export function isSameNamespaceSource(source: string): boolean {
  return source === LOCAL_NAMESPACE_SOURCE;
}

/**
 * 决策视角下的本机观测来源：`local` 是本机 HOME 探测，`worker` 是发现子进程
 * 级失败（意味着本机枚举本身没完成），两者都必须参与阻断判定；`wsl:*` 等
 * 跨命名空间观测不参与。
 */
export function isLocalObservationSource(source: string): boolean {
  return source === LOCAL_NAMESPACE_SOURCE || source === "worker";
}

export function reportValidInstances(report: DiscoveryReport): DiscoveredInstance[] {
  const unique = new Map<string, DiscoveredInstance>();
  for (const observation of report.observations) {
    if (observation.state !== "valid") continue;
    const instance = observation.instance;
    unique.set(`${normalizeEndpoint(instance.endpoint)}\n${instance.instanceId}`, instance);
  }
  return [...unique.values()];
}

export function normalizeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || "80"}`;
  } catch {
    return endpoint.trim().toLowerCase();
  }
}

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

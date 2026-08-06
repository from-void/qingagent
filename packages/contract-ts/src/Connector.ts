export type ConnectorId = "github" | "feishu" | "wechat-mp";
export type ConnectorAuthPresentation = "device-code" | "scan";

export type ConnectorState =
  | "unavailable"
  | "checking"
  | "unconfigured"
  | "disconnected"
  | "pending"
  | "connected"
  | "needs_reauth";

export type ConnectorStatusFreshness = "fresh" | "stale" | "unknown" | "ttl";

export interface ConnectorAccount {
  id?: string;
  displayName: string;
}

export interface ConnectorStatus {
  state: ConnectorState;
  reasonCode: string | null;
  account: ConnectorAccount | null;
  scopes: string[];
  lastCheckedAt: string | null;
  statusFreshness: ConnectorStatusFreshness;
  canProbe: boolean;
  cliVersion?: string | null;
}

export interface ConnectorInfo {
  id: ConnectorId;
  name: string;
  icon: string;
  official: boolean;
  authPresentation: ConnectorAuthPresentation;
  riskNote: string | null;
  usedBySkills: string[];
  status: ConnectorStatus;
}

export interface ConnectorListResponse {
  connectors: ConnectorInfo[];
}

export type ConnectorId = "github" | "feishu" | "wechat-mp";

export type ConnectorAuthStrategy = "oauth2-device" | "device-flow-cli" | "qr-session";
export type ConnectorCustody = "internal" | "external-cli";

export interface ConnectorScopeGroup {
  id: string;
  name: string;
  scopes: string[];
  description?: string;
}

export interface ConnectorDefinition {
  id: ConnectorId;
  name: string;
  icon: string;
  official: boolean;
  authStrategy: ConnectorAuthStrategy;
  custody: ConnectorCustody;
  scopeGroups: ConnectorScopeGroup[];
  tools: string[];
  usedBySkills: string[];
  riskNote?: string;
}

export type ConnectorState =
  | "unavailable"
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

export interface ConnectorStatusDto {
  state: ConnectorState;
  reasonCode: string | null;
  account: ConnectorAccount | null;
  scopes: string[];
  lastCheckedAt: string | null;
  statusFreshness: ConnectorStatusFreshness;
  canProbe: boolean;
  cliVersion?: string | null;
}

export type ConnectorTransitionKind = "transition" | "idempotent" | "illegal";

export type ConnectorTransitionTable = Readonly<
  Record<ConnectorState, Readonly<Record<ConnectorState, ConnectorTransitionKind>>>
>;

export interface ConnectorStatusPatch {
  reasonCode?: string | null;
  account?: ConnectorAccount | null;
  scopes?: string[];
  lastCheckedAt?: string | null;
  statusFreshness?: ConnectorStatusFreshness;
  canProbe?: boolean;
  cliVersion?: string | null;
}

export interface ConnectorAdapter {
  status(): Promise<ConnectorStatusDto>;
  start?(): Promise<unknown>;
  probe?(): Promise<ConnectorStatusDto>;
  disconnect(): Promise<ConnectorStatusDto>;
}

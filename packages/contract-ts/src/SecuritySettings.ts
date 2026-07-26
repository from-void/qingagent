export type SecurityGrantKind = "install" | "command" | "send" | "connect";

export type SecurityGrantMode = "ask" | "always";

export interface SecurityGrantCategory {
  kind: SecurityGrantKind;
  label: string;
  grantMode: SecurityGrantMode;
  grantModes: SecurityGrantMode[];
  present: boolean;
  grantId: string | null;
  version: number;
}

export interface SecuritySettingsResponse {
  categories: SecurityGrantCategory[];
}

export interface UpdateSecurityGrantRequest {
  grantMode: SecurityGrantMode;
}

export interface UpdateSecurityGrantResponse {
  kind: "install" | "command";
  grantMode: SecurityGrantMode;
  present: boolean;
  grantId: string | null;
  version: number;
}

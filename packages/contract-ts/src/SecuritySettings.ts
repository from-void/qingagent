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
  /** 已声明的「与命令行工具共享登录信息」条目;随设置一次取回,不额外多一次请求。 */
  credentialShare?: CredentialShareItem[];
  operation?: SecuritySettingsOperation;
}

export interface UpdateSecurityGrantRequest {
  grantMode: SecurityGrantMode;
  operationId: string;
  baseVersion: number;
}

export interface UpdateSecurityGrantResponse {
  kind: SecurityGrantKind;
  grantMode: SecurityGrantMode;
  present: boolean;
  grantId: string | null;
  version: number;
  operationId: string;
  baseVersion: number;
}

/** 一条「命令行工具凭证共享」条目:某个已启用技能声明的路径 + 当前是否已授权。 */
export interface CredentialShareItem {
  skillName: string;
  skillLabel: string;
  /** 技能里的原始写法(~/...),给用户看。 */
  declared: string;
  granted: boolean;
  grantedAt: string | null;
}

export interface CredentialShareResponse {
  items: CredentialShareItem[];
}

export interface UpdateCredentialShareRequest {
  skillName: string;
  declared: string;
  granted: boolean;
}

export type SecuritySettingsOperation =
  | {
      operationId: string;
      kind: SecurityGrantKind;
      grantMode: SecurityGrantMode;
      baseVersion: number;
      status: "pending" | "failed";
    }
  | {
      operationId: string;
      kind: SecurityGrantKind;
      grantMode: SecurityGrantMode;
      baseVersion: number;
      status: "committed";
      result: UpdateSecurityGrantResponse;
    };

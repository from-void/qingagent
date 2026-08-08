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

/**
 * 「以后不用再问我」的全局状态。
 *
 * 为什么它独立于上面的四类 grant,而不是"四类一起置 always":
 * 它除了"不再询问",还同时决定命令**不再隔离执行**(以用户本人身份直接跑),语义比
 * "四类都不问"更宽;做成一个独立开关,才能一次开、一次关、一处读,也不会因为用户
 * 在四类里回调一格就悄悄改变隔离形态。
 */
export interface SecurityBypassState {
  enabled: boolean;
  /** 开启时间(ISO);未开启为 null。 */
  enabledAt: string | null;
}

export interface SecuritySettingsResponse {
  categories: SecurityGrantCategory[];
  /** 当前是否处于「以后不用再问我」。缺省视为未开启(默认形态)。 */
  bypass?: SecurityBypassState;
  /** 已声明的「与命令行工具共享登录信息」条目;随设置一次取回,不额外多一次请求。 */
  credentialShare?: CredentialShareItem[];
  operation?: SecuritySettingsOperation;
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

export type SecuritySettingsOperation =
  | {
      operationId: string;
      kind: SecurityGrantKind;
      grantMode: SecurityGrantMode;
      baseVersion: number;
      status: "pending" | "failed" | "conflict";
    }
  | {
      operationId: string;
      kind: SecurityGrantKind;
      grantMode: SecurityGrantMode;
      baseVersion: number;
      status: "committed";
      result: UpdateSecurityGrantResponse;
    };

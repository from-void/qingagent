/**
 * Desktop attach 协议版本。发现文件、认证健康检查与握手共同引用这一常量；
 * 产品版本不能代替协议兼容判断。
 */
export const ATTACH_PROTOCOL_VERSION = 1 as const;

/** attach 能力枚举的唯一真源。新增能力必须同步经过 server policy 契约测试。 */
export const ATTACH_CAPABILITY_NAMES = [
  "folderSelection",
  "confirmGrant",
  "diagnosticsExport",
  "documentExport",
  "credentialProvider",
  "modelKeys",
  "skillMutation",
  "connectors",
  "updates",
  "templateMutation",
  "derivativeMutation",
  "lexiconMutation",
  "deepLink",
  "docEditing",
  "review",
  "assets",
] as const;

export type AttachCapability = (typeof ATTACH_CAPABILITY_NAMES)[number];
export type AttachCapabilities = Record<AttachCapability, boolean>;

export const ATTACH_MUST_ENABLE_CAPABILITIES = [
  "docEditing",
  "review",
  "assets",
  "deepLink",
] as const satisfies readonly AttachCapability[];

export interface AttachIdentity {
  schemaVersion: 2;
  port: number;
  pid: number;
  version: string;
  attachProtocolVersion: typeof ATTACH_PROTOCOL_VERSION;
  instanceId: string;
  libraryId: string;
  startedAt: string;
}

export interface AttachHandshakeRequest {
  desktopCapabilities: AttachCapabilities;
}

export interface AttachHandshakeResponse extends AttachIdentity {
  attachSessionToken: string;
  absoluteExpiresAt: string;
  idleExpiresAt: string;
  serverCapabilities: AttachCapabilities;
  effectiveCapabilities: AttachCapabilities;
}

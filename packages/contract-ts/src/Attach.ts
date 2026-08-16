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
  "sessionDeletion",
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

/**
 * renderer 经数据 origin 发请求时唯一允许触发预检的自定义头。
 * desktop 代理与 server AttachRoutePolicy 的契约测试共同消费，禁止携带凭据类头。
 */
export const ATTACH_CORS_ALLOWED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "x-qa-client",
  "last-event-id",
  "x-client-trace-id",
] as const;

/** `/commands` 与 `/ask-more` 会消费的模型覆盖头；attach 代理必须逐项剥除。 */
export const ATTACH_MODEL_OVERRIDE_HEADERS = [
  "x-model-provider",
  "x-model-key",
  "x-model-base-url",
  "x-model-flash",
  "x-model-pro",
  "x-model-tier",
  "x-model-protocol",
  "x-vision-key",
  "x-vision-base-url",
  "x-vision-model",
  "x-vision-protocol",
] as const;

/** M1 AttachRoutePolicy 对 renderer 开放的 method + path template 目录。 */
export const ATTACH_DATA_ROUTE_TEMPLATES = [
  ["GET", "/api/v1/home"],
  ["GET", "/api/v1/history"],
  ["GET", "/api/v1/history/:versionId"],
  ["POST", "/api/v1/commands"],
  ["GET", "/api/v1/events"],
  ["POST", "/api/v1/commit"],
  ["POST", "/api/v1/ask-more"],
  ["POST", "/api/v1/confirms/cancel"],
  ["POST", "/api/v1/confirms/decision"],
  ["POST", "/api/v1/upload"],
  ["GET", "/api/v1/files/:fileId"],
  ["GET", "/api/v1/files/:fileId/:filename"],
  ["GET", "/api/v1/materials/:materialId/text"],
  ["GET", "/api/v1/export/:sessionId"],
  ["GET", "/api/v1/skills"],
  ["GET", "/api/v1/capabilities"],
  ["GET", "/api/v1/settings/security"],
  ["GET", "/api/v1/settings/memory"],
  ["GET", "/api/v1/settings/credential-share"],
  ["GET", "/api/v1/settings/model"],
  ["GET", "/api/v1/settings/model/balance"],
  ["GET", "/api/v1/settings/search"],
  ["GET", "/api/v1/settings/search/primary"],
  ["GET", "/api/v1/usage/summary"],
  ["GET", "/api/v1/usage/docstats"],
  ["POST", "/api/v1/clientlog"],
] as const;

/** desktop M2 本期明确声明的能力；其余能力必须保持 false。 */
export const DESKTOP_ATTACH_CAPABILITIES: Readonly<AttachCapabilities> = Object.freeze({
  folderSelection: false,
  confirmGrant: false,
  diagnosticsExport: false,
  documentExport: false,
  sessionDeletion: false,
  credentialProvider: false,
  modelKeys: false,
  skillMutation: false,
  connectors: false,
  updates: false,
  templateMutation: false,
  derivativeMutation: false,
  lexiconMutation: false,
  deepLink: true,
  docEditing: true,
  review: true,
  assets: true,
});

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

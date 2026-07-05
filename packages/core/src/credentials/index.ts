// 沙箱凭据子系统统一入口。
// 录入走后端 API(前端设置页),密钥加密落库,不经过 LLM 上下文;
// 注入沙箱时由 sessionWorkspace 的 resolveCredentialEnv 钩子解密成 env。

export {
  saveCredentialRecord,
  getCredentialsForPlatform,
  getAllCredentialEnv,
  listCredentialMeta,
  deleteCredential,
  type CredentialInput,
  type CredentialMeta,
} from "./credentialsRepo.js";
export { redactSecret } from "./crypto.js";
export {
  PLATFORM_CREDENTIAL_SPECS,
  type PlatformCredentialSpec,
} from "./specs.js";

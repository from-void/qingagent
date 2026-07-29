// 沙箱凭据子系统统一入口。
// 录入走后端 API(前端设置页),密钥加密落库,不经过 LLM 上下文;
// 仅由命令 gate 对受信 node skill 脚本按次解密成 env，不进入沙箱基础环境。

export {
  saveCredentialRecord,
  getCredentialsForPlatform,
  getAllCredentialEnv,
  listCredentialMeta,
  deleteCredential,
  getConnectorCredentialBundle,
  deleteConnectorCredentialBundle,
  type CredentialInput,
  type CredentialMeta,
} from "./credentialsRepo.js";
export { redactSecret } from "./crypto.js";
export {
  initializeEnvironmentCredentialKeyProvider,
  initializeSafeStorageCredentialKeyProvider,
  setCredentialKeyProvider,
} from "./crypto.js";
export { verifyStoredCredentialCiphertextsWithKey } from "./credentialsRepo.js";
export {
  PLATFORM_CREDENTIAL_SPECS,
  type PlatformCredentialSpec,
} from "./specs.js";
// 命令行工具扫码登录失败的归因分档:把"扫码成功却存不下"与"用户没扫码"彻底分开。
export {
  credentialFailureNotice,
  diagnoseCredentialFailure,
  type CredentialFailureDiagnosis,
  type CredentialFailureKind,
  type CredentialFailureSignals,
} from "./credentialFailureDiagnosis.js";

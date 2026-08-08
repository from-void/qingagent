// 凭据加密:AES-256-GCM。env key 始终最高优先；其后由可注入 provider 提供
// OS keychain 包装或 chmod600 文件密钥。任何既有密钥/包装物损坏都 fail-closed，
// 绝不静默生成新 key 让旧密文永久不可解。

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { QINGAGENT_DATA_DIR } from "../workspace/sessionWorkspace.js";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ALGO = "aes-256-gcm";
const CIPHERTEXT_PREFIX = "qa-cred:v1:";
const KEY_ENVELOPE_KIND = "electron-safe-storage";

export type CredentialProtectionLevel =
  | "environment"
  | "os_keychain"
  | "local_file"
  | "unavailable";

export interface CredentialKeyProviderInfo {
  id: string;
  protectionLevel: CredentialProtectionLevel;
  reasonCode?: "credential_key_unavailable";
}

export interface CredentialKeyProvider {
  readonly info: CredentialKeyProviderInfo;
  resolveKey(): Buffer;
}

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

interface SafeStorageKeyEnvelopeV1 {
  version: 1;
  kind: typeof KEY_ENVELOPE_KIND;
  wrappedKey: string;
  createdAt: string;
}

export class CredentialKeyUnavailableError extends Error {
  readonly code = "credential_key_unavailable";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialKeyUnavailableError";
  }
}

let injectedProvider: CredentialKeyProvider | null = null;
let defaultFileProvider: CredentialKeyProvider | null = null;
let cachedKey: Buffer | null = null;
let cachedProviderInfo: CredentialKeyProviderInfo | null = null;

function credentialDataDir(): string {
  return process.env.QINGAGENT_DATA_DIR ?? QINGAGENT_DATA_DIR;
}

export function credentialKeyFilePath(dataDir = credentialDataDir()): string {
  return join(dataDir, ".cred-key");
}

export function credentialKeyEnvelopePath(dataDir = credentialDataDir()): string {
  return join(dataDir, ".cred-key.safe");
}

function decodeKeyBase64(value: string, source: string): Buffer {
  const trimmed = value.trim();
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== KEY_BYTES || key.toString("base64") !== trimmed) {
    throw new CredentialKeyUnavailableError(`${source} 不是合法的 ${KEY_BYTES} 字节 base64 密钥`);
  }
  return key;
}

function hardenPermissions(path: string): void {
  if (process.platform === "win32") return;
  try {
    const st = statSync(path);
    if ((st.mode & 0o077) !== 0) chmodSync(path, 0o600);
  } catch (cause) {
    throw new CredentialKeyUnavailableError(`无法校验凭据密钥文件权限: ${path}`, { cause });
  }
}

function writeNewFileDurably(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number | null = null;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
  } finally {
    if (fd !== null) closeSync(fd);
  }
  hardenPermissions(path);
  syncParentDirectory(path);
}

function syncParentDirectory(path: string): void {
  if (process.platform === "win32") return;
  let fd: number | null = null;
  try {
    fd = openSync(dirname(path), "r");
    fsyncSync(fd);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function atomicWriteNoReplace(path: string, contents: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    writeNewFileDurably(tempPath, contents);
    try {
      // 同目录 hard-link 是原子的且不会覆盖胜者；随后删临时名字，目标 inode 保留。
      linkSync(tempPath, path);
      hardenPermissions(path);
      // 目标目录项持久化后，调用方才可以删除上一份可恢复 key。
      syncParentDirectory(path);
      return true;
    } catch (cause) {
      const code = typeof cause === "object" && cause && "code" in cause ? String(cause.code) : "";
      if (code === "EEXIST") return false;
      throw cause;
    }
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function createFileCredentialKeyProvider(
  path = credentialKeyFilePath(),
): CredentialKeyProvider {
  let providerKey: Buffer | null = null;
  return {
    info: {
      id: "file-v1",
      protectionLevel: "local_file",
    },
    resolveKey(): Buffer {
      if (providerKey) return providerKey;
      if (existsSync(path)) {
        hardenPermissions(path);
        providerKey = decodeKeyBase64(readFileSync(path, "utf8"), `凭据密钥文件 ${path}`);
        return providerKey;
      }

      const generated = randomBytes(KEY_BYTES);
      try {
        writeNewFileDurably(path, generated.toString("base64"));
        providerKey = generated;
      } catch (cause) {
        const code = typeof cause === "object" && cause && "code" in cause ? String(cause.code) : "";
        if (code !== "EEXIST") throw cause;
        hardenPermissions(path);
        providerKey = decodeKeyBase64(readFileSync(path, "utf8"), `凭据密钥文件 ${path}`);
      }
      return providerKey;
    },
  };
}

function unavailableProvider(
  message: string,
  cause?: unknown,
  id = "unavailable",
): CredentialKeyProvider {
  return {
    info: {
      id,
      protectionLevel: "unavailable",
      reasonCode: "credential_key_unavailable",
    },
    resolveKey(): Buffer {
      throw new CredentialKeyUnavailableError(message, cause === undefined ? undefined : { cause });
    },
  };
}

function parseSafeStorageEnvelope(raw: string, path: string): SafeStorageKeyEnvelopeV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new CredentialKeyUnavailableError(`safeStorage 凭据密钥包装物损坏: ${path}`, { cause });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).version !== 1 ||
    (parsed as Record<string, unknown>).kind !== KEY_ENVELOPE_KIND ||
    typeof (parsed as Record<string, unknown>).wrappedKey !== "string" ||
    typeof (parsed as Record<string, unknown>).createdAt !== "string"
  ) {
    throw new CredentialKeyUnavailableError(`safeStorage 凭据密钥包装物格式不受支持: ${path}`);
  }
  return parsed as SafeStorageKeyEnvelopeV1;
}

function unwrapSafeStorageKey(
  envelope: SafeStorageKeyEnvelopeV1,
  safeStorage: SafeStorageAdapter,
): Buffer {
  try {
    const plaintext = safeStorage.decryptString(Buffer.from(envelope.wrappedKey, "base64"));
    return decodeKeyBase64(plaintext, "safeStorage 包装物");
  } catch (cause) {
    if (cause instanceof CredentialKeyUnavailableError) throw cause;
    throw new CredentialKeyUnavailableError("safeStorage 凭据密钥无法解包", { cause });
  }
}

export interface InitializeSafeStorageProviderOptions {
  safeStorage: SafeStorageAdapter;
  dataDir?: string;
  verifyKey?: (key: Buffer) => Promise<void>;
  now?: () => Date;
}

export interface InitializeEnvironmentProviderOptions {
  value: string;
  verifyKey?: (key: Buffer) => Promise<void>;
}

/** desktop/headless bootstrap 可先校验整库，再允许 env key 成为进程最高优先级。 */
export async function initializeEnvironmentCredentialKeyProvider(
  options: InitializeEnvironmentProviderOptions,
): Promise<CredentialKeyProvider> {
  try {
    const key = decodeKeyBase64(options.value, "QINGAGENT_CREDENTIAL_KEY");
    await options.verifyKey?.(key);
    return {
      info: {
        id: "env-v1",
        protectionLevel: "environment",
      },
      resolveKey: () => key,
    };
  } catch (cause) {
    return unavailableProvider("环境变量凭据密钥无法解开既有凭据", cause, "env-unavailable");
  }
}

/**
 * 初始化 desktop provider。升级顺序固定为：读旧文件同一枚 key → 验证旧密文 → 原子写包装物
 * → 重新解包比对 → 删除明文 key → 切 provider。包装物存在时绝不回退文件或另生新 key。
 */
export async function initializeSafeStorageCredentialKeyProvider(
  options: InitializeSafeStorageProviderOptions,
): Promise<CredentialKeyProvider> {
  const dataDir = options.dataDir ?? credentialDataDir();
  const keyPath = credentialKeyFilePath(dataDir);
  const envelopePath = credentialKeyEnvelopePath(dataDir);
  const envelopeExists = existsSync(envelopePath);

  if (!options.safeStorage.isEncryptionAvailable()) {
    if (envelopeExists) {
      return unavailableProvider("safeStorage 当前不可用，无法解包既有凭据密钥");
    }
    return createFileCredentialKeyProvider(keyPath);
  }

  if (envelopeExists) {
    try {
      const envelope = parseSafeStorageEnvelope(readFileSync(envelopePath, "utf8"), envelopePath);
      const key = unwrapSafeStorageKey(envelope, options.safeStorage);
      await options.verifyKey?.(key);
      // 上次可能在包装物落盘后、删明文 key 前退出；验证成功后完成清理。
      rmSync(keyPath, { force: true });
      return {
        info: {
          id: "electron-safe-storage-v1",
          protectionLevel: "os_keychain",
        },
        resolveKey: () => key,
      };
    } catch (cause) {
      return unavailableProvider("safeStorage 凭据密钥不可用", cause);
    }
  }

  const fileProvider = createFileCredentialKeyProvider(keyPath);
  let key: Buffer;
  try {
    key = fileProvider.resolveKey();
    await options.verifyKey?.(key);
  } catch (cause) {
    return unavailableProvider("旧文件凭据密钥校验失败", cause);
  }

  try {
    const wrappedKey = options.safeStorage.encryptString(key.toString("base64")).toString("base64");
    const envelope: SafeStorageKeyEnvelopeV1 = {
      version: 1,
      kind: KEY_ENVELOPE_KIND,
      wrappedKey,
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
    };
    atomicWriteNoReplace(envelopePath, `${JSON.stringify(envelope)}\n`);
    const winner = parseSafeStorageEnvelope(readFileSync(envelopePath, "utf8"), envelopePath);
    const winnerKey = unwrapSafeStorageKey(winner, options.safeStorage);
    if (!winnerKey.equals(key)) {
      return unavailableProvider("safeStorage 包装物并发胜者与既有文件密钥不一致");
    }
    rmSync(keyPath, { force: true });
    return {
      info: {
        id: "electron-safe-storage-v1",
        protectionLevel: "os_keychain",
      },
      resolveKey: () => winnerKey,
    };
  } catch (cause) {
    // 包装失败时保留已验证的旧文件 key，当前进程明确降级为 local_file。
    // 若包装物已经出现却不可读，下次会 fail-closed，不会静默另生 key。
    if (!existsSync(envelopePath)) return fileProvider;
    return unavailableProvider("safeStorage 凭据密钥包装失败", cause);
  }
}

export function setCredentialKeyProvider(provider: CredentialKeyProvider | null): void {
  injectedProvider = provider;
  cachedKey = null;
  cachedProviderInfo = null;
}

function envCredentialKeyProvider(): CredentialKeyProvider | null {
  const value = process.env.QINGAGENT_CREDENTIAL_KEY;
  if (!value) return null;
  const provider: CredentialKeyProvider = {
    info: {
      id: "env-v1",
      protectionLevel: "environment",
    },
    resolveKey: () => decodeKeyBase64(value, "QINGAGENT_CREDENTIAL_KEY"),
  };
  const envKey = provider.resolveKey();
  const filePath = credentialKeyFilePath();
  if (existsSync(filePath)) {
    const fileKey = decodeKeyBase64(readFileSync(filePath, "utf8"), `凭据密钥文件 ${filePath}`);
    if (!fileKey.equals(envKey)) {
      return unavailableProvider(
        "QINGAGENT_CREDENTIAL_KEY 与既有文件密钥不一致，禁止形成混合密钥库",
        undefined,
        "env-unavailable",
      );
    }
  } else if (existsSync(credentialKeyEnvelopePath())) {
    return unavailableProvider(
      "存在 safeStorage 包装物时必须先由 desktop adapter 校验环境变量密钥",
      undefined,
      "env-unavailable",
    );
  }
  return provider;
}

/** env 永远优先于注入 provider；结果进程级缓存。 */
export function resolveCredentialKey(): Buffer {
  if (cachedKey) return cachedKey;
  // 经 bootstrap 校验过的 env 决策（成功或 fail-closed）优先于原始 env 解析；
  // 普通 injected provider 仍不能越过环境变量。
  const injectedEnvironmentDecision =
    injectedProvider?.info.id === "env-v1" || injectedProvider?.info.id === "env-unavailable"
      ? injectedProvider
      : null;
  const provider = injectedEnvironmentDecision ??
    envCredentialKeyProvider() ??
    injectedProvider ??
    (defaultFileProvider ??= createFileCredentialKeyProvider());
  const key = provider.resolveKey();
  if (key.length !== KEY_BYTES) {
    throw new CredentialKeyUnavailableError(`provider ${provider.info.id} 返回了非法密钥长度`);
  }
  cachedKey = Buffer.from(key);
  cachedProviderInfo = provider.info;
  return cachedKey;
}

export function getCredentialKeyProviderInfo(): CredentialKeyProviderInfo {
  if (!cachedProviderInfo) resolveCredentialKey();
  return cachedProviderInfo!;
}

/** 仅测试用：重置密钥缓存与注入 provider。 */
export function __resetCredentialKeyForTest(): void {
  cachedKey = null;
  cachedProviderInfo = null;
  injectedProvider = null;
  defaultFileProvider = null;
}

export function encryptCredentialWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${CIPHERTEXT_PREFIX}${Buffer.concat([iv, authTag, ciphertext]).toString("base64")}`;
}

export function decryptCredentialWithKey(stored: string, key: Buffer): string {
  if (!stored.startsWith(CIPHERTEXT_PREFIX)) {
    throw new Error("凭据密文格式非法(版本不受支持)");
  }
  const encoded = stored.slice(CIPHERTEXT_PREFIX.length);
  const buf = Buffer.from(encoded, "base64");
  if (buf.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error("凭据密文格式非法(长度不足)");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function encryptCredential(plaintext: string): string {
  return encryptCredentialWithKey(plaintext, resolveCredentialKey());
}

export function decryptCredential(stored: string): string {
  return decryptCredentialWithKey(stored, resolveCredentialKey());
}

/** 凭据值脱敏:留首尾各 2 字符,中间打码。用于日志/观测/回执呈现。 */
export function redactSecret(value: string): string {
  if (value.length <= 6) return "***";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

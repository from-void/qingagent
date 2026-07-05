// 凭据加密:AES-256-GCM。密钥来源优先级:
//   1) QINGAGENT_CREDENTIAL_KEY 环境变量(base64 编码的 32 字节)——部署/生产设置
//   2) 机器级密钥文件 <QINGAGENT_DATA_DIR>/.cred-key(自动生成,权限 600,gitignore)
// 凭据明文绝不入库、不进日志/观测 span(脱敏见 redactSecret)。

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { QINGAGENT_DATA_DIR } from "../workspace/sessionWorkspace.js";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const ALGO = "aes-256-gcm";

let cachedKey: Buffer | null = null;

function keyFilePath(): string {
  return join(QINGAGENT_DATA_DIR, ".cred-key");
}

/** 解析或生成加密密钥(进程级缓存)。 */
export function resolveCredentialKey(): Buffer {
  if (cachedKey) return cachedKey;

  const envKey = process.env.QINGAGENT_CREDENTIAL_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, "base64");
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `QINGAGENT_CREDENTIAL_KEY 必须是 base64 编码的 ${KEY_BYTES} 字节(当前 ${buf.length} 字节)`,
      );
    }
    cachedKey = buf;
    return buf;
  }

  const path = keyFilePath();
  if (existsSync(path)) {
    // 非 Windows 下确保 600 权限:历史文件或外部拷贝可能 group/other 可读
    if (process.platform !== "win32") {
      try {
        const st = statSync(path);
        if ((st.mode & 0o077) !== 0) chmodSync(path, 0o600);
      } catch {
        // 权限修正失败不致命,继续
      }
    }
    const buf = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (buf.length === KEY_BYTES) {
      cachedKey = buf;
      return buf;
    }
    // 文件损坏:重新生成(旧密文将无法解密,等同重置凭据)
  }
  const generated = randomBytes(KEY_BYTES);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, generated.toString("base64"), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows 不支持 chmod,忽略
  }
  cachedKey = generated;
  return generated;
}

/** 仅测试用:重置密钥缓存。 */
export function __resetCredentialKeyForTest(): void {
  cachedKey = null;
}

/** 加密明文 → 存储串(base64: iv|authTag|ciphertext)。 */
export function encryptCredential(plaintext: string): string {
  const key = resolveCredentialKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/** 解密存储串 → 明文;格式非法或认证失败抛错。 */
export function decryptCredential(stored: string): string {
  const key = resolveCredentialKey();
  const buf = Buffer.from(stored, "base64");
  if (buf.length < IV_BYTES + 16) {
    throw new Error("凭据密文格式非法(长度不足)");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(IV_BYTES, IV_BYTES + 16);
  const ciphertext = buf.subarray(IV_BYTES + 16);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** 凭据值脱敏:留首尾各 2 字符,中间打码。用于日志/观测/回执呈现。 */
export function redactSecret(value: string): string {
  if (value.length <= 6) return "***";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetCredentialKeyForTest,
  CredentialKeyUnavailableError,
  createFileCredentialKeyProvider,
  credentialKeyEnvelopePath,
  credentialKeyFilePath,
  decryptCredentialWithKey,
  encryptCredentialWithKey,
  exportCredentialKeyForDowngrade,
  initializeEnvironmentCredentialKeyProvider,
  initializeSafeStorageCredentialKeyProvider,
  resolveCredentialKey,
} from "./crypto.js";

class FakeSafeStorage {
  constructor(
    private readonly available = true,
    private readonly prefix = "safe:",
  ) {}

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(plaintext: string): Buffer {
    return Buffer.from(`${this.prefix}${plaintext}`, "utf8");
  }

  decryptString(ciphertext: Buffer): string {
    const value = ciphertext.toString("utf8");
    if (!value.startsWith(this.prefix)) throw new Error("wrapper damaged");
    return value.slice(this.prefix.length);
  }
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qa-credential-crypto-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  __resetCredentialKeyForTest();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("credential key envelope", () => {
  it("旧库升级包装同一枚 .cred-key，验证旧密文后才切换并删除明文 key", async () => {
    const dataDir = tempDir();
    const oldKey = randomBytes(32);
    const oldCiphertext = encryptCredentialWithKey("legacy-secret", oldKey).replace(
      /^qa-cred:v1:/,
      "",
    );
    writeFileSync(credentialKeyFilePath(dataDir), oldKey.toString("base64"), { mode: 0o600 });
    let verified = false;

    const provider = await initializeSafeStorageCredentialKeyProvider({
      dataDir,
      safeStorage: new FakeSafeStorage(),
      now: () => new Date("2026-07-11T00:00:00.000Z"),
      verifyKey: async (key) => {
        expect(decryptCredentialWithKey(oldCiphertext, key)).toBe("legacy-secret");
        verified = true;
      },
    });

    expect(verified).toBe(true);
    expect(provider.info).toMatchObject({
      protectionLevel: "os_keychain",
      downgradePolicy: "export_before_downgrade",
    });
    expect(provider.resolveKey().equals(oldKey)).toBe(true);
    expect(existsSync(credentialKeyEnvelopePath(dataDir))).toBe(true);
    expect(existsSync(credentialKeyFilePath(dataDir))).toBe(false);
    expect(JSON.parse(readFileSync(credentialKeyEnvelopePath(dataDir), "utf8"))).toMatchObject({
      version: 1,
      kind: "electron-safe-storage",
      createdAt: "2026-07-11T00:00:00.000Z",
    });
  });

  it("已有包装物但 safeStorage 不可用时 fail-closed，不回退文件或生成新 key", async () => {
    const dataDir = tempDir();
    writeFileSync(
      credentialKeyEnvelopePath(dataDir),
      JSON.stringify({
        version: 1,
        kind: "electron-safe-storage",
        wrappedKey: "c2FmZQ==",
        createdAt: "2026-07-11T00:00:00.000Z",
      }),
    );
    const provider = await initializeSafeStorageCredentialKeyProvider({
      dataDir,
      safeStorage: new FakeSafeStorage(false),
    });

    expect(provider.info).toMatchObject({
      protectionLevel: "unavailable",
      reasonCode: "credential_key_unavailable",
    });
    expect(() => provider.resolveKey()).toThrowError(
      expect.objectContaining({ code: "credential_key_unavailable" }),
    );
    expect(existsSync(credentialKeyFilePath(dataDir))).toBe(false);
  });

  it("包装物损坏时显式 credential_key_unavailable，即使旧文件仍在也不旁路", async () => {
    const dataDir = tempDir();
    const oldKey = randomBytes(32);
    writeFileSync(credentialKeyFilePath(dataDir), oldKey.toString("base64"), { mode: 0o600 });
    writeFileSync(credentialKeyEnvelopePath(dataDir), "{bad-json", { mode: 0o600 });
    const provider = await initializeSafeStorageCredentialKeyProvider({
      dataDir,
      safeStorage: new FakeSafeStorage(),
    });

    expect(provider.info.reasonCode).toBe("credential_key_unavailable");
    expect(() => provider.resolveKey()).toThrow(CredentialKeyUnavailableError);
    expect(readFileSync(credentialKeyFilePath(dataDir), "utf8").trim()).toBe(
      oldKey.toString("base64"),
    );
  });

  it("没有包装物且 safeStorage 不可用时明确回退 chmod600 文件 provider", async () => {
    const dataDir = tempDir();
    const provider = await initializeSafeStorageCredentialKeyProvider({
      dataDir,
      safeStorage: new FakeSafeStorage(false),
    });

    expect(provider.info.protectionLevel).toBe("local_file");
    expect(provider.resolveKey()).toHaveLength(32);
    expect(existsSync(credentialKeyFilePath(dataDir))).toBe(true);
  });

  it("safeStorage provider 可显式原子恢复同一枚 .cred-key 供降级读取", async () => {
    const dataDir = tempDir();
    const oldKey = randomBytes(32);
    writeFileSync(credentialKeyFilePath(dataDir), oldKey.toString("base64"), { mode: 0o600 });
    const provider = await initializeSafeStorageCredentialKeyProvider({
      dataDir,
      safeStorage: new FakeSafeStorage(),
    });

    expect(existsSync(credentialKeyFilePath(dataDir))).toBe(false);
    const restoredPath = exportCredentialKeyForDowngrade(provider, dataDir);
    expect(restoredPath).toBe(credentialKeyFilePath(dataDir));
    expect(readFileSync(restoredPath, "utf8").trim()).toBe(oldKey.toString("base64"));
  });

  it("env key 切换前全库校验失败则显式 unavailable，禁止混合密钥写入", async () => {
    const oldKey = randomBytes(32);
    const oldCiphertext = encryptCredentialWithKey("existing", oldKey);
    const provider = await initializeEnvironmentCredentialKeyProvider({
      value: randomBytes(32).toString("base64"),
      verifyKey: async (candidate) => {
        decryptCredentialWithKey(oldCiphertext, candidate);
      },
    });

    expect(provider.info).toMatchObject({
      id: "env-unavailable",
      protectionLevel: "unavailable",
      reasonCode: "credential_key_unavailable",
    });
    expect(() => provider.resolveKey()).toThrow(CredentialKeyUnavailableError);
  });

  it("headless env key 与既有 .cred-key 不一致时也 fail-closed", () => {
    const dataDir = tempDir();
    const previousDataDir = process.env.QINGAGENT_DATA_DIR;
    const previousEnvKey = process.env.QINGAGENT_CREDENTIAL_KEY;
    writeFileSync(credentialKeyFilePath(dataDir), randomBytes(32).toString("base64"), {
      mode: 0o600,
    });
    process.env.QINGAGENT_DATA_DIR = dataDir;
    process.env.QINGAGENT_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    try {
      expect(() => resolveCredentialKey()).toThrowError(
        expect.objectContaining({ code: "credential_key_unavailable" }),
      );
    } finally {
      if (previousDataDir === undefined) delete process.env.QINGAGENT_DATA_DIR;
      else process.env.QINGAGENT_DATA_DIR = previousDataDir;
      if (previousEnvKey === undefined) delete process.env.QINGAGENT_CREDENTIAL_KEY;
      else process.env.QINGAGENT_CREDENTIAL_KEY = previousEnvKey;
      __resetCredentialKeyForTest();
    }
  });

  it("既有文件密钥损坏时文件 provider 禁止静默重生", () => {
    const dataDir = tempDir();
    const path = credentialKeyFilePath(dataDir);
    writeFileSync(path, "not-a-key", { mode: 0o600 });
    const provider = createFileCredentialKeyProvider(path);
    expect(() => provider.resolveKey()).toThrow(CredentialKeyUnavailableError);
    expect(readFileSync(path, "utf8")).toBe("not-a-key");
  });
});

import {
  chmodSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

export interface DesktopClientSafeStorage {
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

interface DesktopClientSecretStoreOptions {
  filePath: string;
  secretKeys: ReadonlySet<string>;
  safeStorage: DesktopClientSafeStorage;
}

export interface DesktopClientSecretStore {
  read(key: string): string | null;
  write(key: string, value: string | null): void;
  writeMany(entries: Iterable<readonly [string, string]>): void;
}

function writePrivateJson(file: string, value: Record<string, string>): void {
  // 临时文件 + rename 原子落盘，避免读到截断的半成品 JSON。
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "w",
  });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

export function createDesktopClientSecretStore(
  options: DesktopClientSecretStoreOptions,
): DesktopClientSecretStore {
  const readCiphertexts = (): Record<string, string> => {
    try {
      const parsed = JSON.parse(readFileSync(options.filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (options.secretKeys.has(key) && typeof value === "string") out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  };

  const assertSecretKey = (key: string): void => {
    if (!options.secretKeys.has(key)) throw new Error(`不允许写入非敏感配置键：${key}`);
  };

  const encrypt = (value: string): string =>
    options.safeStorage.encryptString(value).toString("base64");

  return {
    read(key) {
      assertSecretKey(key);
      const ciphertext = readCiphertexts()[key];
      return ciphertext
        ? options.safeStorage.decryptString(Buffer.from(ciphertext, "base64"))
        : null;
    },
    write(key, value) {
      assertSecretKey(key);
      const ciphertexts = readCiphertexts();
      if (value === null) delete ciphertexts[key];
      else ciphertexts[key] = encrypt(value);
      writePrivateJson(options.filePath, ciphertexts);
    },
    writeMany(entries) {
      const ciphertexts = readCiphertexts();
      for (const [key, value] of entries) {
        assertSecretKey(key);
        ciphertexts[key] = encrypt(value);
      }
      writePrivateJson(options.filePath, ciphertexts);
    },
  };
}

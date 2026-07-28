import {
  readPrivateStringMap,
  writePrivateStringMap,
} from "./privateJsonStore.js";

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
  writeWithRollback(key: string, value: string | null, commit: () => void): void;
  writeMany(entries: Iterable<readonly [string, string]>): void;
}

export function createDesktopClientSecretStore(
  options: DesktopClientSecretStoreOptions,
): DesktopClientSecretStore {
  const readCiphertexts = (): Record<string, string> => {
    return readPrivateStringMap(options.filePath);
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
      writePrivateStringMap(options.filePath, ciphertexts);
    },
    writeWithRollback(key, value, commit) {
      assertSecretKey(key);
      const ciphertexts = readCiphertexts();
      const hadPrevious = Object.hasOwn(ciphertexts, key);
      const previous = ciphertexts[key];
      if (value === null) delete ciphertexts[key];
      else ciphertexts[key] = encrypt(value);
      writePrivateStringMap(options.filePath, ciphertexts);

      try {
        commit();
      } catch (commitError) {
        try {
          const rollbackCiphertexts = readCiphertexts();
          if (hadPrevious && previous !== undefined) rollbackCiphertexts[key] = previous;
          else delete rollbackCiphertexts[key];
          writePrivateStringMap(options.filePath, rollbackCiphertexts);
        } catch (rollbackError) {
          throw new AggregateError(
            [commitError, rollbackError],
            "普通配置提交失败，且敏感配置补偿失败",
          );
        }
        throw commitError;
      }
    },
    writeMany(entries) {
      const ciphertexts = readCiphertexts();
      for (const [key, value] of entries) {
        assertSecretKey(key);
        ciphertexts[key] = encrypt(value);
      }
      writePrivateStringMap(options.filePath, ciphertexts);
    },
  };
}

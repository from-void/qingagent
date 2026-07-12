interface DesktopSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
  getSelectedStorageBackend?(): string;
}

interface DesktopCredentialEnv {
  [key: string]: string | undefined;
  QINGAGENT_CREDENTIAL_KEY?: string;
  QINGAGENT_CREDENTIAL_PROTECTION_LEVEL?: string;
  QINGAGENT_CREDENTIAL_KEY_STATUS?: string;
}

/** desktop main 专用装配；core/server 只接触解包后的 provider，不依赖 Electron。 */
export async function configureDesktopCredentialKeyProvider(options: {
  safeStorage: DesktopSafeStorage;
  dataDir: string;
  env?: DesktopCredentialEnv;
}): Promise<{ protectionLevel: string; reasonCode?: string }> {
  const env = options.env ?? process.env;
  const crypto = await import("@qingagent/core/credentials");
  const repo = crypto;

  if (env.QINGAGENT_CREDENTIAL_KEY) {
    const provider = await crypto.initializeEnvironmentCredentialKeyProvider({
      value: env.QINGAGENT_CREDENTIAL_KEY,
      verifyKey: repo.verifyStoredCredentialCiphertextsWithKey,
    });
    crypto.setCredentialKeyProvider(provider);
    env.QINGAGENT_CREDENTIAL_PROTECTION_LEVEL = provider.info.protectionLevel;
    if (provider.info.reasonCode) env.QINGAGENT_CREDENTIAL_KEY_STATUS = provider.info.reasonCode;
    else delete env.QINGAGENT_CREDENTIAL_KEY_STATUS;
    return {
      protectionLevel: provider.info.protectionLevel,
      ...(provider.info.reasonCode ? { reasonCode: provider.info.reasonCode } : {}),
    };
  }

  const safeStorage = {
    isEncryptionAvailable: () => {
      if (!options.safeStorage.isEncryptionAvailable()) return false;
      // getSelectedStorageBackend 是 Linux 语义；basic_text 只是明文混淆，不能标成 OS keychain。
      return (
        process.platform !== "linux" ||
        options.safeStorage.getSelectedStorageBackend?.() !== "basic_text"
      );
    },
    encryptString: (plaintext: string) => options.safeStorage.encryptString(plaintext),
    decryptString: (ciphertext: Buffer) => options.safeStorage.decryptString(ciphertext),
  };
  const provider = await crypto.initializeSafeStorageCredentialKeyProvider({
    safeStorage,
    dataDir: options.dataDir,
    verifyKey: repo.verifyStoredCredentialCiphertextsWithKey,
  });
  crypto.setCredentialKeyProvider(provider);
  env.QINGAGENT_CREDENTIAL_PROTECTION_LEVEL = provider.info.protectionLevel;
  if (provider.info.reasonCode) env.QINGAGENT_CREDENTIAL_KEY_STATUS = provider.info.reasonCode;
  else delete env.QINGAGENT_CREDENTIAL_KEY_STATUS;
  return {
    protectionLevel: provider.info.protectionLevel,
    ...(provider.info.reasonCode ? { reasonCode: provider.info.reasonCode } : {}),
  };
}

export interface ClientConfigSecretStore {
  write(key: string, value: string | null): void;
  writeWithRollback(key: string, value: string | null, commit: () => void): void;
}

export interface PersistClientConfigValueOptions {
  key: string;
  nextValue: string | null;
  isSecret: boolean;
  encryptionAvailable: boolean;
  migratePlaintextSecrets(): void;
  readConfig(): Record<string, string>;
  writeConfig(config: Record<string, string>): void;
  secretStore: ClientConfigSecretStore;
}

export function persistClientConfigValue(options: PersistClientConfigValueOptions): void {
  if (options.isSecret && options.nextValue !== null && !options.encryptionAvailable) {
    throw new Error("敏感配置加密不可用");
  }
  if (options.encryptionAvailable) options.migratePlaintextSecrets();

  const config = options.readConfig();
  if (options.isSecret) {
    const hasPlaintextValue = Object.hasOwn(config, options.key);
    if (!hasPlaintextValue) {
      options.secretStore.write(options.key, options.nextValue);
      return;
    }
    delete config[options.key];
    options.secretStore.writeWithRollback(options.key, options.nextValue, () => {
      options.writeConfig(config);
    });
    return;
  } else if (options.nextValue === null) {
    delete config[options.key];
  } else {
    config[options.key] = options.nextValue;
  }
  options.writeConfig(config);
}

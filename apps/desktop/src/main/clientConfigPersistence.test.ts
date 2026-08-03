import assert from "node:assert/strict";
import { test } from "node:test";
import {
  persistClientConfigValue,
  type ClientConfigSecretStore,
} from "./clientConfigPersistence.js";

function createSecretStore(initial: string | null): ClientConfigSecretStore & {
  value: string | null;
  rollbackCalls: number;
} {
  return {
    value: initial,
    rollbackCalls: 0,
    write(_key, value) {
      this.value = value;
    },
    writeWithRollback(_key, value, commit) {
      const previous = this.value;
      this.value = value;
      try {
        commit();
      } catch (error) {
        this.rollbackCalls += 1;
        this.value = previous;
        throw error;
      }
    },
  };
}

test("敏感配置无旧明文时只写密文文件", () => {
  const secretStore = createSecretStore("old-secret");
  let configWrites = 0;

  persistClientConfigValue({
    key: "secret",
    nextValue: "new-secret",
    isSecret: true,
    encryptionAvailable: true,
    migratePlaintextSecrets() {},
    readConfig: () => ({ theme: "paper" }),
    writeConfig() {
      configWrites += 1;
      throw new Error("普通配置文件不可写");
    },
    secretStore,
  });

  assert.equal(secretStore.value, "new-secret");
  assert.equal(configWrites, 0);
});

test("清理旧明文失败时补偿恢复旧密文", () => {
  const secretStore = createSecretStore("old-secret");

  assert.throws(
    () =>
      persistClientConfigValue({
        key: "secret",
        nextValue: null,
        isSecret: true,
        encryptionAvailable: false,
        migratePlaintextSecrets() {},
        readConfig: () => ({ secret: "legacy-plaintext", theme: "paper" }),
        writeConfig() {
          throw new Error("普通配置文件不可写");
        },
        secretStore,
      }),
    /普通配置文件不可写/,
  );

  assert.equal(secretStore.value, "old-secret");
  assert.equal(secretStore.rollbackCalls, 1);
});

test("硬件加速关闭值持久化到普通 clientConfig", () => {
  const secretStore = createSecretStore(null);
  let written: Record<string, string> | null = null;

  persistClientConfigValue({
    key: "qingagent.hardware_acceleration",
    nextValue: "false",
    isSecret: false,
    encryptionAvailable: false,
    migratePlaintextSecrets() {},
    readConfig: () => ({ theme: "paper" }),
    writeConfig(config) {
      written = config;
    },
    secretStore,
  });

  assert.deepEqual(written, {
    theme: "paper",
    "qingagent.hardware_acceleration": "false",
  });
});

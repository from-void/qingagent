import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDesktopClientSecretStore } from "./clientSecretStore.js";
import {
  readPrivateStringMap,
  writePrivateStringMap,
} from "./privateJsonStore.js";

function createStore(filePath: string) {
  return createDesktopClientSecretStore({
    filePath,
    secretKeys: new Set(["secret-a", "secret-b"]),
    safeStorage: {
      encryptString: (plaintext) => Buffer.from(`encrypted:${plaintext}`, "utf8"),
      decryptString: (ciphertext) => ciphertext.toString("utf8").slice("encrypted:".length),
    },
  });
}

test("配置文件损坏时单键写入失败并原样保留源文件", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qingagent-private-json-corrupt-"));
  const file = path.join(dir, "client-config.secrets.json");
  const source = "{broken";
  writeFileSync(file, source, "utf8");

  try {
    const store = createStore(file);
    assert.throws(() => store.write("secret-a", "new-value"));
    assert.equal(readFileSync(file, "utf8"), source);
    assert.equal(existsSync(`${file}.bak`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("配置文件瞬时读取错误时禁止写回", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qingagent-private-json-io-"));
  const file = path.join(dir, "client-config.secrets.json");
  mkdirSync(file);

  try {
    const store = createStore(file);
    assert.throws(() => store.write("secret-a", "new-value"));
    assert.equal(statSync(file).isDirectory(), true);
    assert.equal(existsSync(`${file}.bak`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("覆盖配置前保留权限受限备份，并保留未知字符串键", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qingagent-private-json-backup-"));
  const file = path.join(dir, "client-config.secrets.json");
  const original = {
    "secret-a": Buffer.from("encrypted:old-value").toString("base64"),
    "future-secret": "future-ciphertext",
  };
  writePrivateStringMap(file, original);

  try {
    const store = createStore(file);
    store.write("secret-b", "new-value");

    const current = readPrivateStringMap(file);
    assert.equal(current["secret-a"], original["secret-a"]);
    assert.equal(current["future-secret"], "future-ciphertext");
    assert.equal(
      Buffer.from(current["secret-b"] ?? "", "base64").toString("utf8"),
      "encrypted:new-value",
    );
    assert.deepEqual(readPrivateStringMap(`${file}.bak`), original);
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(`${file}.bak`).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

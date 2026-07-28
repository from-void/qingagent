import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDesktopClientSecretStore } from "./clientSecretStore.js";

test("跨文件提交失败时按原始密文补偿，无需解密旧值", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "qingagent-secret-store-"));
  try {
    const filePath = path.join(tempDir, "secrets.json");
    let decryptCalls = 0;
    const store = createDesktopClientSecretStore({
      filePath,
      secretKeys: new Set(["secret"]),
      safeStorage: {
        encryptString: (value) => Buffer.from(`encrypted:${value}`),
        decryptString: () => {
          decryptCalls += 1;
          throw new Error("当前环境无法解密");
        },
      },
    });
    store.write("secret", "old-value");
    const before = readFileSync(filePath, "utf8");

    assert.throws(
      () =>
        store.writeWithRollback("secret", null, () => {
          throw new Error("普通配置文件不可写");
        }),
      /普通配置文件不可写/,
    );

    assert.equal(readFileSync(filePath, "utf8"), before);
    assert.equal(decryptCalls, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

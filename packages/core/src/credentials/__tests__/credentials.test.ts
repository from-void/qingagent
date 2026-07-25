import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetCredentialKeyForTest,
  decryptCredential,
  encryptCredential,
  redactSecret,
} from "../crypto.js";
import {
  deleteCredential,
  getAllCredentialEnv,
  getCredentialsForPlatform,
  listCredentialMeta,
  saveCredentialRecord,
  saveConnectorCredentialBundle,
} from "../credentialsRepo.js";
import { PLATFORM_CREDENTIAL_SPECS, type PlatformCredentialSpec } from "../specs.js";
import { __resetDocumentsClientForTest, getDocumentsClient } from "@qingagent/db";
import { __resetMigrationsForTest } from "@qingagent/db";

// 沙箱凭据子系统:加密往返 + 加密存储 + env 注入 + 脱敏

let tempDir: string;
const TEST_PLATFORM_SPEC: PlatformCredentialSpec = {
  platform: "test-platform",
  label: "测试平台",
  fields: [
    { key: "PLATFORM_API_KEY", label: "API Key", secret: false },
    { key: "PLATFORM_API_SECRET", label: "API Secret", secret: true },
  ],
  helpUrl: "https://example.test/credentials",
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "qingagent-cred-"));
  process.env.DATABASE_URL = `file:${join(tempDir, "cred.db")}`;
  // 固定密钥避免依赖机器密钥文件
  process.env.QINGAGENT_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetCredentialKeyForTest();
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  PLATFORM_CREDENTIAL_SPECS.push(TEST_PLATFORM_SPEC);
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.QINGAGENT_CREDENTIAL_KEY;
  __resetCredentialKeyForTest();
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  const testSpecIndex = PLATFORM_CREDENTIAL_SPECS.indexOf(TEST_PLATFORM_SPEC);
  if (testSpecIndex >= 0) PLATFORM_CREDENTIAL_SPECS.splice(testSpecIndex, 1);
  rmSync(tempDir, { recursive: true, force: true });
});

describe("crypto 加密往返", () => {
  it("encrypt→decrypt 还原明文,密文每次不同(随机 iv)", () => {
    const plain = "cli_a1b2c3SECRETtoken";
    const enc1 = encryptCredential(plain);
    const enc2 = encryptCredential(plain);
    expect(enc1).not.toBe(enc2); // 随机 iv
    expect(decryptCredential(enc1)).toBe(plain);
    expect(decryptCredential(enc2)).toBe(plain);
  });
  it("密文里不含明文片段", () => {
    const enc = encryptCredential("VERY-SECRET-TOKEN-123456");
    expect(enc).not.toContain("SECRET");
    expect(enc).not.toContain("123456");
  });
  it("篡改密文导致解密失败(GCM 认证)", () => {
    const enc = encryptCredential("abc");
    const tampered = enc.slice(0, -4) + (enc.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(() => decryptCredential(tampered)).toThrow();
  });
  it("非法 base64 key 报错", () => {
    process.env.QINGAGENT_CREDENTIAL_KEY = "short";
    __resetCredentialKeyForTest();
    expect(() => encryptCredential("x")).toThrow(/32 字节/);
  });
});

describe("redactSecret 脱敏", () => {
  it("长值留首尾打码,短值全打码", () => {
    expect(redactSecret("cli_abcdef123456")).toBe("cl***56");
    expect(redactSecret("short")).toBe("***");
  });
});

describe("credentialsRepo 存取与注入", () => {
  it("保存→读取该平台凭据(解密)", async () => {
    await saveCredentialRecord({ platform: "test-platform", key: "PLATFORM_API_KEY", value: "app_x" });
    await saveCredentialRecord({ platform: "test-platform", key: "PLATFORM_API_SECRET", value: "sec_y" });
    const creds = await getCredentialsForPlatform("test-platform");
    expect(creds).toEqual({ PLATFORM_API_KEY: "app_x", PLATFORM_API_SECRET: "sec_y" });
  });

  it("upsert:同键覆盖不重复", async () => {
    await saveCredentialRecord({ platform: "test-platform", key: "PLATFORM_API_SECRET", value: "old" });
    await saveCredentialRecord({ platform: "test-platform", key: "PLATFORM_API_SECRET", value: "new" });
    const creds = await getCredentialsForPlatform("test-platform");
    expect(creds.PLATFORM_API_SECRET).toBe("new");
    expect(await listCredentialMeta()).toHaveLength(1);
  });

  it("getAllCredentialEnv 只注入仍登记在 spec 的平台和字段", async () => {
    await saveCredentialRecord({ platform: "feishu", key: "FEISHU_APP_ID", value: "cli_x" });
    await saveCredentialRecord({ platform: "test-platform", key: "PLATFORM_API_SECRET", value: "tok" });
    await saveCredentialRecord({ platform: "test-platform", key: "UNKNOWN_TOKEN", value: "bad" });
    const env = await getAllCredentialEnv();
    expect(env).toEqual({ PLATFORM_API_SECRET: "tok" });
  });

  it("getAllCredentialEnv 不注入 connector namespace，非连接器凭据仍正常注入", async () => {
    await saveConnectorCredentialBundle("wechat-mp", {
      cookie: "secret-cookie",
      token: "secret-token",
    });
    await saveCredentialRecord({
      platform: "test-platform",
      key: "PLATFORM_API_KEY",
      value: "app-key",
    });

    const env = await getAllCredentialEnv();

    expect(env).toEqual({ PLATFORM_API_KEY: "app-key" });
    expect(env).not.toHaveProperty("bundle");
  });

  it("listCredentialMeta 不含明文,可解密标 status:ok", async () => {
    await saveCredentialRecord({ platform: "feishu", key: "FEISHU_APP_ID", value: "legacy" });
    await saveCredentialRecord({ platform: "test-platform", key: "PLATFORM_API_SECRET", value: "topsecret" });
    const meta = await listCredentialMeta();
    expect(meta).toHaveLength(1);
    expect(meta[0]).toMatchObject({ platform: "test-platform", key: "PLATFORM_API_SECRET", status: "ok" });
    expect(JSON.stringify(meta)).not.toContain("topsecret");
    expect(JSON.stringify(meta)).not.toContain("FEISHU_APP_ID");
  });

  it("密钥轮换后解不开的凭据 meta 标 status:invalid(不假显示已配置)", async () => {
    await saveCredentialRecord({ platform: "test-platform", key: "PLATFORM_API_SECRET", value: "tok" });
    process.env.QINGAGENT_CREDENTIAL_KEY = Buffer.alloc(32, 9).toString("base64");
    __resetCredentialKeyForTest();
    const meta = await listCredentialMeta();
    expect(meta[0]!.status).toBe("invalid");
  });

  it("删除单键 / 删除整平台", async () => {
    await saveCredentialRecord({ platform: "test-platform", key: "A", value: "1" });
    await saveCredentialRecord({ platform: "test-platform", key: "B", value: "2" });
    await deleteCredential("test-platform", "A");
    expect(Object.keys(await getCredentialsForPlatform("test-platform"))).toEqual(["B"]);
    await deleteCredential("test-platform");
    expect(await getCredentialsForPlatform("test-platform")).toEqual({});
  });

  it("启动清理迁移幂等删除 legacy feishu 凭据", async () => {
    const client = getDocumentsClient();
    await client.execute(
      `CREATE TABLE sandbox_credentials (
        scope       TEXT NOT NULL DEFAULT 'default',
        platform    TEXT NOT NULL,
        cred_key    TEXT NOT NULL,
        value_enc   TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (scope, platform, cred_key)
      )`,
    );
    await client.execute({
      sql: `INSERT INTO sandbox_credentials (scope, platform, cred_key, value_enc, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        "default",
        "feishu",
        "FEISHU_APP_ID",
        encryptCredential("cli_x"),
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ],
    });
    const before = await client.execute(
      "SELECT COUNT(*) AS n FROM sandbox_credentials WHERE platform = 'feishu'",
    );
    expect(Number(before.rows[0]?.n ?? 0)).toBe(1);

    __resetMigrationsForTest();
    expect(await getAllCredentialEnv()).toEqual({});
    expect(await getCredentialsForPlatform("feishu")).toEqual({});

    __resetMigrationsForTest();
    await expect(listCredentialMeta()).resolves.toEqual([]);
  });

  it("密钥变化后旧密文解不开则跳过(不毁整组)", async () => {
    await saveCredentialRecord({ platform: "test-platform", key: "PLATFORM_API_SECRET", value: "tok" });
    // 换密钥
    process.env.QINGAGENT_CREDENTIAL_KEY = Buffer.alloc(32, 9).toString("base64");
    __resetCredentialKeyForTest();
    const env = await getAllCredentialEnv();
    expect(env).toEqual({}); // 解不开,跳过,不抛错
  });
});

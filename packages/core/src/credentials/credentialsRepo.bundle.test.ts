import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitTransaction, getDocumentsClient, withTransaction } from "@qingagent/db";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "@qingagent/db/testing";
import { __resetCredentialKeyForTest } from "./crypto.js";
import {
  ConnectorCredentialCasError,
  deleteConnectorCredentialBundle,
  getConnectorCredentialBundle,
  readThroughMigrateConnectorBundle,
  saveConnectorCredentialBundle,
  saveCredentialRecordsBatch,
} from "./credentialsRepo.js";
import {
  markWechatSessionNeedsReauth,
  readWechatCredentialBundle,
  WECHAT_LEGACY_CREDENTIAL_KEYS,
} from "../connectors/wechatCredentials.js";

let db: TempDocumentsDb;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  db = prepareTempDocumentsDb("qa-connector-bundle-");
  process.env.QINGAGENT_CREDENTIAL_KEY = randomBytes(32).toString("base64");
  __resetCredentialKeyForTest();
});

afterEach(() => {
  __resetCredentialKeyForTest();
  delete process.env.QINGAGENT_CREDENTIAL_KEY;
  db.cleanup();
});

async function seedWechatLegacy(): Promise<void> {
  await saveCredentialRecordsBatch([
    { platform: "wechat", key: "cookie", value: "old-cookie" },
    { platform: "wechat", key: "expiry", value: "2026-07-12T00:00:00.000Z" },
    { platform: "wechat", key: "mp_name", value: "旧账号" },
    { platform: "wechat", key: "token", value: "old-token" },
  ]);
}

const legacyKeys = ["cookie", "expiry", "mp_name", "token"] as const;

describe("connector credential bundle", () => {
  it("微信 read-through 覆盖有旧无新/仅新/有新有旧，且 legacy 兼容窗口保留", async () => {
    await seedWechatLegacy();
    const migrated = await readWechatCredentialBundle();
    expect(migrated).toMatchObject({ revision: 1, payload: { strategy: "qr-session", version: 1, account: "旧账号", cookie: "old-cookie", token: "old-token" } });
    const legacyCount = await getDocumentsClient().execute({ sql: "SELECT COUNT(*) AS n FROM sandbox_credentials WHERE platform = 'wechat'", args: [] });
    expect(Number(legacyCount.rows[0]?.n)).toBe(4);

    const newest = await saveConnectorCredentialBundle("wechat-mp", { strategy: "qr-session", version: 1, account: "新账号", cookie: "new", token: "new-token", expiry: "2099-01-01T00:00:00.000Z" });
    await expect(readWechatCredentialBundle()).resolves.toEqual(newest);
  });

  it("微信 legacy 缺单 key 不生成 bundle，迁移可在补齐后重入", async () => {
    await saveCredentialRecordsBatch([
      { platform: "wechat", key: "cookie", value: "c" },
      { platform: "wechat", key: "expiry", value: "2099-01-01T00:00:00.000Z" },
      { platform: "wechat", key: "mp_name", value: "账号" },
    ]);
    await expect(readWechatCredentialBundle()).resolves.toBeNull();
    await saveCredentialRecordsBatch([{ platform: "wechat", key: "token", value: "t" }]);
    await expect(readWechatCredentialBundle()).resolves.toMatchObject({ revision: 1, payload: { token: "t" } });
  });

  it("微信会话失效状态持久化到对应 revision 的 bundle", async () => {
    const first = await saveConnectorCredentialBundle("wechat-mp", {
      strategy: "qr-session" as const,
      version: 1 as const,
      account: "测试账号",
      cookie: "old-cookie",
      token: "old-token",
      expiry: "2099-01-01T00:00:00.000Z",
    });

    await markWechatSessionNeedsReauth(
      first.revision,
      new Date("2026-07-11T12:00:00.000Z"),
    );

    await expect(readWechatCredentialBundle()).resolves.toMatchObject({
      revision: first.revision,
      payload: {
        sessionIssue: {
          reasonCode: "needs_reauth",
          lastCheckedAt: "2026-07-11T12:00:00.000Z",
        },
      },
    });

    const reconnected = await saveConnectorCredentialBundle("wechat-mp", {
      ...first.payload,
      cookie: "new-cookie",
      token: "new-token",
    });
    await markWechatSessionNeedsReauth(
      first.revision,
      new Date("2026-07-11T13:00:00.000Z"),
    );
    await expect(readWechatCredentialBundle()).resolves.toEqual(reconnected);
  });

  it("bundle 单行版本化写入，CAS 成功递增且冲突为 409", async () => {
    const first = await saveConnectorCredentialBundle(
      "github",
      { token: "one" },
      { expectedRevision: null },
    );
    expect(first).toMatchObject({ version: 1, connectorId: "github", revision: 1 });
    const second = await saveConnectorCredentialBundle(
      "github",
      { token: "two" },
      { expectedRevision: 1 },
    );
    expect(second.revision).toBe(2);
    await expect(
      saveConnectorCredentialBundle("github", { token: "stale" }, { expectedRevision: 1 }),
    ).rejects.toMatchObject({
      code: "CONNECTOR_CREDENTIAL_CAS_MISMATCH",
      status: 409,
      expectedRevision: 1,
      actualRevision: 2,
    } satisfies Partial<ConnectorCredentialCasError>);
    await expect(getConnectorCredentialBundle("github")).resolves.toEqual(second);

    const raw = await getDocumentsClient().execute({
      sql: "SELECT COUNT(*) AS n FROM sandbox_credentials WHERE platform = ? AND cred_key = ?",
      args: ["connector:github", "bundle"],
    });
    expect(Number(raw.rows[0]?.n)).toBe(1);
  });

  it("并发顺序 A：连接页事务先读旧 key，agent 新写排队后最终不得被旧回填覆盖", async () => {
    await seedWechatLegacy();
    const blockerEntered = deferred();
    const releaseBlocker = deferred();
    const blocker = withTransaction(async () => {
      blockerEntered.resolve();
      await releaseBlocker.promise;
      return commitTransaction(undefined);
    });
    await blockerEntered.promise;
    const migration = readThroughMigrateConnectorBundle({
      connectorId: "wechat-mp",
      legacyPlatform: "wechat",
      legacyKeys,
      migrate: (legacy) => ({ ...legacy, source: "legacy" }),
    });
    const agentWrite = saveConnectorCredentialBundle("wechat-mp", {
      cookie: "new-cookie",
      token: "new-token",
      source: "agent",
    });
    releaseBlocker.resolve();
    await Promise.all([blocker, migration, agentWrite]);

    await expect(getConnectorCredentialBundle("wechat-mp")).resolves.toMatchObject({
      revision: 2,
      payload: { cookie: "new-cookie", token: "new-token", source: "agent" },
    });
  });

  it("并发顺序 B：agent 新 bundle 先落库，连接页 read-through 不执行旧迁移", async () => {
    await seedWechatLegacy();
    const blockerEntered = deferred();
    const releaseBlocker = deferred();
    const blocker = withTransaction(async () => {
      blockerEntered.resolve();
      await releaseBlocker.promise;
      return commitTransaction(undefined);
    });
    await blockerEntered.promise;
    const agentWrite = saveConnectorCredentialBundle("wechat-mp", {
      cookie: "new-cookie",
      source: "agent",
    });
    let migrateCalls = 0;
    const migration = readThroughMigrateConnectorBundle({
      connectorId: "wechat-mp",
      legacyPlatform: "wechat",
      legacyKeys,
      migrate: () => {
        migrateCalls += 1;
        return { source: "legacy" };
      },
    });
    releaseBlocker.resolve();
    const [, , result] = await Promise.all([blocker, agentWrite, migration]);

    expect(migrateCalls).toBe(0);
    expect(result.migrated).toBe(false);
    expect(result.bundle?.payload).toEqual({ cookie: "new-cookie", source: "agent" });
  });

  it("迁移中断回滚，不留下部分 bundle，legacy key 保持完整", async () => {
    await seedWechatLegacy();
    await expect(
      readThroughMigrateConnectorBundle({
        connectorId: "wechat-mp",
        legacyPlatform: "wechat",
        legacyKeys,
        migrate: () => {
          throw new Error("simulated interruption");
        },
      }),
    ).rejects.toThrow("simulated interruption");
    await expect(getConnectorCredentialBundle("wechat-mp")).resolves.toBeNull();
    const count = await getDocumentsClient().execute({
      sql: "SELECT COUNT(*) AS n FROM sandbox_credentials WHERE platform = 'wechat'",
      args: [],
    });
    expect(Number(count.rows[0]?.n)).toBe(4);
  });

  it("损坏单 legacy key 时 fail-closed，不用残缺集合生成 bundle", async () => {
    await seedWechatLegacy();
    await getDocumentsClient().execute({
      sql: "UPDATE sandbox_credentials SET value_enc = 'broken' WHERE platform = 'wechat' AND cred_key = 'token'",
      args: [],
    });
    await expect(
      readThroughMigrateConnectorBundle({
        connectorId: "wechat-mp",
        legacyPlatform: "wechat",
        legacyKeys,
        migrate: (legacy) => legacy,
      }),
    ).rejects.toThrow();
    await expect(getConnectorCredentialBundle("wechat-mp")).resolves.toBeNull();
  });

  it("disconnect 删除携带 revision CAS，迟到删除不得抹掉并发重连", async () => {
    await seedWechatLegacy();
    const first = await saveConnectorCredentialBundle("wechat-mp", { token: "old" });
    const reconnected = await saveConnectorCredentialBundle("wechat-mp", { token: "new" });
    await expect(
      deleteConnectorCredentialBundle("wechat-mp", { expectedRevision: first.revision, legacy: { platform: "wechat", keys: WECHAT_LEGACY_CREDENTIAL_KEYS } }),
    ).rejects.toMatchObject({
      code: "CONNECTOR_CREDENTIAL_CAS_MISMATCH",
      actualRevision: reconnected.revision,
    });
    await expect(getConnectorCredentialBundle("wechat-mp")).resolves.toEqual(reconnected);
    await expect(getDocumentsClient().execute({ sql: "SELECT COUNT(*) AS n FROM sandbox_credentials WHERE platform = 'wechat'", args: [] })).resolves.toMatchObject({ rows: [expect.objectContaining({ n: 4 })] });
    await deleteConnectorCredentialBundle("wechat-mp", { expectedRevision: reconnected.revision, legacy: { platform: "wechat", keys: WECHAT_LEGACY_CREDENTIAL_KEYS } });
    await expect(getConnectorCredentialBundle("wechat-mp")).resolves.toBeNull();
    const legacy = await getDocumentsClient().execute({ sql: "SELECT COUNT(*) AS n FROM sandbox_credentials WHERE platform = 'wechat'", args: [] });
    expect(Number(legacy.rows[0]?.n)).toBe(0);
  });

  it("无 bundle 的 disconnect 也以 expectedRevision=null 原子清 legacy，授权 write guard 可拦截迟到写", async () => {
    await seedWechatLegacy();
    await deleteConnectorCredentialBundle("wechat-mp", {
      expectedRevision: null,
      legacy: { platform: "wechat", keys: WECHAT_LEGACY_CREDENTIAL_KEYS },
    });
    const legacy = await getDocumentsClient().execute({
      sql: "SELECT COUNT(*) AS n FROM sandbox_credentials WHERE platform = 'wechat'",
      args: [],
    });
    expect(Number(legacy.rows[0]?.n)).toBe(0);
    await expect(saveConnectorCredentialBundle("wechat-mp", { token: "late" }, {
      writeGuard: () => false,
    })).rejects.toMatchObject({ code: "CONNECTOR_CREDENTIAL_WRITE_CANCELLED", status: 409 });
    await expect(getConnectorCredentialBundle("wechat-mp")).resolves.toBeNull();
  });

  it("重新授权可原子覆盖无法解密的 bundle", async () => {
    await saveConnectorCredentialBundle("wechat-mp", { token: "old" });
    await getDocumentsClient().execute({
      sql: "UPDATE sandbox_credentials SET value_enc = 'broken' WHERE platform = ? AND cred_key = ?",
      args: ["connector:wechat-mp", "bundle"],
    });
    await expect(getConnectorCredentialBundle("wechat-mp")).rejects.toThrow();

    const repaired = await saveConnectorCredentialBundle(
      "wechat-mp",
      { token: "new" },
      { expectedRevision: null },
    );

    expect(repaired).toMatchObject({ revision: 1, payload: { token: "new" } });
    await expect(getConnectorCredentialBundle("wechat-mp")).resolves.toEqual(repaired);
  });

  it("disconnect 可删除无法解密的 bundle 与 legacy 凭据", async () => {
    await seedWechatLegacy();
    await saveConnectorCredentialBundle("wechat-mp", { token: "old" });
    await getDocumentsClient().execute({
      sql: "UPDATE sandbox_credentials SET value_enc = 'broken' WHERE platform = ? AND cred_key = ?",
      args: ["connector:wechat-mp", "bundle"],
    });

    await deleteConnectorCredentialBundle("wechat-mp", {
      expectedRevision: null,
      legacy: { platform: "wechat", keys: WECHAT_LEGACY_CREDENTIAL_KEYS },
    });

    await expect(getConnectorCredentialBundle("wechat-mp")).resolves.toBeNull();
    const rows = await getDocumentsClient().execute({
      sql: "SELECT COUNT(*) AS n FROM sandbox_credentials WHERE platform IN (?, ?)",
      args: ["connector:wechat-mp", "wechat"],
    });
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });
});

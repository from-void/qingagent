import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "@qingagent/db";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "@qingagent/db/testing";
import { __resetCredentialKeyForTest } from "./crypto.js";
import {
  ConnectorCredentialCasError,
  deleteConnectorCredentialBundle,
  getConnectorCredentialBundle,
  saveConnectorCredentialBundle,
} from "./credentialsRepo.js";
import {
  markWechatSessionNeedsReauth,
  readWechatCredentialBundle,
} from "../connectors/wechatCredentials.js";

let db: TempDocumentsDb;

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

describe("connector credential bundle", () => {
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

  it("disconnect 删除携带 revision CAS，迟到删除不得抹掉并发重连", async () => {
    const first = await saveConnectorCredentialBundle("wechat-mp", { token: "old" });
    const reconnected = await saveConnectorCredentialBundle("wechat-mp", { token: "new" });
    await expect(
      deleteConnectorCredentialBundle("wechat-mp", { expectedRevision: first.revision }),
    ).rejects.toMatchObject({
      code: "CONNECTOR_CREDENTIAL_CAS_MISMATCH",
      actualRevision: reconnected.revision,
    });
    await expect(getConnectorCredentialBundle("wechat-mp")).resolves.toEqual(reconnected);
    await deleteConnectorCredentialBundle("wechat-mp", { expectedRevision: reconnected.revision });
    await expect(getConnectorCredentialBundle("wechat-mp")).resolves.toBeNull();
  });

  it("无 bundle 的 disconnect 接受 expectedRevision=null，授权 write guard 可拦截迟到写", async () => {
    await deleteConnectorCredentialBundle("wechat-mp", { expectedRevision: null });
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

  it("disconnect 可删除无法解密的 bundle", async () => {
    await saveConnectorCredentialBundle("wechat-mp", { token: "old" });
    await getDocumentsClient().execute({
      sql: "UPDATE sandbox_credentials SET value_enc = 'broken' WHERE platform = ? AND cred_key = ?",
      args: ["connector:wechat-mp", "bundle"],
    });

    await deleteConnectorCredentialBundle("wechat-mp", {
      expectedRevision: null,
    });

    await expect(getConnectorCredentialBundle("wechat-mp")).resolves.toBeNull();
    const rows = await getDocumentsClient().execute({
      sql: "SELECT COUNT(*) AS n FROM sandbox_credentials WHERE platform = ?",
      args: ["connector:wechat-mp"],
    });
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });
});

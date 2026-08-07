import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";
import {
  getProviderBalanceComparison,
  recordProviderBalanceSnapshot,
} from "../providerBalanceRepo.js";

let db: TempDocumentsDb;

beforeEach(() => {
  db = prepareTempDocumentsDb("qingagent-provider-balance-");
});

afterEach(() => db.cleanup());

describe("providerBalanceRepo", () => {
  it("按 credential fingerprint 隔离 key 轮换前后的账户快照", async () => {
    await recordProviderBalanceSnapshot({
      provider: "deepseek",
      credentialFingerprint: "fingerprint-a",
      balanceCny: 20,
      ts: "2026-08-08T00:00:00.000Z",
    });
    await recordProviderBalanceSnapshot({
      provider: "deepseek",
      credentialFingerprint: "fingerprint-b",
      balanceCny: 99,
      ts: "2026-08-08T00:30:00.000Z",
    });
    await recordProviderBalanceSnapshot({
      provider: "deepseek",
      credentialFingerprint: "fingerprint-a",
      balanceCny: 18.5,
      ts: "2026-08-08T01:00:00.000Z",
    });

    expect(await getProviderBalanceComparison("deepseek", "fingerprint-a")).toEqual({
      provider: "deepseek",
      credentialFingerprint: "fingerprint-a",
      latestBalanceCny: 18.5,
      latestAt: "2026-08-08T01:00:00.000Z",
      previousBalanceCny: 20,
      changeCny: -1.5,
    });
    expect(await getProviderBalanceComparison("deepseek", "fingerprint-b")).toEqual({
      provider: "deepseek",
      credentialFingerprint: "fingerprint-b",
      latestBalanceCny: 99,
      latestAt: "2026-08-08T00:30:00.000Z",
    });
  });
});

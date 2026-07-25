import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendConfirmAuditEvent,
  createConfirmGrant,
  createConfirmGrantCanonical,
  createConfirmGrantWithResult,
  getConfirmGrant,
  getConfirmGrantState,
  listConfirmAuditEvents,
  listConfirmGrantEvents,
  listConfirmGrants,
  revokeConfirmGrant,
  revokeConfirmGrantWithState,
} from "../confirmGrantRepo.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-confirm-grants-"); });
afterEach(() => db.cleanup());

describe("confirm grant 与不可变审计仓储", () => {
  it("创建与撤销 grant 时在同一事务追加生命周期事件", async () => {
    const created = await createConfirmGrant({
      kind: "install",
      source: "card",
      grantId: "grant-install",
      now: "2026-07-21T01:00:00.000Z",
    });
    expect(await getConfirmGrant("install")).toEqual(created);
    expect(await listConfirmGrants()).toEqual([created]);

    const duplicate = await createConfirmGrant({
      kind: "install",
      source: "settings",
      grantId: "must-not-replace",
    });
    expect(duplicate).toEqual(created);

    expect(await createConfirmGrantWithResult({
      kind: "install",
      source: "settings",
      grantId: "still-must-not-replace",
    })).toEqual({ grant: created, created: false });
    expect(await listConfirmGrantEvents()).toMatchObject([
      {
        grantId: "grant-install",
        kind: "install",
        action: "created",
        source: "card",
        subjectId: "local-user",
      },
    ]);

    expect(await revokeConfirmGrant(
      "install",
      "settings",
      "2026-07-21T02:00:00.000Z",
    )).toEqual(created);
    expect(await getConfirmGrant("install")).toBeNull();
    expect(await listConfirmGrantEvents()).toMatchObject([
      { grantId: "grant-install", action: "created", source: "card" },
      {
        grantId: "grant-install",
        action: "revoked",
        source: "settings",
        subjectId: "local-user",
      },
    ]);
  });

  it("决策审计只追加脱敏预览与绑定字段", async () => {
    await appendConfirmAuditEvent({
      eventId: "audit-1",
      ts: "2026-07-21T03:00:00.000Z",
      eventType: "decision_finished",
      subjectId: "local-user",
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: "tool-1",
      confirmId: "confirm-1",
      kind: "command",
      commandDigest: "digest-1",
      commandPreview: "curl Authorization: [REDACTED]",
      decision: "accepted",
      source: "stored-grant",
      grantId: "grant-command",
      result: "accepted",
      policyVersion: "command-policy-v1",
      isolationEpoch: null,
      configHash: null,
    });

    expect(await listConfirmAuditEvents("session-1")).toEqual([{
      eventId: "audit-1",
      ts: "2026-07-21T03:00:00.000Z",
      eventType: "decision_finished",
      subjectId: "local-user",
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: "tool-1",
      confirmId: "confirm-1",
      kind: "command",
      commandDigest: "digest-1",
      commandPreview: "curl Authorization: [REDACTED]",
      decision: "accepted",
      source: "stored-grant",
      grantId: "grant-command",
      result: "accepted",
      policyVersion: "command-policy-v1",
      isolationEpoch: null,
      configHash: null,
    }]);
  });

  it("并发 create→revoke 以撤销后的 canonical 终态收敛", async () => {
    const observed = await getConfirmGrantState("install");
    const [created, revoked] = await Promise.all([
      createConfirmGrantCanonical({
        kind: "install",
        source: "card",
        grantId: "grant-create-first",
        expectedRevocationEpoch: observed.revocationEpoch,
      }),
      revokeConfirmGrantWithState("install"),
    ]);

    expect(created.state).toMatchObject({ present: true, version: 1 });
    expect(revoked.state).toMatchObject({ present: false, grantId: null, version: 2 });
    expect(await getConfirmGrantState("install")).toMatchObject({
      present: false,
      grantId: null,
      version: 2,
      revocationEpoch: 2,
    });
  });

  it("并发 revoke→create 以较新的设置创建收敛", async () => {
    const [revoked, created] = await Promise.all([
      revokeConfirmGrantWithState("command"),
      createConfirmGrantCanonical({
        kind: "command",
        source: "settings",
        grantId: "grant-create-after-revoke",
      }),
    ]);

    expect(revoked.state).toMatchObject({ present: false, version: 1, revocationEpoch: 1 });
    expect(created).toMatchObject({ created: true, stale: false });
    expect(await getConfirmGrantState("command")).toMatchObject({
      present: true,
      grantId: "grant-create-after-revoke",
      version: 2,
      revocationEpoch: 1,
    });
  });

  it("撤销后到达的旧卡 callback 不能复活 grant", async () => {
    const oldCardState = await getConfirmGrantState("command");
    await revokeConfirmGrantWithState("command");

    const stale = await createConfirmGrantCanonical({
      kind: "command",
      source: "card",
      grantId: "must-not-revive",
      expectedRevocationEpoch: oldCardState.revocationEpoch,
    });

    expect(stale).toMatchObject({
      grant: null,
      created: false,
      stale: true,
      state: { present: false, grantId: null, version: 1, revocationEpoch: 1 },
    });
    expect(await getConfirmGrant("command")).toBeNull();
  });
});

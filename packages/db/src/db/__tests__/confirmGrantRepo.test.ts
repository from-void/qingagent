import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendConfirmAuditEvent,
  createConfirmGrant,
  createConfirmGrantWithResult,
  getConfirmGrant,
  listConfirmAuditEvents,
  listConfirmGrantEvents,
  listConfirmGrants,
  revokeConfirmGrant,
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
});

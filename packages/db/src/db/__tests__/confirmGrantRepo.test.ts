import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendConfirmAuditEvent,
  createConfirmGrantCanonical,
  getConfirmGrantState,
  listConfirmAuditEvents,
  listConfirmCancellationTombstones,
  revokeConfirmGrantWithState,
} from "../confirmGrantRepo.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-confirm-grants-"); });
afterEach(() => db.cleanup());

describe("confirm grant 与不可变审计仓储", () => {
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

  it("仅把 request-cancelled 审计暴露为取消墓碑", async () => {
    const base = {
      subjectId: "local-user",
      sessionId: "session-cancelled",
      runId: "run-1",
      toolCallId: "tool-1",
      confirmId: "confirm-1",
      kind: "command" as const,
      commandDigest: "digest-1",
      commandPreview: "mv a b",
      source: "ui" as const,
      grantId: null,
      policyVersion: "command-policy-v1",
      isolationEpoch: null,
      configHash: null,
    };
    await appendConfirmAuditEvent({
      ...base,
      eventId: "audit-cancelled",
      ts: "2026-07-21T03:00:00.000Z",
      eventType: "decision_failed",
      decision: "failed",
      result: "request-cancelled",
    });
    await appendConfirmAuditEvent({
      ...base,
      eventId: "audit-other-failure",
      ts: "2026-07-21T03:01:00.000Z",
      eventType: "decision_failed",
      decision: "failed",
      result: "failed",
    });

    expect(await listConfirmCancellationTombstones("session-cancelled")).toEqual([{
      sessionId: "session-cancelled",
      toolCallId: "tool-1",
      confirmId: "confirm-1",
    }]);
  });

  it("settings 创建与撤销 grant 会在同一事务写入统一审计账本", async () => {
    await createConfirmGrantCanonical({
      kind: "command",
      source: "settings",
      grantId: "grant-settings-command",
      now: "2026-07-21T04:00:00.000Z",
    });
    await revokeConfirmGrantWithState(
      "command",
      "settings",
      "2026-07-21T05:00:00.000Z",
    );

    expect(await listConfirmAuditEvents("settings")).toMatchObject([
      {
        eventType: "grant_created",
        subjectId: "local-user",
        kind: "command",
        source: "settings",
        grantId: "grant-settings-command",
        result: "grant-created",
      },
      {
        eventType: "grant_revoked",
        subjectId: "local-user",
        kind: "command",
        source: "settings",
        grantId: "grant-settings-command",
        result: "grant-revoked",
      },
    ]);
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
    expect(await getConfirmGrantState("command")).toMatchObject({
      present: false,
      grantId: null,
    });
  });

  it("设置写入的 expectedVersion 在事务内拒绝旧版本撤销", async () => {
    const created = await createConfirmGrantCanonical({
      kind: "send",
      source: "settings",
      grantId: "grant-current-send",
      expectedVersion: 0,
      expectedRevocationEpoch: 0,
    });
    expect(created).toMatchObject({ stale: false, state: { version: 1, present: true } });

    const stale = await revokeConfirmGrantWithState(
      "send",
      "settings",
      undefined,
      undefined,
      0,
    );
    expect(stale).toMatchObject({
      stale: true,
      revokedGrant: null,
      state: { version: 1, present: true, grantId: "grant-current-send" },
    });
    expect(await getConfirmGrantState("send")).toMatchObject({
      present: true,
      grantId: "grant-current-send",
    });
  });
});

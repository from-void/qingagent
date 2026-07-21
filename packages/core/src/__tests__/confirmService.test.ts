import { describe, expect, it, vi } from "vitest";
import type { ConfirmSpec } from "@qingagent/contract-ts";
import type { ConfirmGrant } from "@qingagent/db";
import { createSession } from "../session/sessionState.js";
import { ConfirmDecisionError, ConfirmService } from "../confirm/confirmService.js";
import { SecretLeaseStore } from "../confirm/secretLeaseStore.js";
import { consumeApprovalProof } from "../confirm/approvalProof.js";

const secretSpec: ConfirmSpec = {
  id: "confirm-secret",
  kind: "connect",
  title: "连接服务",
  say: "请输入访问凭据",
  widget: { type: "secretInput", placeholder: "访问凭据" },
  footHint: "仅用于本次连接",
  primaryLabel: "连接",
  secondaryLabel: "取消",
};

describe("ConfirmService", () => {
  it("P2-6 回归:安全后台命令无显式 timeout 时不生成确认卡", async () => {
    const state = createSession("confirm-background-default-ttl");
    const service = new ConfirmService({
      createId: () => "confirm-background-id",
      persist: async () => undefined,
    });
    const result = await service.requestCommandConfirm({
      state,
      runId: "run-background",
      toolCallId: "tool-background",
      toolName: "mastra_workspace_execute_command",
      args: { command: "echo ready", background: true },
      aborted: false,
    });
    expect(result).toEqual({ ok: false, reason: "确认请求与当前命令策略不匹配" });
    expect(state.pendingConfirms.size).toBe(0);
  });

  it("PendingConfirm 持久化失败时不发卡、不保留 pending", async () => {
    const state = createSession("confirm-persist-fail");
    const service = new ConfirmService({
      createId: () => "confirm-id",
      persist: async () => { throw new Error("db unavailable"); },
    });
    const result = await service.requestCommandConfirm({
      state,
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: "mastra_workspace_execute_command",
      args: { command: "mv draft.txt final.txt" },
      aborted: false,
    });
    expect(result.ok).toBe(false);
    expect(state.pendingConfirms.size).toBe(0);
  });

  it("secret sentinel 只存在 SecretLeaseStore，单次 take 后销毁", async () => {
    const sentinel = "SECRET_SENTINEL_9f3d2b7a";
    const state = createSession("confirm-secret-sentinel");
    const secrets = new SecretLeaseStore();
    const persisted: string[] = [];
    const service = new ConfirmService({
      secrets,
      persist: async (current) => {
        persisted.push(JSON.stringify([...current.pendingConfirms.values()]));
      },
    });
    const pending = {
      confirmId: secretSpec.id,
      runId: "run-secret",
      toolCallId: "tool-secret",
      toolName: "connector",
      commandDigest: "digest",
      spec: secretSpec,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending" as const,
    };
    state.pendingConfirms.set(pending.toolCallId, pending);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    service.stageSecret(state, {
      confirmId: pending.confirmId,
      toolCallId: pending.toolCallId,
      value: sentinel,
    });
    await service.beginDecision(state, {
      sessionId: state.sessionId,
      toolCallId: pending.toolCallId,
      decisionId: "decision-secret",
      decision: { id: pending.confirmId, accepted: true },
      hasSecretValue: true,
    });

    expect(JSON.stringify(service.requestedFrame(pending))).not.toContain(sentinel);
    expect(JSON.stringify(state)).not.toContain(sentinel);
    expect(persisted.join("\n")).not.toContain(sentinel);
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(sentinel);
    expect(secrets.take(state, {
      confirmId: pending.confirmId,
      toolCallId: pending.toolCallId,
    })).toBe(sentinel);
    expect(secrets.take(state, {
      confirmId: pending.confirmId,
      toolCallId: pending.toolCallId,
    })).toBeNull();
    consoleSpy.mockRestore();
  });

  it("secretInput 空白 lease 与缺失 lease 均 fail-closed", async () => {
    for (const value of ["   ", null] as const) {
      const state = createSession(`confirm-secret-invalid-${value === null ? "missing" : "blank"}`);
      const secrets = new SecretLeaseStore();
      const service = new ConfirmService({ secrets, persist: async () => undefined });
      const pending = {
        confirmId: secretSpec.id,
        runId: "run-secret",
        toolCallId: "tool-secret",
        toolName: "connector",
        commandDigest: "digest",
        spec: secretSpec,
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        status: "pending" as const,
      };
      state.pendingConfirms.set(pending.toolCallId, pending);
      if (value !== null) {
        service.stageSecret(state, {
          confirmId: pending.confirmId,
          toolCallId: pending.toolCallId,
          value,
        });
      }
      await expect(service.beginDecision(state, {
        sessionId: state.sessionId,
        toolCallId: pending.toolCallId,
        decisionId: "decision-invalid",
        decision: { id: pending.confirmId, accepted: true },
        hasSecretValue: true,
      })).rejects.toMatchObject({ code: "invalid" } satisfies Partial<ConfirmDecisionError>);
    }
  });

  it("已完成 decisionId 的幂等重试会立即销毁重复提交的 secret lease", async () => {
    const state = createSession("confirm-secret-idempotent");
    const secrets = new SecretLeaseStore();
    const service = new ConfirmService({ secrets, persist: async () => undefined });
    const pending = {
      confirmId: secretSpec.id,
      runId: "run-secret",
      toolCallId: "tool-secret",
      toolName: "connector",
      commandDigest: "digest",
      spec: secretSpec,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending" as const,
    };
    state.pendingConfirms.set(pending.toolCallId, pending);
    const submission = {
      sessionId: state.sessionId,
      toolCallId: pending.toolCallId,
      decisionId: "decision-secret-repeat",
      decision: { id: pending.confirmId, accepted: true as const },
      hasSecretValue: true,
    };

    service.stageSecret(state, {
      confirmId: pending.confirmId,
      toolCallId: pending.toolCallId,
      value: "first-secret",
    });
    const begun = await service.beginDecision(state, submission);
    await service.finishDecision(state, begun.pending, submission.decisionId, "accepted");

    service.stageSecret(state, {
      confirmId: pending.confirmId,
      toolCallId: pending.toolCallId,
      value: "duplicate-secret",
    });
    await expect(service.beginDecision(state, submission)).resolves.toMatchObject({
      idempotent: true,
      resolution: "accepted",
    });
    expect(secrets.take(state, {
      confirmId: pending.confirmId,
      toolCallId: pending.toolCallId,
    })).toBeNull();
  });

  it("stored grant 保持 confirm 分类并为本次 digest 签发 fresh 一次性 proof", async () => {
    const state = createSession("confirm-stored-grant");
    const audits: Array<Record<string, unknown>> = [];
    const service = new ConfirmService({
      createId: () => "confirm-stored",
      persist: async () => undefined,
      loadGrant: async () => ({
        grantId: "grant-command",
        kind: "command",
        createdAt: "2026-07-21T00:00:00.000Z",
        source: "settings",
      }),
      appendAudit: async (event) => { audits.push(event); },
    });
    const result = await service.requestCommandConfirm({
      state,
      runId: "run-stored",
      toolCallId: "tool-stored",
      toolName: "mastra_workspace_execute_command",
      args: { command: "mv draft.txt final.txt" },
      aborted: false,
    });
    expect(result).toMatchObject({
      ok: true,
      storedGrantApproval: {
        decisionId: "stored-confirm-stored",
        grant: { grantId: "grant-command", kind: "command" },
      },
    });
    if (!result.ok || !result.storedGrantApproval) return;
    expect(result.frame).toBeUndefined();
    expect(result.pending).toMatchObject({
      status: "resuming",
      decisionSource: "stored-grant",
      decisionGrantId: "grant-command",
    });
    expect(consumeApprovalProof(state, {
      sessionId: state.sessionId,
      runId: "run-stored",
      toolCallId: "tool-stored",
      commandDigest: "wrong-digest",
    })).toBe(false);
    expect(consumeApprovalProof(state, {
      sessionId: state.sessionId,
      runId: "run-stored",
      toolCallId: "tool-stored",
      commandDigest: result.pending.commandDigest,
    })).toBe(false);
    expect(audits).toContainEqual(expect.objectContaining({
      eventType: "decision_started",
      source: "stored-grant",
      grantId: "grant-command",
      commandDigest: result.pending.commandDigest,
    }));

    const secondState = createSession("confirm-stored-grant-second");
    const second = await service.requestCommandConfirm({
      state: secondState,
      runId: "run-second",
      toolCallId: "tool-second",
      toolName: "mastra_workspace_execute_command",
      args: { command: "mv draft.txt final.txt" },
      aborted: false,
    });
    if (!second.ok || !second.storedGrantApproval) return;
    const proofInput = {
      sessionId: secondState.sessionId,
      runId: "run-second",
      toolCallId: "tool-second",
      commandDigest: second.pending.commandDigest,
    };
    expect(consumeApprovalProof(secondState, proofInput)).toBe(true);
    expect(consumeApprovalProof(secondState, proofInput)).toBe(false);
  });

  it("grant 撤销后下一条同类命令重新发确认卡", async () => {
    let activeGrant: ConfirmGrant | null = {
      grantId: "grant-before-revoke",
      kind: "command" as const,
      createdAt: "2026-07-21T00:00:00.000Z",
      source: "settings" as const,
    };
    const service = new ConfirmService({
      createId: (() => {
        let sequence = 0;
        return () => `confirm-${++sequence}`;
      })(),
      persist: async () => undefined,
      loadGrant: async () => activeGrant,
      appendAudit: async () => undefined,
    });
    const beforeRevoke = await service.requestCommandConfirm({
      state: createSession("grant-before-revoke"),
      runId: "run-before",
      toolCallId: "tool-before",
      toolName: "mastra_workspace_execute_command",
      args: { command: "mv before.txt after.txt" },
      aborted: false,
    });
    expect(beforeRevoke).toMatchObject({
      ok: true,
      storedGrantApproval: { grant: { grantId: "grant-before-revoke" } },
    });

    activeGrant = null;
    const afterRevoke = await service.requestCommandConfirm({
      state: createSession("grant-after-revoke"),
      runId: "run-after",
      toolCallId: "tool-after",
      toolName: "mastra_workspace_execute_command",
      args: { command: "mv next.txt final.txt" },
      aborted: false,
    });
    expect(afterRevoke).toMatchObject({
      ok: true,
      frame: { kind: "confirmRequested", data: { toolCallId: "tool-after" } },
    });
    if (afterRevoke.ok) expect(afterRevoke.storedGrantApproval).toBeUndefined();
  });

  it("grant 在首次读取后撤销时回滚 pending 并重新发确认卡", async () => {
    const state = createSession("grant-revoked-during-resume");
    const grant: ConfirmGrant = {
      grantId: "grant-race",
      kind: "command",
      createdAt: "2026-07-21T00:00:00.000Z",
      source: "settings",
    };
    const persistReasons: string[] = [];
    let reads = 0;
    const service = new ConfirmService({
      createId: () => "confirm-race",
      persist: async (_current, reason) => {
        persistReasons.push(reason);
      },
      loadGrant: async () => (++reads === 1 ? grant : null),
      appendAudit: async () => undefined,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await service.requestCommandConfirm({
      state,
      runId: "run-race",
      toolCallId: "tool-race",
      toolName: "mastra_workspace_execute_command",
      args: { command: "mv race.txt safe.txt" },
      aborted: false,
    });

    expect(result).toMatchObject({
      ok: true,
      frame: { kind: "confirmRequested", data: { toolCallId: "tool-race" } },
      pending: { status: "pending" },
    });
    if (!result.ok) return;
    expect(result.storedGrantApproval).toBeUndefined();
    expect(result.pending).not.toHaveProperty("decisionId");
    expect(result.pending).not.toHaveProperty("decisionGrantId");
    expect(persistReasons).toEqual([
      "confirm:requested",
      "confirm:stored-grant-resuming",
      "confirm:stored-grant-rollback",
    ]);
    expect(consumeApprovalProof(state, {
      sessionId: state.sessionId,
      runId: "run-race",
      toolCallId: "tool-race",
      commandDigest: result.pending.commandDigest,
    })).toBe(false);
    errorSpy.mockRestore();
  });

  it("stored grant 签发 proof 失败时回滚为可重新确认的 pending", async () => {
    const state = createSession("grant-proof-failure");
    const persistReasons: string[] = [];
    const grant: ConfirmGrant = {
      grantId: "grant-proof-failure",
      kind: "command",
      createdAt: "2026-07-22T00:00:00.000Z",
      source: "settings",
    };
    const service = new ConfirmService({
      createId: () => "proof-failure",
      persist: async (_current, reason) => { persistReasons.push(reason); },
      loadGrant: async () => grant,
      issueProof: () => { throw new Error("signer unavailable"); },
      appendAudit: async () => undefined,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await service.requestCommandConfirm({
      state,
      runId: "run-proof-failure",
      toolCallId: "tool-proof-failure",
      toolName: "mastra_workspace_execute_command",
      args: { command: "mv draft.txt final.txt" },
      aborted: false,
    });

    expect(result).toMatchObject({
      ok: true,
      pending: { status: "pending" },
      frame: { kind: "confirmRequested" },
    });
    expect(persistReasons).toEqual([
      "confirm:requested",
      "confirm:stored-grant-resuming",
      "confirm:stored-grant-rollback",
    ]);
    errorSpy.mockRestore();
  });

  it("stored grant proof 回滚持久化失败时保留 resuming 恢复标记且不发可点击卡", async () => {
    const state = createSession("grant-proof-rollback-failure");
    const grant: ConfirmGrant = {
      grantId: "grant-proof-rollback-failure",
      kind: "command",
      createdAt: "2026-07-22T00:00:00.000Z",
      source: "settings",
    };
    const service = new ConfirmService({
      createId: () => "proof-rollback-failure",
      persist: async (_current, reason) => {
        if (reason === "confirm:stored-grant-rollback") {
          throw new Error("snapshot unavailable");
        }
      },
      loadGrant: async () => grant,
      issueProof: () => { throw new Error("signer unavailable"); },
      appendAudit: async () => undefined,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await service.requestCommandConfirm({
      state,
      runId: "run-proof-rollback-failure",
      toolCallId: "tool-proof-rollback-failure",
      toolName: "mastra_workspace_execute_command",
      args: { command: "mv draft.txt final.txt" },
      aborted: false,
    });

    expect(result).toEqual({ ok: false, reason: "确认恢复失败，命令未执行" });
    expect(state.pendingConfirms.get("tool-proof-rollback-failure")).toMatchObject({
      status: "resuming",
      decisionSource: "stored-grant",
    });
    expect(result).not.toHaveProperty("frame");
    errorSpy.mockRestore();
  });

  it("UI、stored grant 与过期路径审计都保留来源、grantId 和 digest", async () => {
    const audits: Array<Record<string, unknown>> = [];
    const service = new ConfirmService({
      persist: async () => undefined,
      appendAudit: async (event) => { audits.push(event); },
    });
    const state = createSession("confirm-audit-lifecycle");
    const pending = {
      confirmId: "confirm-ui",
      runId: "run-ui",
      toolCallId: "tool-ui",
      toolName: "mastra_workspace_execute_command",
      commandDigest: "digest-ui",
      spec: {
        id: "confirm-ui",
        kind: "command" as const,
        title: "执行命令",
        say: "需要确认",
        commandPreview: "mv a.txt b.txt",
        footHint: "仅一次",
        primaryLabel: "执行",
        secondaryLabel: "取消",
      },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending" as const,
    };
    state.pendingConfirms.set(pending.toolCallId, pending);
    const begun = await service.beginDecision(state, {
      sessionId: state.sessionId,
      toolCallId: pending.toolCallId,
      decisionId: "decision-ui",
      decision: { id: pending.confirmId, accepted: true },
      hasSecretValue: false,
    });
    service.attachRememberedGrant(begun.pending, {
      grantId: "grant-ui",
      kind: "command",
      createdAt: "2026-07-21T00:00:00.000Z",
      source: "card",
    });
    await service.finishDecision(state, begun.pending, "decision-ui", "accepted");
    expect(audits).toContainEqual(expect.objectContaining({
      eventType: "decision_finished",
      source: "ui",
      grantId: "grant-ui",
      commandDigest: "digest-ui",
    }));

    const expiredState = createSession("confirm-audit-expired");
    const expired = {
      ...pending,
      confirmId: "confirm-expired",
      toolCallId: "tool-expired",
      commandDigest: "digest-expired",
      spec: { ...pending.spec, id: "confirm-expired" },
      status: "pending" as const,
    };
    expiredState.pendingConfirms.set(expired.toolCallId, expired);
    await service.expireDecision(expiredState, expired);
    expect(audits).toContainEqual(expect.objectContaining({
      eventType: "decision_expired",
      source: "expired",
      grantId: null,
      commandDigest: "digest-expired",
    }));

    const declinedState = createSession("confirm-audit-declined");
    const declined = {
      ...pending,
      confirmId: "confirm-declined",
      toolCallId: "tool-declined",
      commandDigest: "digest-declined",
      spec: { ...pending.spec, id: "confirm-declined" },
      status: "pending" as const,
    };
    declinedState.pendingConfirms.set(declined.toolCallId, declined);
    const declinedBegun = await service.beginDecision(declinedState, {
      sessionId: declinedState.sessionId,
      toolCallId: declined.toolCallId,
      decisionId: "decision-declined",
      decision: { id: declined.confirmId, accepted: false },
      hasSecretValue: false,
    });
    await service.finishDecision(
      declinedState,
      declinedBegun.pending,
      "decision-declined",
      "rejected",
    );
    expect(audits).toContainEqual(expect.objectContaining({
      eventType: "decision_finished",
      decision: "rejected",
      source: "ui",
      grantId: null,
      commandDigest: "digest-declined",
    }));
  });

  it("审计写失败只记错，不阻断 UI 决策流", async () => {
    const state = createSession("confirm-audit-failure");
    const service = new ConfirmService({
      persist: async () => undefined,
      appendAudit: async () => { throw new Error("audit unavailable"); },
    });
    const pending = {
      confirmId: "confirm-audit-failure",
      runId: "run-audit",
      toolCallId: "tool-audit",
      toolName: "mastra_workspace_execute_command",
      commandDigest: "digest-audit",
      spec: {
        id: "confirm-audit-failure",
        kind: "command" as const,
        title: "执行命令",
        say: "需要确认",
        footHint: "仅一次",
        primaryLabel: "执行",
        secondaryLabel: "取消",
      },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending" as const,
    };
    state.pendingConfirms.set(pending.toolCallId, pending);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(service.beginDecision(state, {
      sessionId: state.sessionId,
      toolCallId: pending.toolCallId,
      decisionId: "decision-audit",
      decision: { id: pending.confirmId, accepted: true },
      hasSecretValue: false,
    })).resolves.toMatchObject({ resolution: "accepted" });
    expect(errorSpy).toHaveBeenCalledWith(
      "[confirm-audit] append failed",
      expect.objectContaining({ eventType: "decision_started" }),
    );
    errorSpy.mockRestore();
  });
});

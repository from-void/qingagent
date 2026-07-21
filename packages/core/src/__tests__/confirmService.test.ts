import { describe, expect, it, vi } from "vitest";
import type { ConfirmSpec } from "@qingagent/contract-ts";
import { createSession } from "../session/sessionState.js";
import { ConfirmDecisionError, ConfirmService } from "../confirm/confirmService.js";
import { SecretLeaseStore } from "../confirm/secretLeaseStore.js";

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
});

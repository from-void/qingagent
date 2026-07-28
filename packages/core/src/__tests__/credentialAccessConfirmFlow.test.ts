import { describe, expect, it } from "vitest";
import { createSession } from "../session/sessionState.js";
import { ConfirmService } from "../confirm/confirmService.js";
import {
  credentialAccessDigest,
  REQUEST_CREDENTIAL_ACCESS_TOOL,
} from "../confirm/credentialAccessConfirmation.js";
import { credentialAccessIsCooling } from "../confirm/credentialAccessCooldown.js";
import { consumeApprovalProof } from "../confirm/approvalProof.js";

function service(): ConfirmService {
  return new ConfirmService({
    createId: () => "confirm-credential",
    persist: async () => undefined,
    loadGrantState: async (kind) => ({
      kind,
      present: false,
      grantId: null,
      version: 0,
      revocationEpoch: 0,
      grant: null,
    }),
    appendAudit: async () => undefined,
  });
}

const args = { path: "~/.fakecli", reason: "假 CLI 要读已有的登录" };

describe("按需授权走既有确认流水线", () => {
  it("申请挂起并发出 connect 确认卡", async () => {
    const state = createSession("credential-card");
    const result = await service().requestCommandConfirm({
      state,
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: REQUEST_CREDENTIAL_ACCESS_TOOL,
      args,
      aborted: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pending.spec.kind).toBe("connect");
    expect(result.pending.spec.sub).toBe("~/.fakecli");
    expect(result.pending.spec.say).toContain("命令行工具需要访问 ~/.fakecli");
    expect(result.pending.spec.rememberCategory?.kind).toBe("connect");
    // 摘要与真正执行时重算的必须一致,否则批准的和执行的可能不是同一份参数。
    expect(result.pending.commandDigest).toBe(credentialAccessDigest(state.sessionId, args));
  });

  it("非法路径不进入确认流水线", async () => {
    const state = createSession("credential-card-invalid");
    const result = await service().requestCommandConfirm({
      state,
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: REQUEST_CREDENTIAL_ACCESS_TOOL,
      args: { path: "~/Library/Keychains", reason: "r" },
      aborted: false,
    });
    expect(result).toEqual({ ok: false, reason: "确认请求与当前共享规则不匹配" });
    expect(state.pendingConfirms.size).toBe(0);
  });

  it("用户点允许后签发批准凭证,执行侧能核销", async () => {
    const state = createSession("credential-accept");
    const confirmService = service();
    const requested = await confirmService.requestCommandConfirm({
      state,
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: REQUEST_CREDENTIAL_ACCESS_TOOL,
      args,
      aborted: false,
    });
    expect(requested.ok).toBe(true);
    await confirmService.beginDecision(state, {
      sessionId: state.sessionId,
      toolCallId: "tool-1",
      decisionId: "decision-1",
      decision: { id: "confirm-credential", accepted: true },
      hasSecretValue: false,
    });
    expect(consumeApprovalProof(state, {
      sessionId: state.sessionId,
      runId: "run-1",
      toolCallId: "tool-1",
      commandDigest: credentialAccessDigest(state.sessionId, args),
    })).toBe(true);
    expect(credentialAccessIsCooling(state, "~/.fakecli")).toBe(false);
  });

  it("用户点暂不共享后同一位置进入冷却,不再重复弹卡骚扰", async () => {
    const state = createSession("credential-reject");
    const confirmService = service();
    await confirmService.requestCommandConfirm({
      state,
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: REQUEST_CREDENTIAL_ACCESS_TOOL,
      args,
      aborted: false,
    });
    await confirmService.beginDecision(state, {
      sessionId: state.sessionId,
      toolCallId: "tool-1",
      decisionId: "decision-1",
      decision: { id: "confirm-credential", accepted: false },
      hasSecretValue: false,
    });
    expect(credentialAccessIsCooling(state, "~/.fakecli")).toBe(true);
    // 没有批准凭证,执行侧核销必然失败。
    expect(consumeApprovalProof(state, {
      sessionId: state.sessionId,
      runId: "run-1",
      toolCallId: "tool-1",
      commandDigest: credentialAccessDigest(state.sessionId, args),
    })).toBe(false);
  });
});

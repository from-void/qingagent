import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import { createSession } from "@qingagent/core";
import { ConfirmDecisionError } from "@qingagent/core/confirm";
import { confirmRoutes, createConfirmRoutes } from "../routes/confirms";

const app = new Hono();
app.route("/api/v1", confirmRoutes);

describe("confirm decision route 入站防护", () => {
  it("reject 携带 secret 返回 400 且响应不回显 sentinel", async () => {
    const sentinel = "SECRET_SENTINEL_ROUTE_f6c2";
    const response = await app.request("/api/v1/confirms/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "s",
        toolCallId: "t",
        decisionId: "d",
        decision: { id: "c", accepted: false, secretValue: sentinel },
      }),
    });
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).not.toContain(sentinel);
    expect(body).toContain(
      "确认没有提交成功，命令尚未确定是否执行。请先查看命令卡，不要连续重复点击。",
    );
  });

  it("超限 body 拒绝，恶意 Origin 返回 403", async () => {
    const oversized = await app.request("/api/v1/confirms/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(16 * 1024 + 1),
    });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toEqual({
      error: "确认没有提交成功，命令尚未确定是否执行。请先查看命令卡，不要连续重复点击。",
    });

    const crossSite = await app.request("/api/v1/confirms/decision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        host: "localhost:8080",
      },
      body: "{}",
    });
    expect(crossSite.status).toBe(403);
  });

  it("确认已处理或失效时返回可行动说明", async () => {
    const unavailableApp = new Hono();
    unavailableApp.route("/api/v1", createConfirmRoutes({
      getSession: async () => undefined,
    }));
    const response = await unavailableApp.request("/api/v1/confirms/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-gone",
        toolCallId: "tool-gone",
        decisionId: "decision-gone",
        decision: { id: "confirm-gone", accepted: true },
      }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "这张确认已处理或已失效，请查看命令结果。",
    });
  });

  it("确认冲突不泄漏内部状态，提示先查看命令卡", async () => {
    const session = createSession("session-conflict");
    session.pendingConfirms.set("tool-conflict", {
      confirmId: "confirm-conflict",
      runId: "run-conflict",
      toolCallId: "tool-conflict",
      toolName: "mastra_workspace_execute_command",
      commandDigest: "digest-conflict",
      spec: {
        id: "confirm-conflict",
        kind: "command",
        title: "运行命令",
        say: "需要确认",
        commandPreview: "echo safe",
        primaryLabel: "确认执行",
        secondaryLabel: "取消",
      },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending",
    });
    const conflictApp = new Hono();
    conflictApp.route("/api/v1", createConfirmRoutes({
      getSession: async () => session,
      runExclusive: async (_sessionId, task) => {
        for await (const _frame of task()) { /* 完整消费 */ }
      },
      handleDecision: async function* () {
        throw new ConfirmDecisionError("conflict", "内部确认状态冲突");
      },
    }));
    const response = await conflictApp.request("/api/v1/confirms/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sessionId,
        toolCallId: "tool-conflict",
        decisionId: "decision-conflict",
        decision: { id: "confirm-conflict", accepted: true },
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "确认没有提交成功，命令尚未确定是否执行。请先查看命令卡，不要连续重复点击。",
    });
  });

  it("确认调用边界后的未知异常不再断言命令没有执行", async () => {
    const session = createSession("session-execution-unknown");
    const unknownApp = new Hono();
    unknownApp.route("/api/v1", createConfirmRoutes({
      getSession: async () => session,
      runExclusive: async () => {
        throw new Error("unknown failure after decision submission");
      },
    }));

    const response = await unknownApp.request("/api/v1/confirms/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sessionId,
        toolCallId: "tool-execution-unknown",
        decisionId: "decision-execution-unknown",
        decision: { id: "confirm-execution-unknown", accepted: true },
      }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "确认提交异常，命令执行状态未能确认；请先查看命令卡，不要重复提交。",
    });
  });

  it("确认续跑任务以 agentTurnDispatch 标记进入 SessionActor", async () => {
    const session = createSession("session-confirm-dispatch-marker");
    session.pendingConfirms.set("tool-confirm-dispatch-marker", {
      confirmId: "confirm-dispatch-marker",
      runId: "run-confirm-dispatch-marker",
      toolCallId: "tool-confirm-dispatch-marker",
      toolName: "mastra_workspace_execute_command",
      commandDigest: "digest-confirm-dispatch-marker",
      spec: {
        id: "confirm-dispatch-marker",
        kind: "command",
        title: "运行命令",
        say: "需要确认",
        commandPreview: "echo safe",
        primaryLabel: "确认执行",
        secondaryLabel: "取消",
      },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending",
    });
    const runExclusive = vi.fn(async (
      _sessionId: string,
      task: () => AsyncGenerator<BridgeFrame>,
      _options?: { agentTurnDispatch?: boolean },
    ) => {
      for await (const _frame of task()) { /* 完整消费 */ }
    });
    const markedApp = new Hono();
    markedApp.route("/api/v1", createConfirmRoutes({
      getSession: async () => session,
      runExclusive,
      handleDecision: async function* () {},
    }));

    const response = await markedApp.request("/api/v1/confirms/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sessionId,
        toolCallId: "tool-confirm-dispatch-marker",
        decisionId: "decision-confirm-dispatch-marker",
        decision: { id: "confirm-dispatch-marker", accepted: true },
      }),
    });

    expect(response.status).toBe(200);
    expect(runExclusive).toHaveBeenCalledWith(
      session.sessionId,
      expect.any(Function),
      { agentTurnDispatch: true },
    );
  });
});

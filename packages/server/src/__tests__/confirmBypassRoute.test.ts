// 确认卡上的「以后不用再问我」:勾选并批准后当场全局生效;没勾就什么都不变。
//
// 已经出现确认卡时,不勾选就只批准本次、全局档位不变。这里同时锁住"勾了才生效"和
// "串卡/未声明的卡不能借这条路关掉询问"。

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { BridgeFrame, ConfirmSpec } from "@qingagent/contract-ts";
import { createSession } from "@qingagent/core";
import { ConfirmService, type SafeSubmitConfirmDecision } from "@qingagent/core/confirm";
import type { ConfirmRuntimeDependencies } from "../gateway/confirmRuntime";
import { createConfirmRoutes } from "../routes/confirms";

function commandSpec(withBypassOption: boolean): ConfirmSpec {
  return {
    id: "confirm-a",
    kind: "command",
    title: "执行命令",
    say: "将执行命令",
    commandPreview: "rm -rf ./build",
    ...(withBypassOption
      ? {
          bypassOption: {
            label: "以后不用再问我",
            hint: "以后的命令会直接执行；可以在 设置 → 安全 里改回。",
          },
        }
      : {}),
    primaryLabel: "确认执行",
    secondaryLabel: "取消",
  };
}

function makeHarness(options: { withBypassOption?: boolean; writeFails?: boolean } = {}) {
  const session = createSession("session-a");
  const toolCallId = "tool-a";
  const pendingSpec = commandSpec(options.withBypassOption !== false);
  session.pendingConfirms.set(toolCallId, {
    confirmId: pendingSpec.id,
    runId: "run-a",
    toolCallId,
    toolName: "mastra_workspace_execute_command",
    commandDigest: "digest-a",
    spec: pendingSpec,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "pending",
  });
  const decisions: SafeSubmitConfirmDecision[] = [];
  const bypassWrites: boolean[] = [];
  const service = new ConfirmService({
    persist: async () => undefined,
    appendAudit: async (event) => event,
  });
  const decide = async function* (
    submission: SafeSubmitConfirmDecision,
    _dependencies: ConfirmRuntimeDependencies = {},
  ): AsyncGenerator<BridgeFrame> {
    decisions.push(submission);
  };
  const app = new Hono();
  app.route("/api/v1", createConfirmRoutes({
    getSession: async (sessionId) => sessionId === session.sessionId ? session : undefined,
    runExclusive: async (_sessionId, task) => {
      for await (const _frame of task()) {
        // 只需确认恢复生成器被完整消费。
      }
    },
    handleDecision: decide,
    service,
    consumeUiGrant: () => ({ ok: false, reason: "missing" as const }),
    insecureRememberAllowed: () => false,
    cancelCommand: vi.fn(() => false),
    applyBypass: async (enabled: boolean) => {
      bypassWrites.push(enabled);
      if (options.writeFails) throw new Error("write failed");
      return {
        enabled,
        enabledAt: enabled ? "2026-07-29T00:00:00.000Z" : null,
      };
    },
  }));
  return { app, session, toolCallId, pendingSpec, decisions, bypassWrites };
}

async function postDecision(
  harness: ReturnType<typeof makeHarness>,
  decision: Record<string, unknown>,
) {
  return harness.app.request("/api/v1/confirms/decision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: harness.session.sessionId,
      toolCallId: harness.toolCallId,
      decisionId: "decision-a",
      decision: { id: harness.pendingSpec.id, accepted: true, ...decision },
    }),
  });
}

describe("确认卡「以后不用再问我」路由", () => {
  it("不勾选就只批准本次，全局开关一动不动", async () => {
    const harness = makeHarness();
    const response = await postDecision(harness, {});

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, remembered: false });
    expect(harness.decisions).toHaveLength(1);
    expect(harness.bypassWrites).toEqual([]);
  });

  it("勾选并批准后当场生效，本次命令照常执行", async () => {
    const harness = makeHarness();
    const response = await postDecision(harness, { bypassAll: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accepted: true,
      bypassEnabled: true,
    });
    expect(harness.decisions).toHaveLength(1);
    expect(harness.bypassWrites).toEqual([true]);
  });

  it("拒绝时即使带上勾选也不生效", async () => {
    const harness = makeHarness();
    const response = await harness.app.request("/api/v1/confirms/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: harness.session.sessionId,
        toolCallId: harness.toolCallId,
        decisionId: "decision-a",
        decision: { id: harness.pendingSpec.id, accepted: false, bypassAll: true },
      }),
    });

    // accepted:false 携带 bypassAll 直接是非法请求体
    expect(response.status).toBe(400);
    expect(harness.bypassWrites).toEqual([]);
  });

  it("卡片没有声明这个勾选时不认账", async () => {
    const harness = makeHarness({ withBypassOption: false });
    const response = await postDecision(harness, { bypassAll: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, remembered: false });
    expect(harness.bypassWrites).toEqual([]);
  });

  it("串卡(confirmId 对不上)不能借这条路关掉询问", async () => {
    const harness = makeHarness();
    const response = await harness.app.request("/api/v1/confirms/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: harness.session.sessionId,
        toolCallId: harness.toolCallId,
        decisionId: "decision-a",
        decision: { id: "confirm-other", accepted: true, bypassAll: true },
      }),
    });

    // 真实链路里 beginDecision 会直接判 not_found；这里的替身只验证开关没被拨动。
    expect(harness.bypassWrites).toEqual([]);
    expect(await response.json()).not.toMatchObject({ bypassEnabled: true });
  });

  it("开关没存上时如实回报，本次操作仍然完成", async () => {
    const harness = makeHarness({ writeFails: true });
    const response = await postDecision(harness, { bypassAll: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accepted: true,
      bypassEnabled: false,
    });
    expect(harness.decisions).toHaveLength(1);
  });
});

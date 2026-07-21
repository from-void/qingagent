import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { BridgeFrame, ConfirmKind, ConfirmSpec } from "@qingagent/contract-ts";
import { createSession } from "@qingagent/core";
import { ConfirmService, type SafeSubmitConfirmDecision } from "@qingagent/core/confirm";
import type { ConfirmAuditEvent, ConfirmGrant } from "@qingagent/db";
import type { ConfirmRuntimeDependencies } from "../gateway/confirmRuntime";
import { ConfirmUiGrantStore } from "../lib/confirmUiGrant";
import { createConfirmRoutes } from "../routes/confirms";

type AuditInput = Omit<ConfirmAuditEvent, "eventId" | "ts">;

function spec(kind: ConfirmKind, id = "confirm-a"): ConfirmSpec {
  return {
    id,
    kind,
    title: "执行命令",
    say: "将执行命令",
    commandPreview: "pnpm test",
    ...(kind === "install" || kind === "command"
      ? { rememberCategory: { kind, label: "后续同类命令都默认同意" } }
      : {}),
    footHint: "仅执行本次",
    primaryLabel: "执行",
    secondaryLabel: "取消",
  };
}

function makeHarness(kind: ConfirmKind = "command") {
  const session = createSession("session-a");
  const toolCallId = "tool-a";
  const pendingSpec = spec(kind);
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
  const audits: AuditInput[] = [];
  const decisions: SafeSubmitConfirmDecision[] = [];
  const created: Array<{ kind: "install" | "command"; source: "card" }> = [];
  const service = new ConfirmService({
    persist: async () => undefined,
    appendAudit: async (event) => {
      audits.push(event);
      return event;
    },
  });
  let nonceSequence = 0;
  const grants = new ConfirmUiGrantStore({ createNonce: () => `nonce-${nonceSequence++}` });
  const decide = async function* (
    submission: SafeSubmitConfirmDecision,
    dependencies: ConfirmRuntimeDependencies = {},
  ): AsyncGenerator<BridgeFrame> {
    decisions.push(submission);
    const pending = session.pendingConfirms.get(submission.toolCallId);
    if (submission.decision.accepted && pending && dependencies.onAccepted) {
      await dependencies.onAccepted(pending);
    }
  };
  const app = new Hono();
  app.route("/api/v1", createConfirmRoutes({
    getSession: async (sessionId) => sessionId === session.sessionId ? session : undefined,
    runExclusive: async (_sessionId, task) => {
      for await (const _frame of task()) {
        // 测试路由只需确认恢复生成器被完整消费。
      }
    },
    handleDecision: decide,
    service,
    consumeUiGrant: (input) => grants.consume(input),
    insecureRememberAllowed: () => false,
    createGrant: async (input): Promise<ConfirmGrant> => {
      created.push(input);
      return {
        grantId: `grant-${created.length}`,
        kind: input.kind,
        source: input.source,
        createdAt: new Date().toISOString(),
      };
    },
  }));
  return { app, session, toolCallId, pendingSpec, audits, decisions, created, grants };
}

function decisionBody(harness: ReturnType<typeof makeHarness>, overrides: Record<string, unknown> = {}) {
  return {
    sessionId: harness.session.sessionId,
    toolCallId: harness.toolCallId,
    decisionId: "decision-a",
    decision: {
      id: harness.pendingSpec.id,
      accepted: true,
      remember: true,
      ...overrides,
    },
  };
}

async function postDecision(
  harness: ReturnType<typeof makeHarness>,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return harness.app.request("/api/v1/confirms/decision", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("确认记忆路由", () => {
  it.each([
    ["无 Origin 的 curl", {}],
    ["伪造同源 Origin", { origin: "http://localhost:8080", host: "localhost:8080" }],
  ])("%s 无 nonce 时只拒绝 remember，本次 decision 仍生效并审计", async (_label, headers) => {
    const harness = makeHarness();
    const response = await postDecision(harness, decisionBody(harness), headers);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, remembered: false });
    expect(harness.decisions).toHaveLength(1);
    expect(harness.created).toHaveLength(0);
    expect(harness.audits).toContainEqual(expect.objectContaining({
      eventType: "remember_rejected",
      source: "ui",
      grantId: null,
      commandDigest: "digest-a",
      result: "remember-rejected:missing",
    }));
  });

  it.each(["replay", "cross-confirm", "cross-session", "expired"])(
    "%s nonce 不落 grant，但本次 decision 仍生效",
    async (scenario) => {
      let now = 1_000;
      let nonceSequence = 0;
      const harness = makeHarness();
      const grants = new ConfirmUiGrantStore({
        now: () => now,
        createNonce: () => `case-nonce-${nonceSequence++}`,
      });
      const originalConsume = grants.consume.bind(grants);
      const consumeSpy = vi.spyOn(grants, "consume");
      const registered = grants.register({
        purpose: "confirm",
        sessionId: scenario === "cross-session" ? "session-b" : harness.session.sessionId,
        confirmId: scenario === "cross-confirm" ? "confirm-b" : harness.pendingSpec.id,
        kind: "command",
        ttlMs: scenario === "expired" ? 10 : 60_000,
      });
      if (scenario === "expired") now += 10;
      if (scenario === "replay") {
        expect(originalConsume({
          purpose: "confirm",
          nonce: registered,
          sessionId: harness.session.sessionId,
          confirmId: harness.pendingSpec.id,
          kind: "command",
        }).ok).toBe(true);
      }
      consumeSpy.mockImplementation(originalConsume);

      const routeApp = new Hono();
      routeApp.route("/api/v1", createConfirmRoutes({
        getSession: async () => harness.session,
        runExclusive: async (_sessionId, task) => {
          for await (const _frame of task()) { /* 完整消费 */ }
        },
        handleDecision: async function* (submission) {
          harness.decisions.push(submission);
        },
        service: new ConfirmService({
          persist: async () => undefined,
          appendAudit: async (event) => {
            harness.audits.push(event);
            return event;
          },
        }),
        consumeUiGrant: (input) => grants.consume(input),
        insecureRememberAllowed: () => false,
        createGrant: async (input) => ({
          grantId: "must-not-create",
          kind: input.kind,
          source: input.source,
          createdAt: new Date().toISOString(),
        }),
      }));
      harness.app = routeApp;

      const response = await postDecision(
        harness,
        decisionBody(harness, { uiGrantNonce: registered }),
      );
      expect(response.status).toBe(200);
      expect(harness.decisions).toHaveLength(1);
      expect(harness.audits.at(-1)).toEqual(expect.objectContaining({
        eventType: "remember_rejected",
        source: "ui",
        commandDigest: "digest-a",
        result: expect.stringMatching(/^remember-rejected:/),
      }));
    },
  );

  it.each(["send", "connect"] as const)("%s 携带 remember 时 hard reject", async (kind) => {
    const harness = makeHarness(kind);
    const response = await postDecision(harness, decisionBody(harness));

    expect(response.status).toBe(400);
    expect(harness.decisions).toHaveLength(0);
    expect(harness.created).toHaveLength(0);
    expect(harness.audits).toContainEqual(expect.objectContaining({
      eventType: "remember_rejected",
      kind,
      source: "ui",
      commandDigest: "digest-a",
      result: "remember-rejected:forbidden-kind",
    }));
  });

  it("匹配的一次性 nonce 只在 accepted 后落 card grant，decline 不落 grant", async () => {
    const accepted = makeHarness();
    const nonce = accepted.grants.register({
      purpose: "confirm",
      sessionId: accepted.session.sessionId,
      confirmId: accepted.pendingSpec.id,
      kind: "command",
    });
    const response = await postDecision(
      accepted,
      decisionBody(accepted, { uiGrantNonce: nonce }),
    );
    expect(response.status).toBe(200);
    expect(accepted.created).toEqual([{ kind: "command", source: "card" }]);

    const declined = makeHarness();
    const declineResponse = await postDecision(declined, {
      ...decisionBody(declined),
      decision: { id: declined.pendingSpec.id, accepted: false },
    });
    expect(declineResponse.status).toBe(200);
    expect(declined.decisions).toHaveLength(1);
    expect(declined.created).toHaveLength(0);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AttachCapabilities, AttachHandshakeResponse } from "@qingagent/contract-ts";
import { app } from "../app";
import { sessionManager } from "../gateway/bridgeHandler";
import {
  startExternalInstance,
  stopExternalInstance,
} from "../lib/externalInstance";
import {
  __resetHandshakeAdmissionForTest,
  HandshakeAdmission,
} from "../lib/attachPolicy";
import { revokeAllAttachSessions } from "../lib/attachSessions";
import { COMMANDS_MODEL_OVERRIDE_HEADERS } from "../lib/commandRequestHeaders";

const TRUSTED_ORIGIN = "http://127.0.0.1:5173";
const desktopCapabilities = Object.fromEntries([
  "folderSelection", "confirmGrant", "diagnosticsExport", "documentExport", "sessionDeletion",
  "credentialProvider", "modelKeys", "skillMutation", "connectors", "updates",
  "templateMutation", "derivativeMutation", "lexiconMutation", "deepLink",
  "docEditing", "review", "assets",
].map((name) => [name, true])) as AttachCapabilities;

let dir = "";
let instanceToken = "";
let savedGlobalToken: string | undefined;

beforeAll(async () => {
  savedGlobalToken = process.env.QINGAGENT_AUTH_TOKEN;
  delete process.env.QINGAGENT_AUTH_TOKEN;
  dir = await mkdtemp(path.join(os.tmpdir(), "qa-attach-handshake-"));
  instanceToken = (await startExternalInstance({
    port: 54321,
    version: "6.0.0",
    libraryId: "00000000-0000-4000-8000-000000000001",
    filePath: path.join(dir, "instance.json"),
  })).token;
});

afterAll(async () => {
  revokeAllAttachSessions();
  __resetHandshakeAdmissionForTest();
  await stopExternalInstance(path.join(dir, "instance.json"));
  await rm(dir, { recursive: true, force: true });
  if (savedGlobalToken === undefined) delete process.env.QINGAGENT_AUTH_TOKEN;
  else process.env.QINGAGENT_AUTH_TOKEN = savedGlobalToken;
});

async function handshake(
  token = instanceToken,
  env?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return app.request("/api/v1/attach/handshake", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: TRUSTED_ORIGIN,
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    body: JSON.stringify({ desktopCapabilities }),
  }, env as never);
}

describe("attach handshake", () => {
  it("只接受当前 instance token，且只允许真实 loopback socket", async () => {
    __resetHandshakeAdmissionForTest();
    expect((await handshake("qa_instance_" + "0".repeat(64))).status).toBe(401);
    expect((await handshake(instanceToken, {
      incoming: { socket: { remoteAddress: "192.0.2.10" } },
    })).status).toBe(403);
    expect((await handshake(instanceToken, {
      incoming: { socket: { remoteAddress: "127.0.0.1" } },
    }, { "X-Forwarded-For": "192.0.2.20", "X-Real-IP": "192.0.2.21" })).status).toBe(200);
  });

  it("返回逐字段身份、server/effective capabilities 与 session token", async () => {
    __resetHandshakeAdmissionForTest();
    const response = await handshake();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as AttachHandshakeResponse;
    expect(body).toMatchObject({
      schemaVersion: 2,
      port: 54321,
      pid: process.pid,
      version: "6.0.0",
      attachProtocolVersion: 1,
      instanceId: expect.any(String),
      libraryId: "00000000-0000-4000-8000-000000000001",
      startedAt: expect.any(String),
      attachSessionToken: expect.stringMatching(/^qa_attach_[0-9a-f]{64}$/),
      serverCapabilities: {
        deepLink: true, docEditing: true, review: true, assets: true,
        folderSelection: false, confirmGrant: false, diagnosticsExport: false,
        documentExport: false, sessionDeletion: false, credentialProvider: false, modelKeys: false,
        skillMutation: false, connectors: false, updates: false,
        templateMutation: false, derivativeMutation: false, lexiconMutation: false,
      },
    });
    expect(body.effectiveCapabilities).toEqual(body.serverCapabilities);
  });

  it("按 IP 每分钟限 10 次", async () => {
    __resetHandshakeAdmissionForTest();
    for (let index = 0; index < 10; index += 1) {
      expect((await handshake()).status).toBe(200);
    }
    const limited = await handshake();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("loopback socket 的限速分桶不受 X-Forwarded-For 覆盖", async () => {
    __resetHandshakeAdmissionForTest();
    const env = { incoming: { socket: { remoteAddress: "::1" } } };
    for (let index = 0; index < 10; index += 1) {
      expect((await handshake(instanceToken, env, {
        "X-Forwarded-For": `127.0.0.${index + 2}`,
      })).status).toBe(200);
    }
    expect((await handshake(instanceToken, env, {
      "X-Forwarded-For": "127.0.0.250",
    })).status).toBe(429);
  });

  it("并发握手上限为 2", () => {
    const admission = new HandshakeAdmission();
    const first = admission.acquire("127.0.0.1");
    const second = admission.acquire("127.0.0.1");
    const third = admission.acquire("127.0.0.1");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third).toEqual({ ok: false, reason: "busy" });
    if (first.ok) first.release();
    if (second.ok) second.release();
    expect(admission.acquire("127.0.0.1").ok).toBe(true);
  });
});

describe("attach principal 与两级 gate", () => {
  it("global token 有/无与 Bearer/cookie/query 形态保持既有语义", async () => {
    const legacy = await app.request("/api/v1/capabilities", {
      headers: { Authorization: "Bearer unrelated-local-token" },
    });
    expect(legacy.status).toBe(200);

    process.env.QINGAGENT_AUTH_TOKEN = "global-test-token";
    try {
      expect((await app.request("/api/v1/capabilities")).status).toBe(401);
      expect((await app.request("/api/v1/capabilities", {
        headers: { Authorization: "Bearer global-test-token" },
      })).status).toBe(200);
      expect((await app.request("/api/v1/capabilities", {
        headers: { Cookie: "qa_auth=global-test-token" },
      })).status).toBe(200);
      expect((await app.request("/api/v1/capabilities?auth=global-test-token")).status).toBe(200);
    } finally {
      delete process.env.QINGAGENT_AUTH_TOKEN;
    }
  });

  it("失效 attach token 返回类型化 401，instance token 不能访问普通 UI route", async () => {
    __resetHandshakeAdmissionForTest();
    const expired = await app.request("/api/v1/capabilities", {
      headers: { Authorization: `Bearer qa_attach_${"0".repeat(64)}` },
    });
    expect(expired.status).toBe(401);
    await expect(expired.json()).resolves.toMatchObject({ error: { code: "ATTACH_SESSION_EXPIRED" } });

    const instanceOnUi = await app.request("/api/v1/capabilities", {
      headers: { Authorization: `Bearer ${instanceToken}` },
    });
    expect(instanceOnUi.status).toBe(403);
  });

  it("禁止 command 在 session 查询/idempotency/入队之前被拒，允许 command 正常通过", async () => {
    __resetHandshakeAdmissionForTest();
    const token = (await handshake().then((response) => response.json()) as AttachHandshakeResponse)
      .attachSessionToken;
    const submit = vi.spyOn(sessionManager, "submitQueued");
    const denied = await app.request("/api/v1/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: TRUSTED_ORIGIN,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        kind: "setEnabledLexicons",
        data: { sessionId: "s", requestId: "r", enabledLexiconIds: [] },
      }),
    });
    expect(denied.status).toBe(403);
    expect(submit).not.toHaveBeenCalled();

    submit.mockResolvedValueOnce({ completion: Promise.resolve([]) });
    const allowed = await app.request("/api/v1/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: TRUSTED_ORIGIN,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        kind: "ignoreAnnotationGroups",
        data: { sessionId: "s", reason: "discard_all" },
      }),
    });
    expect(allowed.status).toBe(200);
    expect(submit).toHaveBeenCalledTimes(1);
    submit.mockRestore();
  });

  it("modelKeys=false 时 commands/ask-more 在读取模型覆盖头前 fail closed", async () => {
    __resetHandshakeAdmissionForTest();
    const token = (await handshake().then((response) => response.json()) as AttachHandshakeResponse)
      .attachSessionToken;
    for (const header of COMMANDS_MODEL_OVERRIDE_HEADERS) {
      const response = await app.request("/api/v1/commands", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: TRUSTED_ORIGIN,
          Authorization: `Bearer ${token}`,
          [header]: "must-not-pass",
        },
        body: JSON.stringify({
          kind: "ignoreAnnotationGroups",
          data: { sessionId: "s", reason: "discard_all" },
        }),
      });
      expect(response.status, header).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "ATTACH_OPERATION_DENIED" },
      });
    }

    const askMore = await app.request("/api/v1/ask-more", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: TRUSTED_ORIGIN,
        Authorization: `Bearer ${token}`,
        "x-model-key": "must-not-pass",
      },
      body: "{}",
    });
    expect(askMore.status).toBe(403);
    await expect(askMore.json()).resolves.toMatchObject({
      error: { code: "ATTACH_OPERATION_DENIED" },
    });
  });

  it("settings 写、数据删除与五种 export 格式都 fail closed", async () => {
    __resetHandshakeAdmissionForTest();
    const token = (await handshake().then((response) => response.json()) as AttachHandshakeResponse)
      .attachSessionToken;
    const headers = { Authorization: `Bearer ${token}`, Origin: TRUSTED_ORIGIN };
    expect((await app.request("/api/v1/settings/model", { method: "PUT", headers })).status).toBe(403);
    expect((await app.request("/api/v1/sessions/victim", { method: "DELETE", headers })).status).toBe(403);
    for (const format of ["pdf", "docx", "txt", "markdown", "html"]) {
      const response = await app.request(`/api/v1/export/session-1?format=${format}`, { headers });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "ATTACH_ROUTE_DENIED" } });
    }
  });

  it("route policy 强制 header/body 上限与 capability 交集", async () => {
    __resetHandshakeAdmissionForTest();
    const token = (await handshake().then((response) => response.json()) as AttachHandshakeResponse)
      .attachSessionToken;
    const oversizedHeader = await app.request("/api/v1/capabilities", {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-oversized": "x".repeat(33 * 1024),
      },
    });
    expect(oversizedHeader.status).toBe(431);

    const oversizedBody = await app.request("/api/v1/commands", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: TRUSTED_ORIGIN,
        "Content-Type": "application/json",
        "Content-Length": String(9 * 1024 * 1024),
      },
      body: "{}",
    });
    expect(oversizedBody.status).toBe(413);

    const incompatibleCapabilities = { ...desktopCapabilities, docEditing: false };
    const incompatibleHandshake = await app.request("/api/v1/attach/handshake", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: TRUSTED_ORIGIN,
        Authorization: `Bearer ${instanceToken}`,
      },
      body: JSON.stringify({ desktopCapabilities: incompatibleCapabilities }),
    });
    const incompatible = await incompatibleHandshake.json() as AttachHandshakeResponse;
    expect(incompatible.effectiveCapabilities.docEditing).toBe(false);
    expect((await app.request("/api/v1/home", {
      headers: { Authorization: `Bearer ${incompatible.attachSessionToken}` },
    })).status).toBe(403);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../app";
import { sessionManager } from "../gateway/bridgeHandler";
import {
  startExternalInstance,
  stopExternalInstance,
} from "../lib/externalInstance";
import { clearDesktopGlobalToken, issueDesktopGlobalToken } from "../lib/authCredentials";

const TRUSTED_DESKTOP_ORIGIN = "http://127.0.0.1:5173";
let instanceFile = "";
let instanceToken = "";
let desktopGlobalToken = "";
let savedAuthToken: string | undefined;
let savedRuntime: string | undefined;

beforeAll(async () => {
  savedAuthToken = process.env.QINGAGENT_AUTH_TOKEN;
  savedRuntime = process.env.QINGAGENT_RUNTIME;
  delete process.env.QINGAGENT_AUTH_TOKEN;
  process.env.QINGAGENT_RUNTIME = "desktop";
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-commands-auth-"));
  instanceFile = path.join(dir, "instance.json");
  instanceToken = (await startExternalInstance({
    port: 52341,
    version: "test",
    libraryId: "00000000-0000-4000-8000-000000000001",
    filePath: instanceFile,
  })).token;
  desktopGlobalToken = issueDesktopGlobalToken();
});

afterAll(async () => {
  await stopExternalInstance(instanceFile);
  clearDesktopGlobalToken();
  await rm(path.dirname(instanceFile), { recursive: true, force: true });
  if (savedAuthToken === undefined) delete process.env.QINGAGENT_AUTH_TOKEN;
  else process.env.QINGAGENT_AUTH_TOKEN = savedAuthToken;
  if (savedRuntime === undefined) delete process.env.QINGAGENT_RUNTIME;
  else process.env.QINGAGENT_RUNTIME = savedRuntime;
});

async function postCommand(
  command: unknown,
  headers: Record<string, string> = {},
  pathName = "/api/v1/commands",
): Promise<Response> {
  return app.request(pathName, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(command),
  });
}

describe("commands mutation 确定性鉴权", () => {
  it.each([
    {
      name: "ignoreAnnotationGroups discard_all",
      command: {
        kind: "ignoreAnnotationGroups",
        data: { sessionId: "victim-review", reason: "discard_all" },
      },
    },
    {
      name: "submitReviewOutcome 伪造结论",
      command: {
        kind: "submitReviewOutcome",
        data: {
          sessionId: "victim-review",
          outcome: {
            acceptedCount: 1,
            rejectedCount: 0,
            hunks: [{
              verdict: "accepted",
              blockSummary: "伪造结论",
              beforeText: "原文",
              afterText: "伪造内容",
            }],
          },
        },
      },
    },
  ])("无 Origin、无 token 拒绝 $name", async ({ command }) => {
    const submit = vi.spyOn(sessionManager, "submitQueued");

    const response = await postCommand(command);

    expect(response.status).toBe(403);
    expect(submit).not.toHaveBeenCalled();
    submit.mockRestore();
  });

  it("伪造可信 Origin 仍因缺 token 被拒", async () => {
    const submit = vi.spyOn(sessionManager, "submitQueued");

    const response = await postCommand(
      {
        kind: "ignoreAnnotationGroups",
        data: { sessionId: "victim-review", reason: "discard_all" },
      },
      { Origin: TRUSTED_DESKTOP_ORIGIN },
    );

    expect(response.status).toBe(401);
    expect(submit).not.toHaveBeenCalled();
    submit.mockRestore();
  });

  it("instance token 严格限于 external/handshake，不能访问 commands", async () => {
    const submit = vi.spyOn(sessionManager, "submitQueued");
    const response = await postCommand(
      { kind: "ignoreAnnotationGroups", data: { sessionId: "desktop-review", reason: "discard_all" } },
      { Origin: TRUSTED_DESKTOP_ORIGIN, Authorization: `Bearer ${instanceToken}` },
    );
    expect(response.status).toBe(403);
    expect(submit).not.toHaveBeenCalled();
    submit.mockRestore();
  });

  it("desktop global principal + 可信 Origin 可通过 commands", async () => {
    const submit = vi.spyOn(sessionManager, "submitQueued").mockResolvedValue({
      completion: Promise.resolve([]),
    });

    const response = await postCommand(
      {
        kind: "ignoreAnnotationGroups",
        data: { sessionId: "desktop-review", reason: "discard_all" },
      },
      {
        Origin: TRUSTED_DESKTOP_ORIGIN,
        Authorization: `Bearer ${desktopGlobalToken}`,
      },
    );

    expect(response.status).toBe(200);
    expect(submit).toHaveBeenCalledTimes(1);
    submit.mockRestore();
  });

  it("Web-only 用既有 QINGAGENT_AUTH_TOKEN 换 HttpOnly cookie 后可正常提交", async () => {
    process.env.QINGAGENT_RUNTIME = "server";
    process.env.QINGAGENT_AUTH_TOKEN = "web-only-command-token";
    const submit = vi.spyOn(sessionManager, "submitQueued").mockResolvedValue({
      completion: Promise.resolve([]),
    });
    try {
      const sessionResponse = await app.request("/api/v1/auth/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: TRUSTED_DESKTOP_ORIGIN,
        },
        body: JSON.stringify({ token: "web-only-command-token" }),
      });
      expect(sessionResponse.status).toBe(200);
      const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
      expect(cookie).toMatch(/^qa_auth=/);

      const commandResponse = await postCommand(
        {
          kind: "ignoreAnnotationGroups",
          data: { sessionId: "web-review", reason: "discard_all" },
        },
        {
          Origin: TRUSTED_DESKTOP_ORIGIN,
          Cookie: cookie!,
        },
      );

      expect(commandResponse.status).toBe(200);
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      process.env.QINGAGENT_RUNTIME = "desktop";
      delete process.env.QINGAGENT_AUTH_TOKEN;
      submit.mockRestore();
    }
  });

  it("Web-only 未配置全局 token 时不把 external instance token 当 raw commands 通行证", async () => {
    process.env.QINGAGENT_RUNTIME = "server";
    const submit = vi.spyOn(sessionManager, "submitQueued");
    try {
      const response = await postCommand(
        {
          kind: "ignoreAnnotationGroups",
          data: { sessionId: "web-review", reason: "discard_all" },
        },
        {
          Origin: TRUSTED_DESKTOP_ORIGIN,
          Authorization: `Bearer ${instanceToken}`,
        },
      );

      expect(response.status).toBe(403);
      expect(submit).not.toHaveBeenCalled();
    } finally {
      process.env.QINGAGENT_RUNTIME = "desktop";
      submit.mockRestore();
    }
  });
});

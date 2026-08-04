import { assembleReviewQuery } from "@qingagent/contract-ts";
import {
  __resetDocumentsClientForTest,
} from "@qingagent/db/client";
import { REVIEW_TEMPLATE_PROMPT_SEEDS } from "@qingagent/db";
import { __resetMigrationsForTest } from "@qingagent/db/migrations";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app";
import {
  forgetSession,
  getSession,
  sessionManager,
} from "../gateway/bridgeHandler";
import {
  getExternalToken,
  startExternalInstance,
  stopExternalInstance,
} from "../lib/externalInstance";

const dirs: string[] = [];
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalMutation = process.env.QINGAGENT_ALLOW_TEMPLATE_MUTATION;
let token = "";

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-external-template-"));
  dirs.push(dir);
  process.env.DATABASE_URL = `file:${path.join(dir, "documents.db")}`;
  process.env.QINGAGENT_ALLOW_TEMPLATE_MUTATION = "1";
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  await startExternalInstance({
    port: 52341,
    version: "test",
    filePath: path.join(dir, "instance.json"),
  });
  token = getExternalToken() ?? "";
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopExternalInstance();
  await sessionManager.disposeAll();
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalMutation === undefined) delete process.env.QINGAGENT_ALLOW_TEMPLATE_MUTATION;
  else process.env.QINGAGENT_ALLOW_TEMPLATE_MUTATION = originalMutation;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("external review templates", () => {
  it("列表和详情返回完整 prompt、selected 与更新时间", async () => {
    const list = await request("/review-templates?type=source");
    expect(list.status).toBe(200);
    const body = await list.json() as {
      templates: Array<{
        id: string;
        prompt: string;
        selected: boolean;
        updatedAt: string;
      }>;
    };
    expect(body.templates).toHaveLength(1);
    expect(body.templates[0]).toMatchObject({
      id: "review-source-default",
      selected: true,
      prompt: expect.stringContaining("事实核查"),
      updatedAt: expect.any(String),
    });

    const detail = await request(`/review-templates/${body.templates[0]!.id}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      template: body.templates[0],
    });
  });

  it("自定义模板 CRUD、选择和 expectedUpdatedAt 冲突完整闭环", async () => {
    const createdResponse = await request("/review-templates", {
      method: "POST",
      body: JSON.stringify({
        type: "custom",
        name: "法务口径审查",
        prompt: "逐项核对合同义务",
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json() as {
      template: { id: string; updatedAt: string };
    }).template;

    const selected = await request(`/review-templates/${created.id}/select`, {
      method: "POST",
      body: "{}",
    });
    expect(selected.status).toBe(200);

    const updatedResponse = await request(`/review-templates/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: "严格法务口径审查",
        expectedUpdatedAt: created.updatedAt,
      }),
    });
    expect(updatedResponse.status).toBe(200);
    await expect(updatedResponse.json()).resolves.toMatchObject({
      template: { id: created.id, name: "严格法务口径审查", selected: true },
    });

    const conflict = await request(`/review-templates/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({
        prompt: "过期改动",
        expectedUpdatedAt: created.updatedAt,
      }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: "CONFLICT" });

    const deleted = await request(`/review-templates/${created.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ deleted: true, id: created.id });
  });

  it("修改和删除内置模板均返回 409，只读红线不被自定义模板数量绕过", async () => {
    await request("/review-templates", {
      method: "POST",
      body: JSON.stringify({ type: "source", name: "备用", prompt: "备用规则" }),
    });
    const builtin = (await (await request("/review-templates/review-source-default")).json() as {
      template: { updatedAt: string };
    }).template;
    const update = await request("/review-templates/review-source-default", {
      method: "PUT",
      body: JSON.stringify({
        prompt: "覆盖内置",
        expectedUpdatedAt: builtin.updatedAt,
      }),
    });
    expect(update.status).toBe(409);
    await expect(update.json()).resolves.toMatchObject({
      code: "CONFLICT",
      error: "内置审查模板不能修改",
    });

    const remove = await request("/review-templates/review-source-default", {
      method: "DELETE",
    });
    expect(remove.status).toBe(409);
    await expect(remove.json()).resolves.toMatchObject({
      code: "CONFLICT",
      error: "内置审查模板不能删除",
    });
  });

  it.each([
    ["POST", "/review-templates", { type: "custom", name: "a", prompt: "b" }],
    ["PUT", "/review-templates/review-source-default", { prompt: "b", expectedUpdatedAt: "x" }],
    ["DELETE", "/review-templates/review-source-default", undefined],
    ["POST", "/review-templates/review-source-default/select", {}],
    ["PUT", "/sessions/missing/review-supplement?type=source", { supplement: "x" }],
  ])("门关闭时 %s %s 返回 403", async (method, pathName, body) => {
    delete process.env.QINGAGENT_ALLOW_TEMPLATE_MUTATION;
    const response = await request(pathName, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status).toBe(403);
  });

  it("文档补充按 session/type 读写并校验会话", async () => {
    const sessionId = await createSession();
    const saved = await request(
      `/sessions/${sessionId}/review-supplement?type=source`,
      { method: "PUT", body: JSON.stringify({ supplement: "重点核对金额" }) },
    );
    expect(saved.status).toBe(200);
    const loaded = await request(`/sessions/${sessionId}/review-supplement?type=source`);
    expect(loaded.status).toBe(200);
    await expect(loaded.json()).resolves.toEqual({
      sessionId,
      type: "source",
      supplement: "重点核对金额",
    });
    expect((await request("/sessions/missing/review-supplement?type=source")).status)
      .toBe(404);
    expect((await request(`/sessions/${sessionId}/review-supplement?type=bad`)).status)
      .toBe(400);
  });

  it("冷会话读取 review supplement 不写回常驻注册表且响应内容不变", async () => {
    const sessionId = await createSession();
    const saved = await request(
      `/sessions/${sessionId}/review-supplement?type=source`,
      { method: "PUT", body: JSON.stringify({ supplement: "只读恢复校验" }) },
    );
    expect(saved.status).toBe(200);
    expect(forgetSession(sessionId)).toBe(true);
    expect(getSession(sessionId)).toBeUndefined();

    const loaded = await request(`/sessions/${sessionId}/review-supplement?type=source`);

    expect(loaded.status).toBe(200);
    await expect(loaded.json()).resolves.toEqual({
      sessionId,
      type: "source",
      supplement: "只读恢复校验",
    });
    expect(getSession(sessionId)).toBeUndefined();
  });

  it("review run 复用菜单同一 query 和 sendMessage 通道并携带 reviewContext", async () => {
    const sessionId = await createSession();
    await request(`/sessions/${sessionId}/review-supplement?type=source`, {
      method: "PUT",
      body: JSON.stringify({ supplement: "重点核对金额" }),
    });
    const submit = vi.spyOn(sessionManager, "submitQueued").mockResolvedValueOnce({
      completion: Promise.resolve([]),
    });

    const response = await request(`/sessions/${sessionId}/review/run`, {
      method: "POST",
      body: JSON.stringify({ type: "source" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      queued: true,
      type: "source",
      templateId: "review-source-default",
      afterSeq: expect.any(Number),
    });
    const sourceSeed = REVIEW_TEMPLATE_PROMPT_SEEDS.find(
      (template) => template.id === "review-source-default",
    )!;
    const expectedText = assembleReviewQuery(
      "source",
      sourceSeed,
      "重点核对金额",
    );
    const command = submit.mock.calls[0]![1].command;
    expect(command.kind).toBe("sendMessage");
    if (command.kind !== "sendMessage") throw new Error("unexpected command");
    expect(command.data.text).toBe(expectedText);
    expect(command.data.reviewContext).toEqual({
      type: "source",
      templateId: "review-source-default",
      templateName: "对照素材",
    });
    expect(submit.mock.calls[0]![1]).toMatchObject({
      origin: "external",
      client: "codex",
    });
  });

  it("自定义 review run 保留模板规则，同时把纯批注硬契约放在模板之后", async () => {
    const createdResponse = await request("/review-templates", {
      method: "POST",
      body: JSON.stringify({
        type: "custom",
        name: "对外发布",
        prompt: "命中后用 underline 或 markText 画金色下划线，不要创建批注。",
      }),
    });
    expect(createdResponse.status).toBe(201);
    const template = (await createdResponse.json() as {
      template: { id: string; name: string };
    }).template;
    const sessionId = await createSession();
    const submit = vi.spyOn(sessionManager, "submitQueued").mockResolvedValueOnce({
      completion: Promise.resolve([]),
    });

    const response = await request(`/sessions/${sessionId}/review/run`, {
      method: "POST",
      body: JSON.stringify({ type: "custom", templateId: template.id }),
    });
    expect(response.status).toBe(200);
    const command = submit.mock.calls[0]![1].command;
    expect(command.kind).toBe("sendMessage");
    if (command.kind !== "sendMessage") throw new Error("unexpected command");
    expect(command.data.reviewContext).toEqual({
      type: "custom",
      templateId: template.id,
      templateName: "对外发布",
    });
    expect(command.data.text).toContain("命中后用 underline 或 markText 画金色下划线，不要创建批注。");
    expect(command.data.text).toContain("禁止调用 editDraft/writeDraft");
    expect(command.data.text).toContain("必须调用 create_annotation_groups");
    expect(command.data.text.lastIndexOf("独立审查执行契约"))
      .toBeGreaterThan(command.data.text.indexOf("不要创建批注"));
  });
});

async function createSession(): Promise<string> {
  const response = await request("/sessions", {
    method: "POST",
    body: "{}",
  });
  expect(response.status).toBe(200);
  return (await response.json() as { sessionId: string }).sessionId;
}

function request(pathName: string, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(app.request(`/api/v1/external${pathName}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-QA-Client": "codex",
      ...(init.headers ?? {}),
    },
  }));
}

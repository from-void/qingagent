import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_SKILLS_DIR = vi.hoisted(() => {
  const value = `/tmp/qingagent-external-skills-${process.pid}`;
  process.env.QINGAGENT_USER_SKILLS_DIR = value;
  return value;
});

import { SKILLS_INSTALL_DIR } from "@qingagent/core";
import { app } from "../app";
import {
  getExternalToken,
  startExternalInstance,
  stopExternalInstance,
} from "../lib/externalInstance";

const originalMutation = process.env.QINGAGENT_ALLOW_SKILL_MUTATION;
let token = "";

beforeEach(async () => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(TEST_SKILLS_DIR, { recursive: true });
  process.env.QINGAGENT_ALLOW_SKILL_MUTATION = "1";
  await startExternalInstance({
    port: 52341,
    version: "test",
    libraryId: "00000000-0000-4000-8000-000000000001",
    filePath: path.join(TEST_SKILLS_DIR, "instance.json"),
  });
  token = getExternalToken() ?? "";
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopExternalInstance();
  const { readdir, rm } = await import("node:fs/promises");
  const entries = await readdir(TEST_SKILLS_DIR).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry !== "instance.json")
    .map((entry) => rm(path.join(TEST_SKILLS_DIR, entry), { recursive: true, force: true })));
  if (originalMutation === undefined) delete process.env.QINGAGENT_ALLOW_SKILL_MUTATION;
  else process.env.QINGAGENT_ALLOW_SKILL_MUTATION = originalMutation;
});

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(TEST_SKILLS_DIR, { recursive: true, force: true });
  delete process.env.QINGAGENT_USER_SKILLS_DIR;
});

describe("external skills", () => {
  it("列表复用内部序列化并在详情返回 body 与 children", async () => {
    const list = await request("/skills");
    expect(list.status).toBe(200);
    const listBody = await list.json() as {
      skills: Array<{ name: string; body?: string; children: unknown[] }>;
    };
    const review = listBody.skills.find((skill) => skill.name === "review");
    expect(review).toMatchObject({
      name: "review",
      children: expect.arrayContaining([
        expect.objectContaining({ name: "source-check" }),
      ]),
    });
    expect(review).not.toHaveProperty("body");

    const detail = await request("/skills/review");
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      skill: {
        name: "review",
        source: "builtin",
        body: expect.stringContaining("# 文档审查"),
        children: expect.arrayContaining([
          expect.objectContaining({
            name: "source-check",
            body: expect.any(String),
          }),
        ]),
      },
    });
  });

  it("多文件安装含子技能，更新整体替换后可删除", async () => {
    const rootV1 = skillMd("external-parent", "第一版");
    const installed = await request("/skills", {
      method: "POST",
      body: JSON.stringify({
        files: [
          { path: "SKILL.md", content: rootV1 },
          { path: "child/SKILL.md", content: skillMd("external-child", "子技能") },
          { path: "child/reference.md", content: "参考资料" },
        ],
      }),
    });
    expect(installed.status).toBe(200);
    await expect(installed.json()).resolves.toEqual({
      installed: true,
      name: "external-parent",
    });

    const detail = await request("/skills/external-parent");
    await expect(detail.json()).resolves.toMatchObject({
      skill: {
        source: "installed",
        body: expect.stringContaining("第一版"),
        children: [expect.objectContaining({ name: "external-child" })],
      },
    });

    const updated = await request("/skills/external-parent", {
      method: "PUT",
      body: JSON.stringify({
        files: [
          { path: "SKILL.md", content: skillMd("external-parent", "第二版") },
          { path: "notes.md", content: "新版" },
        ],
      }),
    });
    expect(updated.status).toBe(200);
    await expect(readFile(path.join(SKILLS_INSTALL_DIR, "external-parent", "SKILL.md"), "utf8"))
      .resolves.toContain("第二版");

    const deleted = await request("/skills/external-parent", { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect((await request("/skills/external-parent")).status).toBe(404);
  });

  it.each([
    [{ files: [{ path: "../escape.txt", content: "x" }, { path: "SKILL.md", content: skillMd("escape-demo", "x") }] }],
    [{ files: [{ path: "/tmp/escape.txt", content: "x" }, { path: "SKILL.md", content: skillMd("escape-demo", "x") }] }],
    [{ skillMd: skillMd("one", "x"), files: [{ path: "SKILL.md", content: skillMd("one", "x") }] }],
    [{ files: [{ path: "child/SKILL.md", content: skillMd("child-only", "x") }] }],
  ])("拒绝非法/逃逸技能请求 %#", async (body) => {
    const response = await request("/skills", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "VALIDATION" });
  });

  it("替换校验失败时旧版目录保持完整", async () => {
    await request("/skills", {
      method: "POST",
      body: JSON.stringify({ skillMd: skillMd("rollback-demo", "旧版") }),
    });
    const before = await readFile(
      path.join(SKILLS_INSTALL_DIR, "rollback-demo", "SKILL.md"),
      "utf8",
    );
    const failed = await request("/skills/rollback-demo", {
      method: "PUT",
      body: JSON.stringify({
        files: [{ path: "SKILL.md", content: skillMd("different-name", "新版") }],
      }),
    });
    expect(failed.status).toBe(400);
    await expect(
      readFile(path.join(SKILLS_INSTALL_DIR, "rollback-demo", "SKILL.md"), "utf8"),
    ).resolves.toBe(before);
  });

  it("内置技能不能更新或删除，但门关闭时仍可启停", async () => {
    const update = await request("/skills/review", {
      method: "PUT",
      body: JSON.stringify({ skillMd: skillMd("review", "覆盖") }),
    });
    expect(update.status).toBe(409);
    await expect(update.json()).resolves.toMatchObject({ code: "CONFLICT" });
    const remove = await request("/skills/review", { method: "DELETE" });
    expect(remove.status).toBe(409);
    await expect(remove.json()).resolves.toMatchObject({ code: "CONFLICT" });

    delete process.env.QINGAGENT_ALLOW_SKILL_MUTATION;
    const disabled = await request("/skills/review/disable", {
      method: "POST",
      body: "{}",
    });
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toEqual({
      name: "review",
      enabled: false,
    });
    expect((await request("/skills/review/enable", {
      method: "POST",
      body: "{}",
    })).status).toBe(200);
  });

  it.each(["POST", "PUT", "DELETE"])("门关闭时 %s 技能代码写口返回 403", async (method) => {
    delete process.env.QINGAGENT_ALLOW_SKILL_MUTATION;
    const pathName = method === "POST" ? "/skills" : "/skills/missing";
    const response = await request(pathName, {
      method,
      ...(method === "DELETE"
        ? {}
        : { body: JSON.stringify({ skillMd: skillMd("gate-demo", "x") }) }),
    });
    expect(response.status).toBe(403);
  });
});

function skillMd(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${body}\n---\n# ${body}\n`;
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

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { app } from "../app";
import {
  getExternalToken,
  readExternalInstanceFile,
  startExternalInstance,
  stopExternalInstance,
} from "../lib/externalInstance";

const dirs: string[] = [];

afterEach(async () => {
  delete process.env.QINGAGENT_AUTH_TOKEN;
  await stopExternalInstance();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("external instance + auth", () => {
  it("写出 0600 instance.json,可读回,stop 后删除", async () => {
    const filePath = await tempInstancePath();
    const info = await startExternalInstance({ port: 52341, version: "test", filePath });
    expect(info.token).toHaveLength(64);
    expect(getExternalToken()).toBe(info.token);
    expect(await readExternalInstanceFile(filePath)).toMatchObject({ port: 52341, pid: process.pid, version: "test" });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    await stopExternalInstance(filePath);
    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("external 子树强制 Bearer token", async () => {
    const filePath = await tempInstancePath();
    await startExternalInstance({ port: 52341, version: "test", filePath });
    const token = getExternalToken();
    expect((await app.request("/api/v1/external/health")).status).toBe(401);
    expect((await app.request("/api/v1/external/health", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    const ok = await app.request("/api/v1/external/health", { headers: { Authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, version: "test", pid: process.pid });
  });

  it("全局鉴权开启时 external 使用独立 Bearer，非 external 仍受全局鉴权保护", async () => {
    const filePath = await tempInstancePath();
    await startExternalInstance({ port: 52341, version: "test", filePath });
    const externalToken = getExternalToken();
    process.env.QINGAGENT_AUTH_TOKEN = "global-auth-token";

    const externalOk = await app.request("/api/v1/external/health", {
      headers: { Authorization: `Bearer ${externalToken}` },
    });
    expect(externalOk.status).toBe(200);

    const nonExternal = await app.request("/api/v1/home", {
      headers: { Authorization: `Bearer ${externalToken}` },
    });
    expect(nonExternal.status).toBe(401);
    expect(await nonExternal.json()).toEqual({ error: "unauthorized" });

    const externalMissingBearer = await app.request("/api/v1/external/health");
    expect(externalMissingBearer.status).toBe(401);
    expect(await externalMissingBearer.json()).toEqual({
      error: "unauthorized",
      code: "AUTH_FAILED",
    });
  });

  it("stop 不删除其他进程写入的 instance.json", async () => {
    const filePath = await tempInstancePath();
    await writeFile(filePath, JSON.stringify({
      port: 52341,
      pid: process.pid + 100_000,
      version: "other",
      token: "x",
      startedAt: "2026-07-10T00:00:00.000Z",
    }));

    await stopExternalInstance(filePath);

    await expect(stat(filePath)).resolves.toBeTruthy();
  });
});

async function tempInstancePath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-server-test-"));
  dirs.push(dir);
  return path.join(dir, "instance.json");
}

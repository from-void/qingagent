import type { FolderSourceRecord } from "@qingagent/contract-ts";
import type { Material } from "@qingagent/core";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app";
import { getOrRestoreSession, sessionManager } from "../bridge/bridgeHandler";
import { getExternalToken, startExternalInstance, stopExternalInstance } from "../lib/externalInstance";

const dirs: string[] = [];
let token = "";

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-files-test-"));
  dirs.push(dir);
  await startExternalInstance({ port: 52341, version: "test", filePath: path.join(dir, "instance.json") });
  token = getExternalToken() ?? "";
});

afterEach(async () => {
  await stopExternalInstance();
  await sessionManager.disposeAll();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("external files", () => {
  it("返回材料区清单和文件夹源投影,列表不含全文", async () => {
    const sessionId = await createSession();
    const session = await getOrRestoreSession(sessionId);
    expect(session).toBeTruthy();
    session!.materials.set("mat-ready", material({
      id: "mat-ready",
      filename: "brief.md",
      text: "这是不可泄露到列表的全文",
      summary: "材料摘要",
      wordCount: 9,
      parseState: "ready",
      sourceUrl: "https://example.test/brief",
    }));
    session!.materials.set("mat-error", material({
      id: "mat-error",
      filename: "bad.pdf",
      text: "",
      summary: null,
      wordCount: 0,
      parseState: "error",
      sourceUrl: null,
    }));
    session!.folderSources.set("fld-1", folderSource(sessionId));

    const res = await app.request(`/api/v1/external/sessions/${sessionId}/files`, { headers: authHeaders() });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      sessionId: string;
      materials: Array<Record<string, unknown>>;
      folderSources: Array<Record<string, unknown>>;
    };
    expect(body.sessionId).toBe(sessionId);
    expect(body.materials).toEqual([
      {
        id: "mat-ready",
        filename: "brief.md",
        mime: "text/markdown",
        summary: "材料摘要",
        wordCount: 9,
        byteLen: Buffer.byteLength("这是不可泄露到列表的全文", "utf8"),
        parseState: "ready",
        sourceUrl: "https://example.test/brief",
        createdAt: "2026-07-09T00:00:00.000Z",
      },
      {
        id: "mat-error",
        filename: "bad.pdf",
        mime: "text/markdown",
        summary: "",
        wordCount: 0,
        byteLen: 0,
        parseState: "error",
        sourceUrl: null,
        createdAt: "2026-07-09T00:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(body.materials)).not.toContain("这是不可泄露到列表的全文");
    expect(body.materials[0]).not.toHaveProperty("text");
    expect(body.folderSources).toEqual([
      { id: "fld-1", displayName: "参考资料", provider: "desktop-local", status: "connected" },
    ]);
  });

  it("返回材料全文,支持 maxBytes 截断和 404", async () => {
    const sessionId = await createSession();
    const session = await getOrRestoreSession(sessionId);
    expect(session).toBeTruthy();
    session!.materials.set("mat-long", material({
      id: "mat-long",
      filename: "long.txt",
      text: "abcdef",
      summary: "长文",
      wordCount: 1,
      parseState: "ready",
      sourceUrl: null,
    }));

    const full = await app.request(`/api/v1/external/sessions/${sessionId}/files/mat-long/text`, { headers: authHeaders() });
    expect(full.status).toBe(200);
    expect(await full.json()).toMatchObject({
      id: "mat-long",
      filename: "long.txt",
      mime: "text/markdown",
      text: "abcdef",
      byteLen: 6,
      truncated: false,
    });

    const truncated = await app.request(`/api/v1/external/sessions/${sessionId}/files/mat-long/text?maxBytes=3`, { headers: authHeaders() });
    expect(truncated.status).toBe(200);
    expect(await truncated.json()).toMatchObject({ text: "abc", byteLen: 6, truncated: true });

    const missing = await app.request(`/api/v1/external/sessions/${sessionId}/files/missing/text`, { headers: authHeaders() });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "MATERIAL_NOT_FOUND" });
  });

  it("材料截断不会残留半个 emoji 的替换字符", async () => {
    const sessionId = await createSession();
    const session = await getOrRestoreSession(sessionId);
    expect(session).toBeTruthy();
    session!.materials.set("mat-emoji", material({
      id: "mat-emoji",
      filename: "emoji.txt",
      text: "a😀b",
      summary: "emoji",
      wordCount: 1,
      parseState: "ready",
      sourceUrl: null,
    }));

    const res = await app.request(`/api/v1/external/sessions/${sessionId}/files/mat-emoji/text?maxBytes=3`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text: "a", byteLen: Buffer.byteLength("a😀b", "utf8"), truncated: true });
  });

  it("会话不存在时返回 SESSION_NOT_FOUND", async () => {
    const res = await app.request("/api/v1/external/sessions/missing-files/files", { headers: authHeaders() });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  it("材料端点需要 external token", async () => {
    const sessionId = await createSession();
    const res = await app.request(`/api/v1/external/sessions/${sessionId}/files`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "AUTH_FAILED" });
  });
});

async function createSession(): Promise<string> {
  const res = await app.request("/api/v1/external/sessions", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { sessionId: string };
  return body.sessionId;
}

function material(overrides: {
  id: string;
  filename: string;
  text: string;
  summary: string | null;
  wordCount: number;
  parseState: "ready" | "error";
  sourceUrl: string | null;
}): Material {
  return {
    id: overrides.id,
    filename: overrides.filename,
    mimeType: "text/markdown",
    text: overrides.text,
    summary: overrides.summary,
    fileId: null,
    metadata: {
      pages: null,
      wordCount: overrides.wordCount,
      title: null,
      sourceUrl: overrides.sourceUrl,
      parseState: overrides.parseState,
      parseError: overrides.parseState === "error" ? "解析失败" : null,
    },
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}

function folderSource(sessionId: string): FolderSourceRecord {
  return {
    id: "fld-1",
    sessionId,
    provider: "desktop-local",
    name: "参考资料",
    pathLabel: "~/资料",
    mountName: "source_docs",
    mountPath: "/sources/source_docs",
    readOnly: true,
    fileCount: 2,
    fileCountCapped: false,
    status: "connected",
    error: null,
    desktopRootPath: "/tmp/docs",
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPLOAD_FILENAME_HEADER,
  UPLOAD_SESSION_HEADER,
} from "@qingagent/contract-ts";

const originalCwd = process.cwd();
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalUploadsDir = process.env.QINGAGENT_UPLOADS_DIR;
const originalUploadMaxBytes = process.env.QINGAGENT_UPLOAD_MAX_BYTES;
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let tempDir = "";
let token = "";
let app: Hono;
let stopExternalInstance: () => Promise<void>;
let sessionManager: typeof import("../gateway/bridgeHandler").sessionManager;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-external-assets-"));
  process.chdir(tempDir);
  process.env.DATABASE_URL = `file:${path.join(tempDir, "qingagent.db")}`;
  process.env.QINGAGENT_UPLOADS_DIR = path.join(tempDir, "uploads");
  process.env.QINGAGENT_UPLOAD_MAX_BYTES = "8";
  vi.resetModules();

  const [externalModule, uploadModule, authModule, principalModule, instanceModule, bridgeModule] = await Promise.all([
    import("../routes/external"),
    import("../routes/upload"),
    import("../lib/externalAuth"),
    import("../lib/principal"),
    import("../lib/externalInstance"),
    import("../gateway/bridgeHandler"),
  ]);
  await instanceModule.startExternalInstance({
    port: 52341,
    version: "test",
    libraryId: "00000000-0000-4000-8000-000000000001",
    filePath: path.join(tempDir, "instance.json"),
  });
  token = instanceModule.getExternalToken() ?? "";
  stopExternalInstance = instanceModule.stopExternalInstance;
  sessionManager = bridgeModule.sessionManager;

  app = new Hono();
  app.use("*", principalModule.principalMiddleware);
  app.use("/api/v1/external/*", authModule.externalTokenMiddleware);
  app.route("/api/v1", uploadModule.uploadRoutes);
  app.route("/api/v1/external", externalModule.externalRoutes);
});

afterEach(async () => {
  await stopExternalInstance?.();
  await sessionManager?.disposeAll();
  const [{ __resetDocumentsClientForTest }, { __resetMigrationsForTest }] = await Promise.all([
    import("@qingagent/db/client"),
    import("@qingagent/db/migrations"),
  ]);
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  process.chdir(originalCwd);
  restoreEnv("DATABASE_URL", originalDatabaseUrl);
  restoreEnv("QINGAGENT_UPLOADS_DIR", originalUploadsDir);
  restoreEnv("QINGAGENT_UPLOAD_MAX_BYTES", originalUploadMaxBytes);
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("external assets", () => {
  it("base64 JSON 上传返回 PmDoc 兼容 src，Bearer 读取保真字节与 Content-Type", async () => {
    const sessionId = await createSession();
    const upload = await app.request(`/api/v1/external/sessions/${sessionId}/assets`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        filename: "示意图.png",
        mimeType: "image/png",
        base64: pngBytes.toString("base64"),
      }),
    });
    expect(upload.status).toBe(200);
    const asset = await upload.json() as {
      fileId: string;
      filename: string;
      mimeType: string;
      size: number;
      src: string;
    };
    expect(Object.keys(asset).sort()).toEqual(["fileId", "filename", "mimeType", "size", "src"]);
    expect(asset).toEqual({
      fileId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      filename: "示意图.png",
      mimeType: "image/png",
      size: 8,
      src: expect.stringMatching(/^\/api\/v1\/files\/[0-9a-f-]{36}\/%E7%A4%BA%E6%84%8F%E5%9B%BE\.png$/i),
    });

    const read = await app.request(
      `/api/v1/external/sessions/${sessionId}/assets/${asset.fileId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(read.headers.get("content-length")).toBe("8");
    expect(Buffer.from(await read.arrayBuffer())).toEqual(pngBytes);

    const unauthorized = await app.request(
      `/api/v1/external/sessions/${sessionId}/assets/${asset.fileId}`,
    );
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("multipart 可上传，并能读取内部 uploadRoutes 已存在的会话资产", async () => {
    const sessionId = await createSession();
    const form = new FormData();
    form.set("file", new File([pngBytes], "multipart.png", { type: "image/png" }));
    const multipart = await app.request(`/api/v1/external/sessions/${sessionId}/assets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    expect(multipart.status).toBe(200);
    await expect(multipart.json()).resolves.toMatchObject({
      filename: "multipart.png",
      mimeType: "image/png",
      size: 8,
    });

    const internal = await app.request("/api/v1/upload", {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        [UPLOAD_FILENAME_HEADER]: encodeURIComponent("internal.png"),
        [UPLOAD_SESSION_HEADER]: sessionId,
      },
      body: pngBytes,
    });
    expect(internal.status).toBe(200);
    const internalAsset = await internal.json() as { fileId: string };
    const externalRead = await app.request(
      `/api/v1/external/sessions/${sessionId}/assets/${internalAsset.fileId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(externalRead.status).toBe(200);
    expect(Buffer.from(await externalRead.arrayBuffer())).toEqual(pngBytes);
  });

  it("拒绝跨会话读取、脏 base64、非图片、超限与不存在会话", async () => {
    const ownerSessionId = await createSession();
    const otherSessionId = await createSession();
    const uploaded = await uploadJson(ownerSessionId, {
      filename: "owner.png",
      mimeType: "image/png",
      base64: pngBytes.toString("base64"),
    });
    const asset = await uploaded.json() as { fileId: string };

    const crossSession = await app.request(
      `/api/v1/external/sessions/${otherSessionId}/assets/${asset.fileId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(crossSession.status).toBe(404);
    await expect(crossSession.json()).resolves.toEqual({
      error: "ASSET_NOT_FOUND",
      code: "NOT_FOUND",
      nextStep: expect.any(String),
    });

    const dirtyBase64 = await uploadJson(ownerSessionId, {
      filename: "dirty.png",
      mimeType: "image/png",
      base64: `${pngBytes.toString("base64")} 收尾`,
    });
    expect(dirtyBase64.status).toBe(400);
    await expect(dirtyBase64.json()).resolves.toMatchObject({ code: "VALIDATION" });

    const nonImage = await uploadJson(ownerSessionId, {
      filename: "notes.txt",
      mimeType: "text/plain",
      base64: Buffer.from("x").toString("base64"),
    });
    expect(nonImage.status).toBe(400);

    const tooLarge = await uploadJson(ownerSessionId, {
      filename: "large.png",
      mimeType: "image/png",
      base64: Buffer.alloc(9).toString("base64"),
    });
    expect(tooLarge.status).toBe(413);
    await expect(tooLarge.json()).resolves.toMatchObject({ code: "VALIDATION" });

    const missingSession = await uploadJson("missing-session", {
      filename: "missing.png",
      mimeType: "image/png",
      base64: pngBytes.toString("base64"),
    });
    expect(missingSession.status).toBe(404);
    await expect(missingSession.json()).resolves.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });
});

async function createSession(): Promise<string> {
  const response = await app.request("/api/v1/external/sessions", {
    method: "POST",
    headers: authHeaders(),
    body: "{}",
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { sessionId: string }).sessionId;
}

async function uploadJson(sessionId: string, body: unknown): Promise<Response> {
  return await app.request(`/api/v1/external/sessions/${sessionId}/assets`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

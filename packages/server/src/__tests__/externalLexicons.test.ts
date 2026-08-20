import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalLexiconsResponse } from "../../../contract-ts/src/ExternalApi";
import { app } from "../app";
import {
  getExternalToken,
  startExternalInstance,
  stopExternalInstance,
} from "../lib/externalInstance";

const databaseEnv = vi.hoisted(() => {
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:/tmp/qingagent-external-lexicons-${process.pid}-${Math.random().toString(36).slice(2)}.db`;
  return { original };
});

let tempDir = "";
let token = "";

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "qa-external-lexicons-"));
  await startExternalInstance({
    port: 52343,
    version: "0.1.5",
    libraryId: "00000000-0000-4000-8000-000000000001",
    filePath: path.join(tempDir, "instance.json"),
  });
  token = getExternalToken() ?? "";
});

afterEach(async () => {
  await stopExternalInstance();
  await rm(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  if (databaseEnv.original === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseEnv.original;
});

describe("GET /api/v1/external/lexicons", () => {
  it("只返回词库公开摘要字段", async () => {
    const response = await app.request("/api/v1/external/lexicons", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as ExternalLexiconsResponse;
    expect(Array.isArray(body.lexicons)).toBe(true);
    for (const lexicon of body.lexicons) {
      expect(Object.keys(lexicon).sort()).toEqual(["enabled", "entryCount", "id", "name"]);
      expect(lexicon).toEqual({
        id: expect.any(String),
        name: expect.any(String),
        entryCount: expect.any(Number),
        enabled: expect.any(Boolean),
      });
    }
  });
});

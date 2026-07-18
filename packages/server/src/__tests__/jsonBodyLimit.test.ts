import { describe, expect, it } from "vitest";
import { app } from "../app";
import {
  DEFAULT_JSON_BODY_LIMIT_BYTES,
  resolveJsonBodyLimit,
} from "../lib/jsonBodyLimit";

describe("API JSON 请求体上限", () => {
  it("超大 commands JSON 返回 413，且服务进程仍可继续响应", async () => {
    const request = new Request("http://localhost/api/v1/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "sendMessage",
        data: { text: "x".repeat(DEFAULT_JSON_BODY_LIMIT_BYTES + 1) },
      }),
    });
    expect(request.headers.get("content-length")).toBeNull();

    const oversized = await app.request(request);

    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({ error: "请求体过大" });

    const health = await app.request("/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok" });
  });

  it("约 2 MiB 的正常长文 updateDoc 不被请求体护栏误拦", async () => {
    const response = await app.request("/api/v1/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "updateDoc",
        data: {
          sessionId: "body-limit-large-doc",
          expectedDocumentSnapshot: 1,
          legacySections: [{ kind: "p", data: { text: "x".repeat(2 * 1024 * 1024) } }],
          clientMutationId: "body-limit-large-doc-1",
        },
      }),
    });

    expect(response.status).toBe(200);
  });

  it("upload 继续使用路由自身的更大上限", async () => {
    const response = await app.request("/api/v1/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(DEFAULT_JSON_BODY_LIMIT_BYTES + 1),
      },
      body: "{}",
    });

    expect(response.status).toBe(400);
    expect(response.status).not.toBe(413);
  });

  it("环境变量仅接受正的安全整数，非法值回退 8 MiB", () => {
    expect(resolveJsonBodyLimit("12345")).toBe(12345);
    for (const raw of ["", "0", "-1", "1.5", "not-a-number", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(resolveJsonBodyLimit(raw)).toBe(DEFAULT_JSON_BODY_LIMIT_BYTES);
    }
  });
});

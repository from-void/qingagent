import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { confirmRoutes } from "../routes/confirms";

const app = new Hono();
app.route("/api/v1", confirmRoutes);

describe("confirm decision route 入站防护", () => {
  it("reject 携带 secret 返回 400 且响应不回显 sentinel", async () => {
    const sentinel = "SECRET_SENTINEL_ROUTE_f6c2";
    const response = await app.request("/api/v1/confirms/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "s",
        toolCallId: "t",
        decisionId: "d",
        decision: { id: "c", accepted: false, secretValue: sentinel },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(sentinel);
  });

  it("超限 body 拒绝，恶意 Origin 返回 403", async () => {
    const oversized = await app.request("/api/v1/confirms/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(16 * 1024 + 1),
    });
    expect(oversized.status).toBe(400);

    const crossSite = await app.request("/api/v1/confirms/decision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        host: "localhost:8080",
      },
      body: "{}",
    });
    expect(crossSite.status).toBe(403);
  });
});

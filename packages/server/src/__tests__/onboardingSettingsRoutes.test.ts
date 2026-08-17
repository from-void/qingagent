import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createOnboardingSettingsRoutes } from "../routes/onboardingSettings";

function makeHarness() {
  const store = new Map<string, string>();
  const setSetting = vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  });
  const app = new Hono();
  app.route("/api/v1", createOnboardingSettingsRoutes({
    getSetting: async (key) => store.get(key) ?? null,
    setSetting,
    now: () => new Date("2026-08-17T03:04:05.000Z"),
  }));
  return { app, store, setSetting };
}

describe("首启引导设置路由", () => {
  it("读写 done/skipped 状态并携带完成时间", async () => {
    const harness = makeHarness();
    const initial = await harness.app.request("/api/v1/settings/onboarding");
    await expect(initial.json()).resolves.toEqual({ state: null, coachSeen: [] });

    const saved = await harness.app.request("/api/v1/settings/onboarding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "skipped" }),
    });

    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual({
      state: { status: "skipped", completedAt: "2026-08-17T03:04:05.000Z" },
    });
    expect(JSON.parse(harness.store.get("onboarding_state")!)).toEqual({
      status: "skipped",
      completedAt: "2026-08-17T03:04:05.000Z",
    });
  });

  it("coach id 逐项持久化且拒绝未知 id", async () => {
    const harness = makeHarness();
    const saved = await harness.app.request(
      "/api/v1/settings/onboarding/coach/home-new",
      { method: "PUT" },
    );
    expect(saved.status).toBe(200);
    expect(harness.store.get("coach_seen:home-new")).toBe("2026-08-17T03:04:05.000Z");

    const read = await harness.app.request("/api/v1/settings/onboarding");
    await expect(read.json()).resolves.toEqual({ state: null, coachSeen: ["home-new"] });

    const unknown = await harness.app.request(
      "/api/v1/settings/onboarding/coach/not-real",
      { method: "PUT" },
    );
    expect(unknown.status).toBe(400);
  });

  it("拒绝非法状态和不受信 Origin", async () => {
    const harness = makeHarness();
    const invalid = await harness.app.request("/api/v1/settings/onboarding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "later" }),
    });
    expect(invalid.status).toBe(400);

    const untrusted = await harness.app.request("/api/v1/settings/onboarding", {
      headers: { Origin: "https://evil.example" },
    });
    expect(untrusted.status).toBe(403);
    expect(harness.setSetting).not.toHaveBeenCalled();
  });
});

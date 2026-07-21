import { describe, expect, it, vi } from "vitest";
import {
  __resetConfirmUiGrantForTest,
  ConfirmUiGrantStore,
  insecureRememberAllowed,
} from "../lib/confirmUiGrant";

describe("ConfirmUiGrantStore", () => {
  it("nonce 只可消费一次", () => {
    const store = new ConfirmUiGrantStore({ createNonce: () => "nonce-once" });
    const nonce = store.register({
      purpose: "confirm",
      sessionId: "session-a",
      confirmId: "confirm-a",
      kind: "command",
    });

    expect(store.consume({
      purpose: "confirm",
      nonce,
      sessionId: "session-a",
      confirmId: "confirm-a",
      kind: "command",
    })).toEqual({ ok: true });
    expect(store.consume({
      purpose: "confirm",
      nonce,
      sessionId: "session-a",
      confirmId: "confirm-a",
      kind: "command",
    })).toEqual({ ok: false, reason: "unknown-or-replayed" });
  });

  it.each([
    ["跨 confirm", { sessionId: "session-a", confirmId: "confirm-b", kind: "command" as const }],
    ["跨 session", { sessionId: "session-b", confirmId: "confirm-a", kind: "command" as const }],
    ["跨类别", { sessionId: "session-a", confirmId: "confirm-a", kind: "install" as const }],
  ])("%s 时拒绝且立即销毁", (_label, mismatch) => {
    let sequence = 0;
    const store = new ConfirmUiGrantStore({ createNonce: () => `nonce-${sequence++}` });
    const nonce = store.register({
      purpose: "confirm",
      sessionId: "session-a",
      confirmId: "confirm-a",
      kind: "command",
    });

    expect(store.consume({ purpose: "confirm", nonce, ...mismatch })).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(store.consume({
      purpose: "confirm",
      nonce,
      sessionId: "session-a",
      confirmId: "confirm-a",
      kind: "command",
    })).toEqual({ ok: false, reason: "unknown-or-replayed" });
  });

  it("过期和跨用途 nonce 均拒绝，TTL 上限为 60 秒", () => {
    let now = 1_000;
    let sequence = 0;
    const store = new ConfirmUiGrantStore({
      now: () => now,
      createNonce: () => `nonce-${sequence++}`,
    });
    const expired = store.register({
      purpose: "confirm",
      sessionId: "session-a",
      confirmId: "confirm-a",
      kind: "command",
      ttlMs: 100,
    });
    now += 100;
    expect(store.consume({
      purpose: "confirm",
      nonce: expired,
      sessionId: "session-a",
      confirmId: "confirm-a",
      kind: "command",
    })).toEqual({ ok: false, reason: "expired" });

    const capped = store.register({ purpose: "settings", kind: "install", ttlMs: 999_999 });
    now += 60_000;
    expect(store.consume({ purpose: "settings", nonce: capped, kind: "install" })).toEqual({
      ok: false,
      reason: "expired",
    });

    const wrongPurpose = store.register({ purpose: "settings", kind: "command" });
    expect(store.consume({
      purpose: "confirm",
      nonce: wrongPurpose,
      sessionId: "session-a",
      confirmId: "confirm-a",
      kind: "command",
    })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("仅显式真值开启不安全开发模式，并只警告一次", () => {
    __resetConfirmUiGrantForTest();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(insecureRememberAllowed({ QINGAGENT_DEV_ALLOW_INSECURE_REMEMBER: "0" })).toBe(false);
    expect(insecureRememberAllowed({ QINGAGENT_DEV_ALLOW_INSECURE_REMEMBER: "false" })).toBe(false);
    expect(insecureRememberAllowed({ QINGAGENT_DEV_ALLOW_INSECURE_REMEMBER: "1" })).toBe(true);
    expect(insecureRememberAllowed({ QINGAGENT_DEV_ALLOW_INSECURE_REMEMBER: "true" })).toBe(true);
    expect(insecureRememberAllowed({
      QINGAGENT_DESKTOP_PACKAGED: "1",
      QINGAGENT_DEV_ALLOW_INSECURE_REMEMBER: "1",
    })).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    __resetConfirmUiGrantForTest();
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAttachHandshakeFailure } from "./attachStartupDecision.js";
import type { DiscoveryReport } from "./attachDiscoveryTypes.js";

const BOUND = "00000000-0000-4000-8000-000000000001";

test("握手失败后，未绑定且重发现全 absent 时才回退 embedded", () => {
  const absent: DiscoveryReport = {
    observations: [{ source: "local", state: "absent" }],
  };
  assert.deepEqual(resolveAttachHandshakeFailure(absent, null), { kind: "embedded" });
  assert.equal(resolveAttachHandshakeFailure(absent, BOUND).kind, "blocked");
});

test("握手失败后的不确定、不兼容、冲突均不得回退", () => {
  for (const observations of [
    [{ source: "local", state: "indeterminate", errorCode: "UNREACHABLE" }],
    [{ source: "local", state: "incompatible", errorCode: "INCOMPATIBLE" }],
    [{ source: "local", state: "conflict", errorCode: "CONFLICT" }],
  ] as const) {
    assert.equal(resolveAttachHandshakeFailure({ observations: [...observations] }, null).kind, "blocked");
  }
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decideAttachMode } from "./attachModeDecision.js";
import type {
  DiscoveredInstance,
  DiscoveryObservation,
  DiscoveryReport,
} from "./attachDiscoveryTypes.js";

const LIBRARY_A = "00000000-0000-4000-8000-000000000001";
const LIBRARY_B = "00000000-0000-4000-8000-000000000002";

function instance(
  suffix: number,
  libraryId = LIBRARY_A,
  endpoint = `http://127.0.0.1:${51000 + suffix}`,
): DiscoveredInstance {
  return {
    schemaVersion: 2,
    port: 51000 + suffix,
    pid: 2000 + suffix,
    version: "0.1.4",
    attachProtocolVersion: 1,
    instanceId: `00000000-0000-4000-8001-${String(suffix).padStart(12, "0")}`,
    libraryId,
    token: `qa_instance_${"a".repeat(64)}`,
    startedAt: `2026-01-01T00:00:${String(suffix).padStart(2, "0")}.000Z`,
    endpoint,
    source: `source-${suffix}`,
  };
}

const absent = (source: string): DiscoveryObservation => ({ source, state: "absent" });
const valid = (value: DiscoveredInstance): DiscoveryObservation => ({
  source: value.source,
  state: "valid",
  instance: value,
});
const report = (...observations: DiscoveryObservation[]): DiscoveryReport => ({ observations });

describe("首次绑定真值表", () => {
  test("单一 valid + 其余 absent 自动 attach", () => {
    const target = instance(1);
    assert.deepEqual(decideAttachMode(report(valid(target), absent("wsl")), null), {
      kind: "attach",
      instance: target,
    });
  });

  test("Docker Desktop HOME 诊断为 absent 时不遮蔽唯一有效实例", () => {
    const target = instance(1);
    assert.deepEqual(decideAttachMode(report(
      valid(target),
      { source: "wsl:docker-desktop", state: "absent", errorCode: "HOME_FAILED" },
    ), null), { kind: "attach", instance: target });
  });

  test("多个 valid 进入显式选择", () => {
    const decision = decideAttachMode(report(valid(instance(1)), valid(instance(2, LIBRARY_B))), null);
    assert.equal(decision.kind, "select");
    if (decision.kind === "select") assert.equal(decision.candidates.length, 2);
  });

  test("枚举完整且全 absent 才进 embedded", () => {
    assert.deepEqual(decideAttachMode(report(absent("local"), absent("wsl")), null), {
      kind: "embedded",
    });
  });

  for (const observation of [
    { source: "local", state: "indeterminate", errorCode: "UNREACHABLE" },
    { source: "local", state: "incompatible", errorCode: "INCOMPATIBLE" },
    { source: "local", state: "conflict", errorCode: "CONFLICT" },
  ] as const) {
    test(`${observation.state} 存在时恒阻断`, () => {
      const decision = decideAttachMode(report(observation), null);
      assert.equal(decision.kind, "blocked");
      if (decision.kind === "blocked") assert.deepEqual(decision.errorCodes, [observation.errorCode]);
    });
  }

  test("空报告不利用 every 真空回退 embedded", () => {
    assert.deepEqual(decideAttachMode(report(), null), {
      kind: "blocked",
      reason: "catch-all",
      errorCodes: [],
      allowUnbind: false,
    });
  });

  test("规范化 endpoint + instanceId 去重", () => {
    const first = instance(1, LIBRARY_A, "http://LOCALHOST:51001");
    const duplicate = { ...first, endpoint: "http://localhost:51001", source: "wsl:same" };
    const decision = decideAttachMode(report(valid(first), valid(duplicate)), null);
    assert.equal(decision.kind, "attach");
  });
});

describe("已绑定真值表", () => {
  test("唯一 bound 命中优先，其他问题只记诊断", () => {
    const target = instance(1);
    const decision = decideAttachMode(report(
      valid(target),
      { source: "wsl", state: "indeterminate", errorCode: "ENUM_FAILED" },
      valid(instance(2, LIBRARY_B)),
    ), LIBRARY_A);
    assert.deepEqual(decision, { kind: "attach", instance: target });
  });

  test("同 bound 多个物理候选必须选择", () => {
    const decision = decideAttachMode(report(valid(instance(1)), valid(instance(2))), LIBRARY_A);
    assert.equal(decision.kind, "select");
    if (decision.kind === "select") assert.equal(decision.reason, "bound-conflict");
  });

  const cases: Array<[string, DiscoveryReport, string, boolean]> = [
    ["无 bound 命中且发现不确定", report({ source: "local", state: "indeterminate", errorCode: "MALFORMED" }), "discovery", false],
    ["只有其他文库", report(valid(instance(2, LIBRARY_B))), "bound-missing-other", true],
    ["全部 absent", report(absent("local"), absent("wsl")), "bound-missing", true],
    ["空报告", report(), "catch-all", false],
  ];
  for (const [name, input, reason, allowUnbind] of cases) {
    test(name, () => {
      const decision = decideAttachMode(input, LIBRARY_A);
      assert.equal(decision.kind, "blocked");
      if (decision.kind === "blocked") {
        assert.equal(decision.reason, reason);
        assert.equal(decision.allowUnbind, allowUnbind);
      }
    });
  }
});

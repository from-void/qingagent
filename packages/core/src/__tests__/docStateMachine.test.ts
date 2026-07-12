import { describe, expect, it } from "vitest";
import type { IncomingDocState } from "@qingagent/contract-ts";
import { coerceLegacyContentKind } from "../doc-engine/docStateMachine.js";

// R5e:pre-R5e 的合并维度 adapter `fromWireDocState` 已删除,因(agentBusy/overlay)
// 改由 facts 现场派生(见 docStateR0Derivation.test.ts 的 deriveAgentBusy/deriveActiveOverlay)。
// 这里只校验 legacy(8 态)∪ modern(3 态)wire kind → 3 态 content 的归一(C2 兼容)。
const wireKinds: IncomingDocState["kind"][] = [
  "init",
  "plan",
  "drafting",
  "draft",
  "locked",
  "review",
  "committed",
  "history",
  "empty",
  "editing",
  "pendingReview",
];

describe("coerceLegacyContentKind", () => {
  it("folds all 8∪3 wire kinds into the R5e 3-state content model", () => {
    const expected: Record<IncomingDocState["kind"], "empty" | "editing" | "pendingReview"> = {
      init: "empty",
      plan: "editing",
      drafting: "editing",
      draft: "editing",
      locked: "editing",
      review: "pendingReview",
      committed: "editing",
      history: "editing",
      empty: "empty",
      editing: "editing",
      pendingReview: "pendingReview",
    };

    for (const kind of wireKinds) {
      expect(coerceLegacyContentKind(kind).kind).toBe(expected[kind]);
    }
  });

  it("never returns published/committed/history as a content kind", () => {
    for (const kind of wireKinds) {
      expect(["empty", "editing", "pendingReview"]).toContain(
        coerceLegacyContentKind(kind).kind,
      );
    }
  });

  it("falls back to empty for an unknown wire kind", () => {
    expect(coerceLegacyContentKind("future-kind").kind).toBe("empty");
  });
});

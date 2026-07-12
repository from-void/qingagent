import { describe, expect, it } from "vitest";
import { isServerReanchorEnabled, isTruthyFlag } from "../doc-engine/draftFeatureFlags.js";

describe("draft feature flag parsing helpers", () => {
  it.each(["1", "true", "yes", "on", " TRUE ", "On"])(
    "isTruthyFlag accepts explicit truthy value %j",
    (raw) => {
      expect(isTruthyFlag(raw)).toBe(true);
    },
  );

  it.each([undefined, "", "0", "false", "no", "off", "random"])(
    "isTruthyFlag rejects non-truthy value %j",
    (raw) => {
      expect(isTruthyFlag(raw)).toBe(false);
    },
  );

  it("SERVER_REANCHOR 独立保留 truthy 开关", () => {
    const previous = process.env.QINGAGENT_SERVER_REANCHOR;
    try {
      delete process.env.QINGAGENT_SERVER_REANCHOR;
      expect(isServerReanchorEnabled()).toBe(false);
      process.env.QINGAGENT_SERVER_REANCHOR = "1";
      expect(isServerReanchorEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.QINGAGENT_SERVER_REANCHOR;
      else process.env.QINGAGENT_SERVER_REANCHOR = previous;
    }
  });
});

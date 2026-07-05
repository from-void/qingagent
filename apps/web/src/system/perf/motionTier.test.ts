import { describe, expect, it } from "vitest";
import { detectPerfTier } from "./motionTier";

describe("motionTier", () => {
  it("defaults to high when runtime hardware hints are unavailable", () => {
    expect(detectPerfTier({})).toBe("high");
  });

  it("classifies low memory or low core devices as low tier", () => {
    expect(detectPerfTier({ deviceMemory: 4, hardwareConcurrency: 8 })).toBe("low");
    expect(detectPerfTier({ deviceMemory: 8, hardwareConcurrency: 4 })).toBe("low");
  });

  it("keeps stronger devices on high tier", () => {
    expect(detectPerfTier({ deviceMemory: 8, hardwareConcurrency: 8 })).toBe("high");
  });

  it("allows querystring overrides for e2e low-tier simulation", () => {
    expect(detectPerfTier({ deviceMemory: 8, hardwareConcurrency: 8, search: "?motionTier=low" })).toBe("low");
    expect(detectPerfTier({ deviceMemory: 2, hardwareConcurrency: 2, search: "?motionTier=high" })).toBe("high");
  });
});

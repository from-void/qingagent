import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REVEAL_PRESENTATION_CONFIG,
  REVEAL_PRESENTATION_CONFIG_STORAGE_KEY,
  getRevealPresentationConfig,
  readRevealPresentationConfig,
  resetRevealPresentationConfigForTest,
  setRevealPresentationConfig,
  writeRevealPresentationConfig,
  type RevealPresentationConfigStorage,
} from "./revealPresentationConfig";

function memoryStorage(): RevealPresentationConfigStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}

describe("revealPresentationConfig", () => {
  afterEach(() => {
    resetRevealPresentationConfigForTest(DEFAULT_REVEAL_PRESENTATION_CONFIG, null);
  });

  it("falls back to defaults when storage is empty or invalid", () => {
    const storage = memoryStorage();

    expect(readRevealPresentationConfig(storage)).toEqual(
      DEFAULT_REVEAL_PRESENTATION_CONFIG,
    );

    storage.setItem(REVEAL_PRESENTATION_CONFIG_STORAGE_KEY, "{bad json");
    expect(readRevealPresentationConfig(storage)).toEqual(
      DEFAULT_REVEAL_PRESENTATION_CONFIG,
    );
  });

  it("reads and writes localStorage-compatible config", () => {
    const storage = memoryStorage();
    const next = {
      concurrency: 3,
      stepDelayMs: 120,
      charsPerTick: 4,
      tailHoldMs: 480,
      glow: false,
    };

    writeRevealPresentationConfig(next, storage);

    expect(readRevealPresentationConfig(storage)).toEqual(next);
  });

  it("clamps unsafe numeric values and coerces a non-boolean glow", () => {
    const storage = memoryStorage();
    storage.setItem(
      REVEAL_PRESENTATION_CONFIG_STORAGE_KEY,
      JSON.stringify({
        concurrency: 99,
        stepDelayMs: 5,
        charsPerTick: 99,
        tailHoldMs: 99999,
        glow: "yes",
      }),
    );

    const config = readRevealPresentationConfig(storage);

    expect(config.concurrency).toBe(6);
    expect(config.stepDelayMs).toBe(20);
    expect(config.charsPerTick).toBe(8);
    expect(config.tailHoldMs).toBe(1500);
    // 非布尔的 glow 回落到默认 true
    expect(config.glow).toBe(true);
  });

  it("preserves an explicit glow=false through sanitize", () => {
    const storage = memoryStorage();
    storage.setItem(
      REVEAL_PRESENTATION_CONFIG_STORAGE_KEY,
      JSON.stringify({ glow: false }),
    );
    expect(readRevealPresentationConfig(storage).glow).toBe(false);
  });

  it("updates the module-level runtime config and persists it", () => {
    const storage = memoryStorage();
    resetRevealPresentationConfigForTest(DEFAULT_REVEAL_PRESENTATION_CONFIG, storage);

    const next = setRevealPresentationConfig(
      { concurrency: 4, glow: false },
      storage,
    );

    expect(next.concurrency).toBe(4);
    expect(next.glow).toBe(false);
    expect(getRevealPresentationConfig()).toEqual(next);
    expect(readRevealPresentationConfig(storage)).toEqual(next);
  });
});

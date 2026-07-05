import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_NATIVE_PRESENTATION_CONFIG,
  NATIVE_PRESENTATION_CONFIG_STORAGE_KEY,
  getNativePresentationConfig,
  readNativePresentationConfig,
  resetNativePresentationConfigForTest,
  resolveNativeStepDelayMs,
  setNativePresentationConfig,
  writeNativePresentationConfig,
  type NativePresentationConfigStorage,
} from "./presentationRuntimeConfig";

function memoryStorage(): NativePresentationConfigStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}

describe("presentationRuntimeConfig", () => {
  afterEach(() => {
    resetNativePresentationConfigForTest(DEFAULT_NATIVE_PRESENTATION_CONFIG, null);
  });

  it("falls back to defaults when storage is empty or invalid", () => {
    const storage = memoryStorage();

    expect(readNativePresentationConfig(storage)).toEqual(DEFAULT_NATIVE_PRESENTATION_CONFIG);

    storage.setItem(NATIVE_PRESENTATION_CONFIG_STORAGE_KEY, "{bad json");
    expect(readNativePresentationConfig(storage)).toEqual(DEFAULT_NATIVE_PRESENTATION_CONFIG);
  });

  it("reads and writes localStorage-compatible config", () => {
    const storage = memoryStorage();
    const next = {
      agentCount: 4,
      stepDelayMs: 72,
      chunkSize: 3,
      maxDurationMs: 9000,
      speedScale: 1.5,
    };

    writeNativePresentationConfig(next, storage);

    expect(readNativePresentationConfig(storage)).toEqual(next);
  });

  it("clamps unsafe values and applies speedScale to the effective delay", () => {
    const storage = memoryStorage();
    storage.setItem(
      NATIVE_PRESENTATION_CONFIG_STORAGE_KEY,
      JSON.stringify({
        agentCount: 99,
        stepDelayMs: 4,
        chunkSize: 0,
        maxDurationMs: 20,
        speedScale: 99,
      }),
    );

    const config = readNativePresentationConfig(storage);

    expect(config.agentCount).toBe(6);
    expect(config.stepDelayMs).toBe(18);
    expect(config.chunkSize).toBe(1);
    expect(config.maxDurationMs).toBe(1000);
    expect(config.speedScale).toBe(4);
    expect(resolveNativeStepDelayMs(config)).toBe(72);
  });

  it("updates the module-level runtime config and persists it", () => {
    const storage = memoryStorage();
    resetNativePresentationConfigForTest(DEFAULT_NATIVE_PRESENTATION_CONFIG, storage);

    const next = setNativePresentationConfig({ agentCount: 3, speedScale: 2 }, storage);

    expect(next.agentCount).toBe(3);
    expect(next.speedScale).toBe(2);
    expect(getNativePresentationConfig()).toEqual(next);
    expect(readNativePresentationConfig(storage)).toEqual(next);
  });
});

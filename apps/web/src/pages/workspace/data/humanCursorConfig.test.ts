import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HUMAN_CURSOR_CONFIG,
  HUMAN_CURSOR_CONFIG_STORAGE_KEY,
  readHumanCursorConfig,
  resetHumanCursorConfigForTest,
  sanitizeHumanCursorConfig,
  setHumanCursorConfig,
  writeHumanCursorConfig,
  type HumanCursorConfigStorage,
} from "./humanCursorConfig";

function memoryStorage(): HumanCursorConfigStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
}

describe("humanCursorConfig", () => {
  afterEach(() => resetHumanCursorConfigForTest(DEFAULT_HUMAN_CURSOR_CONFIG, null));

  it("空/坏数据回退默认", () => {
    const s = memoryStorage();
    expect(readHumanCursorConfig(s)).toEqual(DEFAULT_HUMAN_CURSOR_CONFIG);
    s.setItem(HUMAN_CURSOR_CONFIG_STORAGE_KEY, "{bad");
    expect(readHumanCursorConfig(s)).toEqual(DEFAULT_HUMAN_CURSOR_CONFIG);
  });

  it("sanitize:数值 clamp + 布尔强制 + 缺省", () => {
    const c = sanitizeHumanCursorConfig({
      enabled: false,
      driftSpeed: 99,
      jitter: -5,
      fadeDelayMs: 999999,
      edgeBubble: "yes" as unknown as boolean,
    });
    expect(c.enabled).toBe(false);
    expect(c.driftSpeed).toBe(3);
    expect(c.jitter).toBe(0);
    expect(c.fadeDelayMs).toBe(3000);
    expect(c.edgeBubble).toBe(true); // 非布尔→默认 true
  });

  it("读写往返 + setHumanCursorConfig 持久化", () => {
    const s = memoryStorage();
    resetHumanCursorConfigForTest(DEFAULT_HUMAN_CURSOR_CONFIG, s);
    const next = setHumanCursorConfig({ enabled: false, driftSpeed: 2 }, s);
    expect(next.enabled).toBe(false);
    expect(next.driftSpeed).toBe(2);
    expect(readHumanCursorConfig(s)).toEqual(next);
    const explicit = { enabled: true, driftSpeed: 1.5, jitter: 0.5, fadeDelayMs: 800, edgeBubble: false };
    writeHumanCursorConfig(explicit, s);
    expect(readHumanCursorConfig(s)).toEqual(explicit);
  });
});

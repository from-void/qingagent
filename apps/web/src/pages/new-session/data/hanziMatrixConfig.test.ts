// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("汉字矩阵字符池持久化", () => {
  it("无持久化配置时随机初始化一次并写回，后续配置更新保持同一字符池", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const configStore = await import("./hanziMatrixConfig");

    const initial = configStore.getHanziMatrixConfig();
    const persisted = JSON.parse(
      window.localStorage.getItem(configStore.HANZI_MATRIX_CONFIG_STORAGE_KEY) ?? "null",
    ) as { pool?: string } | null;
    const updated = configStore.setHanziMatrixConfig({ speed: 2 });

    expect(initial.pool).toBe("jizhiwengao");
    expect(persisted?.pool).toBe("jizhiwengao");
    expect(updated.pool).toBe("jizhiwengao");
    expect(random).toHaveBeenCalledTimes(1);
  });

  it("已有持久化配置时不再随机覆盖字符池", async () => {
    const configStore = await import("./hanziMatrixConfig");
    window.localStorage.setItem(
      configStore.HANZI_MATRIX_CONFIG_STORAGE_KEY,
      JSON.stringify({ pool: "hanshitie", speed: 1.2 }),
    );
    const random = vi.spyOn(Math, "random");

    const initial = configStore.getHanziMatrixConfig();
    const updated = configStore.setHanziMatrixConfig({ baseAlpha: 0.2 });

    expect(initial.pool).toBe("hanshitie");
    expect(updated.pool).toBe("hanshitie");
    expect(random).not.toHaveBeenCalled();
  });
});

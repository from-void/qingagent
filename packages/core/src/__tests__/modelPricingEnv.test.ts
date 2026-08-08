import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envNames = [
  "MODEL_PRICING_JSON",
  "DEEPSEEK_PRICING_JSON",
  "DEEPSEEK_PEAK_PRICING_JSON",
  "MODEL_PRICING_EPOCHS_JSON",
] as const;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  for (const name of envNames) delete process.env[name];
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("退役价目 env", () => {
  it.each(envNames)("检测到 %s 时 warn 且忽略", async (name) => {
    const baseline = (await import("../llm/modelPricing.js")).PRICING_SCHEDULE.revision;
    vi.resetModules();
    process.env[name] = JSON.stringify({ malicious: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const module = await import("../llm/modelPricing.js");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${name} 已退役`));
    expect(module.PRICING_SCHEDULE.revision).toBe(baseline);
  });
});

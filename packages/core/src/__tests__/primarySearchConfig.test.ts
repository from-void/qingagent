import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAppSettings = vi.hoisted(() => {
  const state = {
    raw: null as string | null,
    fail: false,
  };
  return {
    state,
    getAppSetting: vi.fn(async () => {
      if (state.fail) throw new Error("db unavailable");
      return state.raw;
    }),
  };
});

vi.mock("../db/appSettingsRepo.js", () => ({
  SETTING_SEARCH_PROVIDER_CONFIG: "search_provider_config",
  SETTING_SEARCH_PRIMARY: "search_primary",
  getAppSetting: mockAppSettings.getAppSetting,
}));

import {
  getPrimarySearchConfig,
  invalidatePrimarySearchConfig,
  parsePrimarySearchConfig,
} from "../search/managedSearch.js";

describe("parsePrimarySearchConfig — 主搜索配置脏路径", () => {
  beforeEach(() => {
    mockAppSettings.state.raw = null;
    mockAppSettings.state.fail = false;
    mockAppSettings.getAppSetting.mockClear();
    invalidatePrimarySearchConfig();
  });

  it.each([
    ["空值", null, { enabled: true }],
    ["非 JSON", "{not-json", { enabled: true }],
    ["JSON null", "null", { enabled: true }],
    ["数组", "[]", { enabled: true }],
    ["enabled 非 boolean", JSON.stringify({ enabled: "false", apiKey: "sk-valid" }), { enabled: true, apiKey: "sk-valid" }],
    ["apiKey 含空格", JSON.stringify({ enabled: false, apiKey: "sk bad" }), { enabled: false }],
    ["apiKey 含非 ASCII", JSON.stringify({ enabled: true, apiKey: "密钥" }), { enabled: true }],
    ["apiKey 超长", JSON.stringify({ enabled: true, apiKey: "a".repeat(501) }), { enabled: true }],
  ])("%s 时返回安全配置", (_name, raw, expected) => {
    expect(parsePrimarySearchConfig(raw)).toEqual(expected);
  });

  it("清洗 apiKey 首尾空白并保留显式关闭", () => {
    expect(parsePrimarySearchConfig(JSON.stringify({ enabled: false, apiKey: "  sk-live  " }))).toEqual({
      enabled: false,
      apiKey: "sk-live",
    });
  });

  it("DB 读取异常时返回上次成功配置", async () => {
    mockAppSettings.state.raw = JSON.stringify({ enabled: false, apiKey: "sk-last-good" });
    await expect(getPrimarySearchConfig()).resolves.toEqual({
      enabled: false,
      apiKey: "sk-last-good",
    });

    mockAppSettings.state.fail = true;
    mockAppSettings.state.raw = JSON.stringify({ enabled: true, apiKey: "sk-new" });
    invalidatePrimarySearchConfig();

    await expect(getPrimarySearchConfig()).resolves.toEqual({
      enabled: false,
      apiKey: "sk-last-good",
    });
  });
});

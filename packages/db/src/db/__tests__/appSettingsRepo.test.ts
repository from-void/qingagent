import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAppSetting,
  patchAppSettingJsonField,
  setAppSettingJsonField,
} from "../appSettingsRepo.js";
import {
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "./dbTestUtils.js";

let db: TempDocumentsDb;

beforeEach(() => {
  db = prepareTempDocumentsDb("qa-app-settings-");
});

afterEach(() => {
  db.cleanup();
});

describe("appSettingsRepo", () => {
  it("并发更新不同 JSON 字段时不会整表覆盖", async () => {
    await Promise.all([
      setAppSettingJsonField(
        "search_provider_config",
        "tavily",
        { enabled: true, apiKey: "tvly-1234" },
      ),
      setAppSettingJsonField(
        "search_provider_config",
        "searxng",
        { enabled: true, url: "https://search.example.com/" },
      ),
    ]);

    expect(JSON.parse((await getAppSetting("search_provider_config"))!)).toEqual({
      tavily: { enabled: true, apiKey: "tvly-1234" },
      searxng: { enabled: true, url: "https://search.example.com/" },
    });
  });

  it("并发 patch 同一 JSON 字段时合并各自属性", async () => {
    await Promise.all([
      patchAppSettingJsonField(
        "search_provider_config",
        "tavily",
        { enabled: true },
      ),
      patchAppSettingJsonField(
        "search_provider_config",
        "tavily",
        { apiKey: "tvly-5678" },
      ),
    ]);

    expect(JSON.parse((await getAppSetting("search_provider_config"))!)).toEqual({
      tavily: { enabled: true, apiKey: "tvly-5678" },
    });
  });
});

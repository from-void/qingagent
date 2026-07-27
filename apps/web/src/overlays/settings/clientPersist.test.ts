// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetClientPersistCacheForTests,
  isDesktopPersist,
  readPersisted,
  writePersistedAwaited,
} from "./clientPersist";
import {
  getSelectedModelProvider,
  getSelectedModelTier,
  readOfficialModelOverride,
  setSelectedModelProvider,
  setSelectedModelTier,
  writeOfficialModelOverride,
} from "./visitorKeyStore";

type ElectronBridge = {
  isDesktop?: boolean;
  getDeepseekApiKey?: () => string | null;
  setDeepseekApiKey?: (value: string | null) => Promise<boolean>;
  getCustomProvider?: () => string | null;
  setCustomProvider?: (value: string | null) => Promise<boolean>;
  getVisionProvider?: () => string | null;
  setVisionProvider?: (value: string | null) => Promise<boolean>;
  getOfficialModel?: () => string | null;
  setOfficialModel?: (value: string | null) => Promise<boolean>;
  getModelTier?: () => string | null;
  setModelTier?: (value: string | null) => Promise<boolean>;
  getKimiApiKey?: () => string | null;
  setKimiApiKey?: (value: string | null) => Promise<boolean>;
  getKimiCustomProvider?: () => string | null;
  setKimiCustomProvider?: (value: string | null) => Promise<boolean>;
  getKimiOfficialModel?: () => string | null;
  setKimiOfficialModel?: (value: string | null) => Promise<boolean>;
  getModelProvider?: () => string | null;
  setModelProvider?: (value: string | null) => Promise<boolean>;
};
const DEEPSEEK_KEY = "qingagent.deepseek_api_key";
const OFFICIAL_MODEL_KEY = "qingagent.official_model";
const MODEL_TIER_KEY = "qingagent.model_tier";
const MODEL_PROVIDER_KEY = "qingagent.model_provider";

function desktopBridge(
  initial: Record<string, string> = {},
  write: (key: string, value: string | null) => Promise<boolean> = async () => true,
): ElectronBridge {
  return {
    isDesktop: true,
    getDeepseekApiKey: () => initial[DEEPSEEK_KEY] ?? null,
    setDeepseekApiKey: (value) => write(DEEPSEEK_KEY, value),
    getCustomProvider: () => initial["qingagent.custom_provider"] ?? null,
    setCustomProvider: (value) => write("qingagent.custom_provider", value),
    getVisionProvider: () => initial["qingagent.vision_provider"] ?? null,
    setVisionProvider: (value) => write("qingagent.vision_provider", value),
    getOfficialModel: () => initial[OFFICIAL_MODEL_KEY] ?? null,
    setOfficialModel: (value) => write(OFFICIAL_MODEL_KEY, value),
    getModelTier: () => initial[MODEL_TIER_KEY] ?? null,
    setModelTier: (value) => write(MODEL_TIER_KEY, value),
    getKimiApiKey: () => initial["qingagent.kimi_api_key"] ?? null,
    setKimiApiKey: (value) => write("qingagent.kimi_api_key", value),
    getKimiCustomProvider: () => initial["qingagent.kimi_custom_provider"] ?? null,
    setKimiCustomProvider: (value) => write("qingagent.kimi_custom_provider", value),
    getKimiOfficialModel: () => initial["qingagent.kimi_official_model"] ?? null,
    setKimiOfficialModel: (value) => write("qingagent.kimi_official_model", value),
    getModelProvider: () => initial["qingagent.model_provider"] ?? null,
    setModelProvider: (value) => write("qingagent.model_provider", value),
  };
}

function setElectron(bridge: ElectronBridge | undefined): void {
  (window as unknown as { electron?: ElectronBridge }).electron = bridge;
  __resetClientPersistCacheForTests();
}

describe("clientPersist", () => {
  afterEach(() => {
    setElectron(undefined);
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  describe("web(无 window.electron)走 localStorage", () => {
    it("写后能读回,删后为 null", async () => {
      setElectron(undefined);
      expect(isDesktopPersist()).toBe(false);
      await expect(writePersistedAwaited("k", "v")).resolves.toBe(true);
      expect(readPersisted("k")).toBe("v");
      expect(window.localStorage.getItem("k")).toBe("v");
      await expect(writePersistedAwaited("k", null)).resolves.toBe(true);
      expect(readPersisted("k")).toBeNull();
      expect(window.localStorage.getItem("k")).toBeNull();
    });
  });

  describe("桌面具名单项 API 走 userData", () => {
    it("按需读单项 / 写更新内存镜像并落盘 / 删除", async () => {
      const write = vi.fn(async () => true);
      setElectron(desktopBridge({ [OFFICIAL_MODEL_KEY]: "snap" }, write));
      expect(isDesktopPersist()).toBe(true);
      expect(readPersisted(OFFICIAL_MODEL_KEY)).toBe("snap");

      const writePending = writePersistedAwaited(OFFICIAL_MODEL_KEY, "v1");
      expect(write).toHaveBeenCalledWith(OFFICIAL_MODEL_KEY, "v1");
      // 同步从内存镜像读到最新值(不依赖异步落盘)
      expect(readPersisted(OFFICIAL_MODEL_KEY)).toBe("v1");
      await expect(writePending).resolves.toBe(true);
      // 桌面路径不写 localStorage
      expect(window.localStorage.getItem(OFFICIAL_MODEL_KEY)).toBeNull();

      await expect(writePersistedAwaited(OFFICIAL_MODEL_KEY, null)).resolves.toBe(true);
      expect(write).toHaveBeenLastCalledWith(OFFICIAL_MODEL_KEY, null);
      expect(readPersisted(OFFICIAL_MODEL_KEY)).toBeNull();
    });

    it("没有已保存值时仍判定为桌面持久化", () => {
      setElectron(desktopBridge());
      expect(isDesktopPersist()).toBe(true);
    });

    it.each([
      "qingagent.kimi_api_key",
      "qingagent.kimi_custom_provider",
      "qingagent.kimi_official_model",
      "qingagent.model_provider",
    ])("%s 走桌面 userData 而非随机端口 localStorage", async (key) => {
      const write = vi.fn(async () => true);
      setElectron(desktopBridge({ [key]: "old" }, write));

      expect(readPersisted(key)).toBe("old");
      await expect(writePersistedAwaited(key, "new")).resolves.toBe(true);

      expect(write).toHaveBeenCalledWith(key, "new");
      expect(readPersisted(key)).toBe("new");
      expect(window.localStorage.getItem(key)).toBeNull();
    });

    it("敏感写入可等待，IPC 失败后恢复写入前的内存镜像", async () => {
      let finishWrite: ((ok: boolean) => void) | undefined;
      const write = vi.fn(() => new Promise<boolean>((resolve) => {
        finishWrite = resolve;
      }));
      setElectron(desktopBridge({ [DEEPSEEK_KEY]: "old" }, write));

      const pending = writePersistedAwaited(DEEPSEEK_KEY, "new");
      // IPC 等待期间仍满足 visitorKeyHeaders 一类调用方的同步读取约束。
      expect(readPersisted(DEEPSEEK_KEY)).toBe("new");
      finishWrite?.(false);

      await expect(pending).resolves.toBe(false);
      expect(readPersisted(DEEPSEEK_KEY)).toBe("old");
    });

    it("敏感删除失败时恢复原值，不能制造已清除假象", async () => {
      setElectron(desktopBridge({ [DEEPSEEK_KEY]: "secret" }, async () => false));

      await expect(writePersistedAwaited(DEEPSEEK_KEY, null)).resolves.toBe(false);
      expect(readPersisted(DEEPSEEK_KEY)).toBe("secret");
    });

    it("provider、档位与官方别名写入失败时返回失败并恢复旧配置", async () => {
      setElectron(desktopBridge({
        [MODEL_PROVIDER_KEY]: "deepseek",
        [MODEL_TIER_KEY]: "flash",
        [OFFICIAL_MODEL_KEY]: JSON.stringify({ flash: "old-flash" }),
      }, async () => false));

      await expect(setSelectedModelProvider("kimi")).resolves.toBe(false);
      await expect(setSelectedModelTier("pro")).resolves.toBe(false);
      await expect(writeOfficialModelOverride({ flash: "new-flash" })).resolves.toBe(false);

      expect(getSelectedModelProvider()).toBe("deepseek");
      expect(getSelectedModelTier()).toBe("flash");
      expect(readOfficialModelOverride()).toEqual({ flash: "old-flash" });
    });

    it("旧 preload 缺具名配置 API 时回退 localStorage", async () => {
      setElectron({ isDesktop: true });
      expect(isDesktopPersist()).toBe(false);
      await expect(writePersistedAwaited(DEEPSEEK_KEY, "v")).resolves.toBe(true);
      expect(window.localStorage.getItem(DEEPSEEK_KEY)).toBe("v");
    });
  });
});

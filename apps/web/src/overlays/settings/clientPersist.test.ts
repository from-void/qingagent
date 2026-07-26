// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetClientPersistCacheForTests,
  isDesktopPersist,
  readPersisted,
  writePersisted,
  writePersistedAwaited,
} from "./clientPersist";

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
    it("写后能读回,删后为 null", () => {
      setElectron(undefined);
      expect(isDesktopPersist()).toBe(false);
      writePersisted("k", "v");
      expect(readPersisted("k")).toBe("v");
      expect(window.localStorage.getItem("k")).toBe("v");
      writePersisted("k", null);
      expect(readPersisted("k")).toBeNull();
      expect(window.localStorage.getItem("k")).toBeNull();
    });
  });

  describe("桌面具名单项 API 走 userData", () => {
    it("按需读单项 / 写更新内存镜像并落盘 / 删除", () => {
      const write = vi.fn(async () => true);
      setElectron(desktopBridge({ [OFFICIAL_MODEL_KEY]: "snap" }, write));
      expect(isDesktopPersist()).toBe(true);
      expect(readPersisted(OFFICIAL_MODEL_KEY)).toBe("snap");

      writePersisted(OFFICIAL_MODEL_KEY, "v1");
      expect(write).toHaveBeenCalledWith(OFFICIAL_MODEL_KEY, "v1");
      // 同步从内存镜像读到最新值(不依赖异步落盘)
      expect(readPersisted(OFFICIAL_MODEL_KEY)).toBe("v1");
      // 桌面路径不写 localStorage
      expect(window.localStorage.getItem(OFFICIAL_MODEL_KEY)).toBeNull();

      writePersisted(OFFICIAL_MODEL_KEY, null);
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
    ])("%s 走桌面 userData 而非随机端口 localStorage", (key) => {
      const write = vi.fn(async () => true);
      setElectron(desktopBridge({ [key]: "old" }, write));

      expect(readPersisted(key)).toBe("old");
      writePersisted(key, "new");

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

    it("旧 preload 缺具名配置 API 时回退 localStorage", () => {
      setElectron({ isDesktop: true });
      expect(isDesktopPersist()).toBe(false);
      writePersisted(DEEPSEEK_KEY, "v");
      expect(window.localStorage.getItem(DEEPSEEK_KEY)).toBe("v");
    });
  });
});

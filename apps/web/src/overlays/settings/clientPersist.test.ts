// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetClientPersistCacheForTests,
  isDesktopPersist,
  readPersisted,
  writePersisted,
} from "./clientPersist";

type ElectronBridge = {
  clientConfig?: Record<string, string>;
  setClientConfig?: (patch: Record<string, string | null>) => Promise<boolean>;
};
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

  describe("桌面(window.electron.clientConfig)走 userData", () => {
    it("读初值快照 / 写更新内存镜像并落盘(setClientConfig) / 删除", () => {
      const setClientConfig = vi.fn(async () => true);
      setElectron({ clientConfig: { existing: "snap" }, setClientConfig });
      expect(isDesktopPersist()).toBe(true);
      // 读 preload 注入的快照
      expect(readPersisted("existing")).toBe("snap");

      writePersisted("k", "v1");
      expect(setClientConfig).toHaveBeenCalledWith({ k: "v1" });
      // 同步从内存镜像读到最新值(不依赖异步落盘)
      expect(readPersisted("k")).toBe("v1");
      // 桌面路径不写 localStorage
      expect(window.localStorage.getItem("k")).toBeNull();

      writePersisted("k", null);
      expect(setClientConfig).toHaveBeenLastCalledWith({ k: null });
      expect(readPersisted("k")).toBeNull();
    });

    it("clientConfig 为空对象时仍判定为桌面持久化", () => {
      setElectron({ clientConfig: {}, setClientConfig: vi.fn(async () => true) });
      expect(isDesktopPersist()).toBe(true);
    });

    it("缺 clientConfig(旧 preload)时回退 localStorage", () => {
      setElectron({ setClientConfig: vi.fn(async () => true) });
      expect(isDesktopPersist()).toBe(false);
      writePersisted("k", "v");
      expect(window.localStorage.getItem("k")).toBe("v");
    });
  });
});

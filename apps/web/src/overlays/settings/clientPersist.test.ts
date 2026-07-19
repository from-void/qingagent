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

    it("敏感写入可等待，IPC 失败后恢复写入前的内存镜像", async () => {
      let finishWrite: ((ok: boolean) => void) | undefined;
      const setClientConfig = vi.fn(() => new Promise<boolean>((resolve) => {
        finishWrite = resolve;
      }));
      setElectron({ clientConfig: { k: "old" }, setClientConfig });

      const pending = writePersistedAwaited("k", "new");
      // IPC 等待期间仍满足 visitorKeyHeaders 一类调用方的同步读取约束。
      expect(readPersisted("k")).toBe("new");
      finishWrite?.(false);

      await expect(pending).resolves.toBe(false);
      expect(readPersisted("k")).toBe("old");
    });

    it("敏感删除失败时恢复原值，不能制造已清除假象", async () => {
      setElectron({ clientConfig: { k: "secret" }, setClientConfig: vi.fn(async () => false) });

      await expect(writePersistedAwaited("k", null)).resolves.toBe(false);
      expect(readPersisted("k")).toBe("secret");
    });

    it("缺 clientConfig(旧 preload)时回退 localStorage", () => {
      setElectron({ setClientConfig: vi.fn(async () => true) });
      expect(isDesktopPersist()).toBe(false);
      writePersisted("k", "v");
      expect(window.localStorage.getItem("k")).toBe("v");
    });
  });
});

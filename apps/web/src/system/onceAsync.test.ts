import { describe, expect, it, vi } from "vitest";
import { onceAsync } from "./onceAsync";

describe("onceAsync", () => {
  it("只执行一次工厂,后续调用复用同一个 promise", async () => {
    // 这是修「无样式裸 DOM」的关键:预热与 React.lazy 必须落在同一次 __vitePreload 上,
    // 否则第二次调用命中 Vite 的 seen 去重、不等 CSS 就交出 chunk。
    const factory = vi.fn(() => Promise.resolve("mod"));
    const load = onceAsync(factory);

    const a = load();
    const b = load();
    expect(a).toBe(b); // 同一个 promise 实例,不是两次 import
    await expect(a).resolves.toBe("mod");
    await expect(load()).resolves.toBe("mod");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("失败不缓存 —— 一次网络抖动不能把路由永久钉死", async () => {
    const factory = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("chunk 加载失败"))
      .mockResolvedValueOnce("mod");
    const load = onceAsync(factory);

    await expect(load()).rejects.toThrow("chunk 加载失败");
    // 若把 rejected promise 缓存住,这里会拿到同一个失败,页面再也打不开
    await expect(load()).resolves.toBe("mod");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("并发调用不会重复触发工厂", async () => {
    let resolveIt: ((value: string) => void) | undefined;
    const factory = vi.fn(
      () =>
        new Promise<string>((res) => {
          resolveIt = res;
        }),
    );
    const load = onceAsync(factory);

    const calls = [load(), load(), load()];
    resolveIt?.("mod");
    await expect(Promise.all(calls)).resolves.toEqual(["mod", "mod", "mod"]);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

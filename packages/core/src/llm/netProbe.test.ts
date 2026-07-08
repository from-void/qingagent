import { channel } from "node:diagnostics_channel";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatElapsedMs,
  installNetProbe,
  isFreshConnection,
  pathnameOnly,
  shouldLogOrigin,
} from "./netProbe";

describe("netProbe", () => {
  let uninstall: (() => void) | null = null;
  const originalFlag = process.env.QINGAGENT_NET_PROBE;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    if (originalFlag === undefined) {
      delete process.env.QINGAGENT_NET_PROBE;
    } else {
      process.env.QINGAGENT_NET_PROBE = originalFlag;
    }
    vi.restoreAllMocks();
  });

  it("格式化耗时与本地 origin 过滤", () => {
    expect(formatElapsedMs(10, 42.4)).toBe(32);
    expect(formatElapsedMs(42, 10)).toBe(0);
    expect(shouldLogOrigin("https://api.deepseek.com")).toBe(true);
    expect(shouldLogOrigin("http://localhost:8080")).toBe(false);
    expect(shouldLogOrigin("http://127.0.0.1:8080")).toBe(false);
    expect(shouldLogOrigin("http://[::1]:8080")).toBe(false);
    expect(shouldLogOrigin("not a url")).toBe(false);
  });

  it("path 只保留 pathname,不记录 query", () => {
    expect(pathnameOnly("/chat/completions?token=secret")).toBe("/chat/completions");
    expect(pathnameOnly("https://api.example.com/v1/models?api_key=secret")).toBe("/v1/models");
    expect(pathnameOnly("")).toBe("/");
  });

  it("freshConn 只看请求 create 之后的 connected", () => {
    expect(isFreshConnection(100, undefined)).toBe(false);
    expect(isFreshConnection(100, 99)).toBe(false);
    expect(isFreshConnection(100, 100)).toBe(true);
    expect(isFreshConnection(100, 101)).toBe(true);
  });

  it("通过 diagnostics_channel 记录 connect 与 ttfb", () => {
    const log = vi.fn();
    uninstall = installNetProbe(log);
    const request = { origin: "https://api.deepseek.com", path: "/v1/chat/completions?secret=1" };

    channel("undici:client:beforeConnect").publish({
      connectParams: { origin: "https://api.deepseek.com" },
    });
    channel("undici:request:create").publish({ request });
    channel("undici:client:connected").publish({
      connectParams: { origin: "https://api.deepseek.com" },
    });
    channel("undici:request:headers").publish({ request });

    expect(log.mock.calls[0]?.[0]).toMatch(/^\[netprobe\] connect origin=https:\/\/api\.deepseek\.com ms=\d+$/);
    expect(log.mock.calls[1]?.[0]).toMatch(
      /^\[netprobe\] ttfb origin=https:\/\/api\.deepseek\.com path=\/v1\/chat\/completions ms=\d+ freshConn=true$/,
    );
    expect(log.mock.calls[1]?.[0]).not.toContain("secret");
  });

  it("记录 connectError 并忽略本地 API 噪音", () => {
    const log = vi.fn();
    uninstall = installNetProbe(log);

    channel("undici:client:beforeConnect").publish({
      connectParams: { origin: "http://127.0.0.1:8080" },
    });
    channel("undici:client:connected").publish({
      connectParams: { origin: "http://127.0.0.1:8080" },
    });
    channel("undici:client:connectError").publish({
      connectParams: { origin: "https://api.deepseek.com" },
      error: new Error("tls failed"),
    });

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(
      /^\[netprobe\] connectError origin=https:\/\/api\.deepseek\.com ms=\d+ err=tls failed$/,
    );
  });

  it("重复安装复用第一次订阅,关闭开关时 no-op", () => {
    const log = vi.fn();
    uninstall = installNetProbe(log);
    const secondUninstall = installNetProbe(vi.fn());
    expect(secondUninstall).toBe(uninstall);

    channel("undici:client:connected").publish({
      connectParams: { origin: "https://api.deepseek.com" },
    });
    expect(log).toHaveBeenCalledTimes(1);

    uninstall();
    uninstall = null;
    process.env.QINGAGENT_NET_PROBE = "0";
    const disabledLog = vi.fn();
    uninstall = installNetProbe(disabledLog);
    channel("undici:client:connected").publish({
      connectParams: { origin: "https://api.deepseek.com" },
    });
    expect(disabledLog).not.toHaveBeenCalled();
  });
});

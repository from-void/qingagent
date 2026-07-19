import { beforeEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import {
  assertFetchAddressAllowed,
  createPinnedLookup,
  validateAndPinFetchUrl,
} from "./fetchUrlPolicy.js";

describe("fetchUrlPolicy 已解析地址策略", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it.each([
    "93.184.216.34",
    "2606:2800:220:1:248:1893:25c8:1946",
  ])("允许连接层固定到公网地址:%s", (address) => {
    expect(() => assertFetchAddressAllowed(address, "model.example.com")).not.toThrow();
  });

  it.each([
    "10.0.0.9",
    "169.254.169.254",
    "192.168.1.8",
    "fd12:3456::1",
    "fe80::1",
  ])("拒绝 DNS/连接层返回私网地址:%s", (address) => {
    expect(() => assertFetchAddressAllowed(address, "rebind.example.com")).toThrow(
      /Blocked private/,
    );
  });

  it("只允许显式 localhost/字面 IP 使用 loopback 逃生语义", () => {
    expect(() => assertFetchAddressAllowed("127.0.0.1", "localhost", {
      allowLoopback: true,
    })).not.toThrow();
    expect(() => assertFetchAddressAllowed("::1", "[::1]", {
      allowLoopback: true,
    })).not.toThrow();
    expect(() => assertFetchAddressAllowed("127.0.0.1", "rebind.example.com", {
      allowLoopback: true,
    })).toThrow(/Blocked loopback/);
  });

  it("显式 allowPrivate 仍作为部署逃生舱放行", () => {
    expect(() => assertFetchAddressAllowed("10.0.0.9", "private-model.example", {
      allowPrivate: true,
    })).not.toThrow();
    expect(() => assertFetchAddressAllowed("127.0.0.1", "private-model.example", {
      allowPrivate: true,
    })).not.toThrow();
  });

  it("域名校验后固定首个公网地址，连接 lookup 不再查询 DNS", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);

    const target = await validateAndPinFetchUrl("https://example.com/article");
    expect(target).toMatchObject({
      address: "93.184.216.34",
      family: 4,
    });

    const pinnedLookup = createPinnedLookup(target);
    const resolved = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
      pinnedLookup("rebind.example.com", {}, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: address as string, family });
      });
    });

    expect(resolved).toEqual({ address: "93.184.216.34", family: 4 });
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it("任一 DNS 结果落到私网时整次拒绝，不会选一个公网结果蒙混通过", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.9", family: 4 },
    ]);

    await expect(validateAndPinFetchUrl("https://rebind.example.com/")).rejects.toThrow(
      /Blocked private/,
    );
  });
});

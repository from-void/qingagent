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
    "1.1.1.1",
    "100.63.255.255",
    "100.128.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "93.184.216.34",
    "2001:4860:4860::8888",
    "2606:2800:220:1:248:1893:25c8:1946",
  ])("允许连接层固定到公网地址:%s", (address) => {
    expect(() => assertFetchAddressAllowed(address, "model.example.com")).not.toThrow();
  });

  it.each([
    ["IPv4 未指定网络", "0.1.2.3"],
    ["IPv4 私网 10/8", "10.0.0.9"],
    ["IPv4 CGNAT", "100.64.0.1"],
    ["IPv4 loopback", "127.0.0.1"],
    ["IPv4 link-local/metadata", "169.254.169.254"],
    ["IPv4 私网 172.16/12", "172.31.255.255"],
    ["IPv4 IETF 协议保留", "192.0.0.9"],
    ["IPv4 TEST-NET-1", "192.0.2.1"],
    ["IPv4 私网 192.168/16", "192.168.1.8"],
    ["IPv4 benchmark", "198.18.0.1"],
    ["IPv4 TEST-NET-2", "198.51.100.2"],
    ["IPv4 TEST-NET-3", "203.0.113.9"],
    ["IPv4 multicast", "224.0.0.1"],
    ["IPv4 reserved", "240.0.0.1"],
    ["IPv4 limited broadcast", "255.255.255.255"],
    ["IPv6 unspecified", "::"],
    ["IPv6 loopback", "::1"],
    ["IPv4-compatible IPv6", "::8.8.8.8"],
    ["IPv4-mapped IPv6", "::ffff:8.8.8.8"],
    ["IPv6 NAT64 well-known prefix", "64:ff9b::808:808"],
    ["IPv6 discard-only", "100::1"],
    ["IPv6 IETF special assignments", "2001::1"],
    ["IPv6 benchmarking", "2001:2::1"],
    ["IPv6 documentation", "2001:db8::1"],
    ["IPv6 6to4", "2002:0808:0808::1"],
    ["IPv6 AS112 special-purpose", "2620:4f:8000::1"],
    ["IPv6 ULA", "fd12:3456::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv6 deprecated site-local", "fec0::1"],
    ["IPv6 multicast", "ff02::1"],
    ["IPv6 documentation 3fff", "3fff::1"],
  ])("拒绝非 global-unicast：%s (%s)", (_label, address) => {
    expect(() => assertFetchAddressAllowed(address, "rebind.example.com")).toThrow(
      /Blocked (?:loopback|private\/non-global-unicast)/,
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
      /Blocked private\/non-global-unicast/,
    );
  });
});

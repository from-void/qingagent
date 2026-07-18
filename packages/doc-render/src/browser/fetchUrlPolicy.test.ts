import { describe, expect, it } from "vitest";
import { assertFetchAddressAllowed } from "./fetchUrlPolicy.js";

describe("fetchUrlPolicy 已解析地址策略", () => {
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
});

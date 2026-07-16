import { beforeEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));

import { validateFetchUrl } from "@qingagent/doc-render/fetch-url";
import { modelFetch } from "./modelTransport.js";
import { allowsPrivateModelHost, validateModelFetchUrl } from "./modelFetchUrl.js";

describe("主模型 URL SSRF 策略", () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockImplementation(async (hostname: string) => {
      if (hostname === "api.deepseek.com") {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      if (hostname === "loopback.example.com") {
        return [{ address: "127.0.0.1", family: 4 }];
      }
      throw new Error(`unresolved ${hostname}`);
    });
  });

  it.each([
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.8/v1",
    "http://172.16.0.8/v1",
    "http://192.168.1.8/v1",
    "http://[fc00::1]:8080/v1",
    "http://[fd12:3456::1]/v1",
    "http://[fe90::1]/v1",
  ])("默认拒绝私网、链路本地与云元数据地址:%s", async (url) => {
    await expect(validateModelFetchUrl(url, {})).rejects.toThrow(/Blocked private/);
  });

  it.each([
    "http://2852039166/latest/meta-data",
    "http://0xa9fea9fe/latest/meta-data",
    "http://167772161/v1",
    "http://0x0a000001/v1",
  ])("拒绝十进制/十六进制 IPv4 基本绕过:%s", async (url) => {
    await expect(validateModelFetchUrl(url, {})).rejects.toThrow(/Blocked private/);
  });

  it.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://[::1]:8080/v1",
  ])("允许显式 loopback 本地模型:%s", async (url) => {
    await expect(validateModelFetchUrl(url, {})).resolves.toBeInstanceOf(URL);
  });

  it("允许解析到公网地址的域名", async () => {
    const checked = await validateModelFetchUrl("https://api.deepseek.com/v1", {});
    expect(checked.hostname).toBe("api.deepseek.com");
    expect(lookupMock).toHaveBeenCalledWith("api.deepseek.com", { all: true, verbatim: true });
  });

  it("普通域名即使解析到 loopback 也拒绝", async () => {
    await expect(
      validateModelFetchUrl("https://loopback.example.com/v1", {}),
    ).rejects.toThrow(/Blocked loopback/);
  });

  it.each([
    "http://10.0.0.8/v1",
    "http://192.168.1.8/v1",
    "http://169.254.169.254/latest/meta-data",
    "http://[fc00::1]:8080/v1",
  ])("逃生舱 =1 时放行私网地址:%s", async (url) => {
    await expect(
      validateModelFetchUrl(url, { QINGAGENT_ALLOW_PRIVATE_MODEL_HOST: "1" }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("逃生舱只接受精确值 1", () => {
    expect(allowsPrivateModelHost({ QINGAGENT_ALLOW_PRIVATE_MODEL_HOST: "1" })).toBe(true);
    expect(allowsPrivateModelHost({ QINGAGENT_ALLOW_PRIVATE_MODEL_HOST: "true" })).toBe(false);
    expect(allowsPrivateModelHost({})).toBe(false);
  });

  it("公共抓取策略仍默认拒绝 loopback", async () => {
    await expect(validateFetchUrl("http://127.0.0.1:11434/v1")).rejects.toThrow(
      /Blocked loopback/,
    );
  });

  it("modelFetch 在建立连接前执行同一策略兜底", async () => {
    await expect(modelFetch("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /Blocked private/,
    );
  });
});

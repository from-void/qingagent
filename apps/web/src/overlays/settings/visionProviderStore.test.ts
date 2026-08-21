// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearVisionProvider,
  isHttpUrl,
  readVisionProvider,
  readVisionSource,
  repairBaseUrlScheme,
  visionKeyHeaders,
  writeVisionSource,
  writeVisionProvider,
  type VisionProvider,
} from "./visionProviderStore";
import { setVisitorModelKey, visitorKeyHeaders } from "./visitorKeyStore";

// 图像识别副基模配置 store:read/write/clear + header 透传。
// 重点测脏形态(不可信 localStorage):坏 JSON、缺字段、enabled 缺省/关闭。

const KEY = "qingagent.vision_provider";

const VALID: VisionProvider = {
  enabled: true,
  protocol: "openai",
  baseUrl: "https://vl.example.com/v1",
  apiKey: "sk-vl-123456",
  model: "qwen-vl-max",
};

function setRaw(raw: string): void {
  window.localStorage.setItem(KEY, raw);
}

describe("visionProviderStore", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("write 后 read 回完整配置", () => {
    writeVisionProvider(VALID);
    expect(readVisionProvider()).toEqual(VALID);
  });

  it("未配置时 read 返回 null", () => {
    expect(readVisionProvider()).toBeNull();
  });

  it("坏 JSON 返回 null,不抛", () => {
    setRaw("{not json");
    expect(readVisionProvider()).toBeNull();
  });

  it("缺 baseUrl / apiKey / model 任一 → 视为未配置返回 null", () => {
    setRaw(JSON.stringify({ enabled: true, protocol: "openai", apiKey: "k", model: "m" }));
    expect(readVisionProvider()).toBeNull();
    setRaw(JSON.stringify({ enabled: true, protocol: "openai", baseUrl: "u", model: "m" }));
    expect(readVisionProvider()).toBeNull();
    setRaw(JSON.stringify({ enabled: true, protocol: "openai", baseUrl: "u", apiKey: "k" }));
    expect(readVisionProvider()).toBeNull();
  });

  it("空字符串字段也算未配置", () => {
    setRaw(JSON.stringify({ ...VALID, apiKey: "" }));
    expect(readVisionProvider()).toBeNull();
  });

  it("enabled 缺省按 true;protocol 非法回退 openai", () => {
    setRaw(JSON.stringify({ baseUrl: "https://e.com/v1", apiKey: "k", model: "m", protocol: "weird" }));
    const v = readVisionProvider();
    expect(v?.enabled).toBe(true);
    expect(v?.protocol).toBe("openai");
  });

  // round-2:脏值归一化(trim + baseUrl 必须 http(s),否则视为未配置不发 header)
  it("字段两侧空白被 trim", () => {
    setRaw(JSON.stringify({ baseUrl: "  https://e.com/v1  ", apiKey: " k ", model: " m ", protocol: "openai" }));
    const v = readVisionProvider();
    expect(v?.baseUrl).toBe("https://e.com/v1");
    expect(v?.apiKey).toBe("k");
    expect(v?.model).toBe("m");
  });

  it("baseUrl 非 http(s) URL → 视为未配置返回 null", () => {
    setRaw(JSON.stringify({ baseUrl: "u", apiKey: "k", model: "m" }));
    expect(readVisionProvider()).toBeNull();
    setRaw(JSON.stringify({ baseUrl: "ftp://e.com", apiKey: "k", model: "m" }));
    expect(readVisionProvider()).toBeNull();
    setRaw(JSON.stringify({ baseUrl: "javascript:alert(1)", apiKey: "k", model: "m" }));
    expect(readVisionProvider()).toBeNull();
  });

  it.each([
    ["", false],
    ["ftp://x.example", false],
    ["javascript:alert(1)", false],
    ["//x.example", false],
    ["http://", false],
    ["http://x.example", true],
    ["https://x.example/v1", true],
  ])("isHttpUrl 脏输入校验:%s", (value, expected) => {
    expect(isHttpUrl(value)).toBe(expected);
  });

  // 只补 scheme 这一种修复:漏 http(s):// 的地址转成提示继续走测试,别的格式错照旧判非法。
  it.each([
    ["api.example.com/v1", "https://api.example.com/v1"],
    ["api.example.com/v1/chat/completions", "https://api.example.com/v1/chat/completions"],
    ["localhost:11434/v1", "https://localhost:11434/v1"],
    ["127.0.0.1:1234/v1", "https://127.0.0.1:1234/v1"],
    ["  proxy.example.com/v1  ", "https://proxy.example.com/v1"],
    ["https://x.example/v1", "https://x.example/v1"],
    ["", null],
    ["not-a-url", null],
    ["ftp://x.example", null],
    ["javascript:alert(1)", null],
  ])("repairBaseUrlScheme:%s", (value, expected) => {
    expect(repairBaseUrlScheme(value)).toBe(expected);
  });

  it("clear 后 read 返回 null", () => {
    writeVisionProvider(VALID);
    clearVisionProvider();
    expect(readVisionProvider()).toBeNull();
  });

  it("visionKeyHeaders:启用时输出全部 x-vision-* header", () => {
    writeVisionProvider(VALID);
    expect(visionKeyHeaders()).toEqual({
      "x-vision-key": "sk-vl-123456",
      "x-vision-base-url": "https://vl.example.com/v1",
      "x-vision-model": "qwen-vl-max",
      "x-vision-protocol": "openai",
    });
  });

  it("visionKeyHeaders:停用或未配置时为空对象(header 不透传)", () => {
    expect(visionKeyHeaders()).toEqual({});
    writeVisionProvider({ ...VALID, enabled: false });
    expect(visionKeyHeaders()).toEqual({});
  });

  it("source 与旧自定义配置共用同一存储对象并互不覆盖", async () => {
    await writeVisionProvider(VALID);
    await writeVisionSource("deepseek");
    expect(readVisionSource()).toBe("deepseek");
    expect(readVisionProvider()).toEqual(VALID);

    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    expect(raw.source).toBe("deepseek");
    expect(window.localStorage).toHaveLength(1);
  });

  it("DeepSeek/Kimi source 只发送 source 与对应官方 visitor key", async () => {
    await setVisitorModelKey("deepseek", "deepseek-official-key");
    await setVisitorModelKey("kimi", "kimi-official-key");

    await writeVisionSource("deepseek");
    expect(visitorKeyHeaders()).toMatchObject({
      "x-vision-source": "deepseek",
      "x-vision-key": "deepseek-official-key",
    });
    expect(visitorKeyHeaders()).not.toHaveProperty("x-vision-base-url");
    expect(visitorKeyHeaders()).not.toHaveProperty("x-vision-model");

    await writeVisionSource("kimi");
    expect(visitorKeyHeaders()).toMatchObject({
      "x-vision-source": "kimi",
      "x-vision-key": "kimi-official-key",
    });
    expect(visitorKeyHeaders()).not.toHaveProperty("x-vision-base-url");
    expect(visitorKeyHeaders()).not.toHaveProperty("x-vision-model");
  });

  it("custom source 沿用旧三件套；source 缺省时 header 行为逐字不变", async () => {
    await writeVisionProvider(VALID);
    expect(visitorKeyHeaders()).toMatchObject({
      "x-vision-key": VALID.apiKey,
      "x-vision-base-url": VALID.baseUrl,
      "x-vision-model": VALID.model,
      "x-vision-protocol": VALID.protocol,
    });
    expect(visitorKeyHeaders()).not.toHaveProperty("x-vision-source");

    await writeVisionSource("custom");
    expect(visitorKeyHeaders()).toMatchObject({
      "x-vision-source": "custom",
      "x-vision-key": VALID.apiKey,
      "x-vision-base-url": VALID.baseUrl,
      "x-vision-model": VALID.model,
      "x-vision-protocol": VALID.protocol,
    });
  });
});

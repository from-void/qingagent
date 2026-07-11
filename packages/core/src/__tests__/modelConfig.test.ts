import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import {
  DEEPSEEK_MODEL_IDS,
  resolveDeepseekAuth,
  resolveModelId,
  resolveModelParams,
  resolveProtocol,
  resolveVisionConfig,
  getDeepseekModel,
} from "../llm/modelConfig.js";

const originalDeepseekApiKey = process.env.DEEPSEEK_API_KEY;
const ENV_KEYS = ["QINGAGENT_MODEL_PROTOCOL", "QINGAGENT_MODEL_FLASH", "QINGAGENT_MODEL_PRO"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function requestContext(entries: Array<[string, unknown]> = []): RequestContext {
  return new RequestContext(entries as never) as unknown as RequestContext;
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalDeepseekApiKey === undefined) {
    delete process.env.DEEPSEEK_API_KEY;
  } else {
    process.env.DEEPSEEK_API_KEY = originalDeepseekApiKey;
  }
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k]!;
  }
});

describe("modelConfig", () => {
  it("按 visitor > global-db > env > none 解析 DeepSeek key", () => {
    process.env.DEEPSEEK_API_KEY = "env-key";

    expect(
      resolveDeepseekAuth(requestContext([
        ["modelOverrides", { visitorApiKey: "visitor-key", globalApiKey: "global-key" }],
      ])),
    ).toEqual({ apiKey: "visitor-key", origin: "visitor" });

    expect(
      resolveDeepseekAuth(requestContext([
        ["modelOverrides", { globalApiKey: "global-key" }],
      ])),
    ).toEqual({ apiKey: "global-key", origin: "global-db" });

    expect(resolveDeepseekAuth(requestContext())).toEqual({
      apiKey: "env-key",
      origin: "env",
    });

    delete process.env.DEEPSEEK_API_KEY;
    expect(resolveDeepseekAuth(requestContext())).toEqual({
      apiKey: "",
      origin: "none",
    });
  });

  it("env 层(QINGAGENT_MODEL_PROTOCOL/_FLASH)在无访客覆盖时生效(GLM 共享 .env 场景)", () => {
    process.env.QINGAGENT_MODEL_PROTOCOL = "anthropic";
    process.env.QINGAGENT_MODEL_FLASH = "glm-4.6";

    // 无任何访客覆盖 -> 用 env 默认底座
    expect(resolveProtocol(requestContext())).toBe("anthropic");
    expect(resolveModelId(requestContext(), "flash")).toBe("glm-4.6");
  });

  it("env 层是最低优先级:访客覆盖 > env", () => {
    process.env.QINGAGENT_MODEL_PROTOCOL = "anthropic";
    process.env.QINGAGENT_MODEL_FLASH = "glm-4.6";

    // 访客显式给出模型别名 -> 覆盖 env
    expect(
      resolveModelId(
        requestContext([["modelOverrides", { modelIds: { flash: "visitor-model" } }]]),
        "flash",
      ),
    ).toBe("visitor-model");
  });

  it("当前档位为 pro 时,QINGAGENT_MODEL_PRO 生效且 flash 默认仍不变", () => {
    process.env.QINGAGENT_MODEL_FLASH = "env-flash";
    process.env.QINGAGENT_MODEL_PRO = "env-pro";

    expect(resolveModelId(requestContext(), "flash")).toBe("env-flash");
    expect(resolveModelId(requestContext([["modelOverrides", { tier: "pro" }]]), "flash")).toBe("env-pro");
  });

  it("访客自带 endpoint(baseUrl)时不套用 env 协议/模型名,避免误把 anthropic 套到访客 openai 端点", () => {
    process.env.QINGAGENT_MODEL_PROTOCOL = "anthropic";
    process.env.QINGAGENT_MODEL_FLASH = "glm-4.6";

    const rc = requestContext([["modelOverrides", { baseUrl: "https://custom.example.com/v1" }]]);
    expect(resolveProtocol(rc)).toBe("openai");
    expect(resolveModelId(rc, "flash")).toBe(DEEPSEEK_MODEL_IDS.flash);
  });

  it("QINGAGENT_MODEL_PROTOCOL 非法值忽略,回退 openai", () => {
    process.env.QINGAGENT_MODEL_PROTOCOL = "garbage";
    expect(resolveProtocol(requestContext())).toBe("openai");
  });

  it("resolveModelParams 只透传有限数值并夹取采样参数", () => {
    const rc = requestContext([
      [
        "modelOverrides",
        {
          params: {
            temperature: 9,
            topP: -1,
            maxOutputTokens: 1024,
            ignored: "dirty",
          },
        },
      ],
    ]);

    expect(resolveModelParams(rc)).toEqual({
      temperature: 2,
      topP: 0,
      maxOutputTokens: 1024,
    });
  });

  it("resolveModelParams 忽略 NaN、字符串和非整数 maxOutputTokens", () => {
    const rc = requestContext([
      [
        "modelOverrides",
        {
          params: {
            temperature: Number.NaN,
            topP: "0.5",
            maxOutputTokens: 128.5,
          },
        },
      ],
    ]);

    expect(resolveModelParams(rc)).toEqual({});
  });

  it("resolveVisionConfig 无 vision key 时返回 null", async () => {
    const rc = requestContext([
      ["modelOverrides", { vision: { baseUrl: "https://vision.example.com/v1", model: "vision-model" } }],
    ]);

    await expect(resolveVisionConfig(rc)).resolves.toBeNull();
  });

  it("resolveVisionConfig 对 vision baseUrl 执行 SSRF 拦截", async () => {
    const rc = requestContext([
      [
        "modelOverrides",
        {
          vision: {
            apiKey: "vision-key",
            baseUrl: "http://127.0.0.1:11434/v1",
            model: "vision-model",
            protocol: "openai",
          },
        },
      ],
    ]);

    await expect(resolveVisionConfig(rc)).rejects.toThrow(/Blocked private/);
  });

  it("OpenAI 工厂把 thinking 开关写入请求体，enabled 时移除 temperature", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }));
    const options = {
      mode: { type: "regular" },
      inputFormat: "prompt",
      prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      temperature: 0.7,
    } as never;

    await getDeepseekModel(requestContext(), "flash", { thinking: false }).doStream(options);
    await getDeepseekModel(requestContext(), "flash", { thinking: true }).doStream(options);

    expect(bodies[0]).toMatchObject({
      thinking: { type: "disabled" },
      temperature: 0.7,
      stream_options: { include_usage: true },
    });
    expect(bodies[1]).toMatchObject({
      thinking: { type: "enabled" },
      stream_options: { include_usage: true },
    });
    expect(bodies[1]).not.toHaveProperty("temperature");
  });
});

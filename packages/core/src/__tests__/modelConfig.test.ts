import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import {
  DEEPSEEK_MODEL_IDS,
  KIMI_BASE_URL,
  KIMI_MODEL_IDS,
  resolveDeepseekAuth,
  resolveBaseUrl,
  resolveModelId,
  resolveModelProvider,
  resolveModelParams,
  resolveProtocol,
  resolveVisionConfig,
  getDeepseekModel,
  readRawBranchResponse,
  transformKimiRequestBody,
} from "../llm/modelConfig.js";

const originalDeepseekApiKey = process.env.DEEPSEEK_API_KEY;
const ENV_KEYS = [
  "KIMI_API_KEY",
  "QINGAGENT_MODEL_PROVIDER",
  "QINGAGENT_MODEL_PROTOCOL",
  "QINGAGENT_MODEL_FLASH",
  "QINGAGENT_MODEL_PRO",
  "QINGAGENT_RUNTIME",
  "QINGAGENT_DESKTOP_PACKAGED",
] as const;
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

  it("provider 按 visitor > env > 默认解析，Kimi key 同样保持 visitor > db > env", () => {
    process.env.QINGAGENT_MODEL_PROVIDER = "kimi";
    process.env.KIMI_API_KEY = "kimi-env-key";
    process.env.QINGAGENT_MODEL_PROTOCOL = "anthropic";
    process.env.QINGAGENT_MODEL_FLASH = "env-model";
    expect(resolveModelProvider(requestContext())).toBe("kimi");
    expect(resolveDeepseekAuth(requestContext())).toEqual({
      apiKey: "kimi-env-key",
      origin: "env",
    });

    const fromDb = requestContext([
      ["modelOverrides", { provider: "kimi", globalApiKey: "kimi-db-key" }],
    ]);
    expect(resolveDeepseekAuth(fromDb)).toEqual({
      apiKey: "kimi-db-key",
      origin: "global-db",
    });

    const fromVisitor = requestContext([
      [
        "modelOverrides",
        {
          provider: "deepseek",
          visitorApiKey: "deepseek-visitor-key",
          globalApiKey: "deepseek-db-key",
        },
      ],
    ]);
    expect(resolveModelProvider(fromVisitor)).toBe("deepseek");
    expect(resolveDeepseekAuth(fromVisitor)).toEqual({
      apiKey: "deepseek-visitor-key",
      origin: "visitor",
    });

    delete process.env.QINGAGENT_MODEL_PROVIDER;
    expect(resolveModelProvider(requestContext())).toBe("deepseek");
  });

  it("打包 desktop 只接受 visitor，忽略 global-db、env key 与 env provider", () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_DESKTOP_PACKAGED = "1";
    process.env.QINGAGENT_MODEL_PROVIDER = "kimi";
    process.env.KIMI_API_KEY = "kimi-env-key";

    expect(resolveModelProvider(requestContext())).toBe("deepseek");
    expect(resolveDeepseekAuth(requestContext([
      ["modelOverrides", { provider: "kimi", globalApiKey: "kimi-db-key" }],
    ]))).toEqual({ apiKey: "", origin: "none" });
    expect(resolveDeepseekAuth(requestContext([
      ["modelOverrides", { provider: "kimi", visitorApiKey: "kimi-visitor-key" }],
    ]))).toEqual({ apiKey: "kimi-visitor-key", origin: "visitor" });
    expect(resolveProtocol(requestContext())).toBe("openai");
    expect(resolveModelId(requestContext(), "flash")).toBe(DEEPSEEK_MODEL_IDS.flash);
  });

  it("Kimi 官方 base 与档位固定映射为 Flash→K2.7 Code、Pro→K3", () => {
    const flash = requestContext([["modelOverrides", { provider: "kimi" }]]);
    const pro = requestContext([["modelOverrides", { provider: "kimi", tier: "pro" }]]);
    expect(resolveBaseUrl(flash)).toBe(KIMI_BASE_URL);
    expect(resolveModelId(flash, "flash")).toBe(KIMI_MODEL_IDS.flash);
    expect(resolveModelId(flash, "pro")).toBe(KIMI_MODEL_IDS.pro);
    expect(resolveModelId(pro, "flash")).toBe(KIMI_MODEL_IDS.pro);
    expect(resolveProtocol(requestContext([
      ["modelOverrides", { provider: "kimi", protocol: "anthropic" }],
    ]))).toBe("openai");
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

  it("Kimi 无独立 vision 配置时复用当前主模型；显式 vision 仍优先", async () => {
    const reused = requestContext([
      [
        "modelOverrides",
        {
          provider: "kimi",
          visitorApiKey: "kimi-visitor-key",
          tier: "pro",
          baseUrl: "https://kimi-proxy.example.com/v1",
          modelIds: { pro: "proxy-k3" },
        },
      ],
    ]);
    await expect(resolveVisionConfig(reused)).resolves.toEqual({
      apiKey: "kimi-visitor-key",
      baseUrl: "https://kimi-proxy.example.com/v1",
      model: "proxy-k3",
      protocol: "openai",
      keyOrigin: "visitor",
      reuseMainModel: true,
    });

    const explicit = requestContext([
      [
        "modelOverrides",
        {
          provider: "kimi",
          visitorApiKey: "kimi-visitor-key",
          vision: {
            apiKey: "explicit-vision-key",
            baseUrl: "https://1.1.1.1/v1",
            model: "explicit-vision",
          },
        },
      ],
    ]);
    await expect(resolveVisionConfig(explicit)).resolves.toEqual({
      apiKey: "explicit-vision-key",
      baseUrl: "https://1.1.1.1/v1",
      model: "explicit-vision",
      protocol: "openai",
      keyOrigin: "vision",
      reuseMainModel: false,
    });

    const explicitInvalid = requestContext([
      [
        "modelOverrides",
        {
          provider: "kimi",
          visitorApiKey: "kimi-visitor-key",
          vision: { model: "explicit-vision" },
        },
      ],
    ]);
    await expect(resolveVisionConfig(explicitInvalid)).resolves.toBeNull();
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

    await expect(resolveVisionConfig(rc)).rejects.toThrow(/Blocked loopback/);
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

  it("原始 SSE 持续无分帧符时按 UTF-8 字节上限取消 reader", async () => {
    const encoder = new TextEncoder();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${"甲".repeat(12)}`));
        controller.enqueue(encoder.encode("x".repeat(40)));
      },
      cancel,
    });
    const response = new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });

    await expect(readRawBranchResponse(response, undefined, 64)).rejects.toThrow(
      "branch_stream_buffer_exceeded",
    );
    expect(cancel).toHaveBeenCalledWith("branch_stream_buffer_exceeded");
  });

  it("Kimi 请求体移除采样与思考参数，并保留 K3 reasoning_effort=high", () => {
    const flashContext = requestContext([
      ["modelOverrides", { provider: "kimi" }],
    ]);
    const proContext = requestContext([
      ["modelOverrides", { provider: "kimi", tier: "pro" }],
    ]);
    const body = {
      model: KIMI_MODEL_IDS.flash,
      temperature: 0.4,
      top_p: 0.8,
      thinking: { type: "disabled" },
      enable_thinking: false,
      thinking_budget: 1024,
      reasoning_effort: "low",
      messages: [{ role: "user", content: "x" }],
    };

    const flash = transformKimiRequestBody(body, flashContext);
    expect(flash).not.toHaveProperty("temperature");
    expect(flash).not.toHaveProperty("top_p");
    expect(flash).not.toHaveProperty("thinking");
    expect(flash).not.toHaveProperty("enable_thinking");
    expect(flash).not.toHaveProperty("thinking_budget");
    expect(flash).not.toHaveProperty("reasoning_effort");
    expect(flash.messages).toEqual(body.messages);
    expect(body).toHaveProperty("temperature", 0.4);
    expect(body).toHaveProperty("top_p", 0.8);

    const pro = transformKimiRequestBody({ ...body, model: KIMI_MODEL_IDS.pro }, proContext);
    expect(pro).not.toHaveProperty("temperature");
    expect(pro).not.toHaveProperty("top_p");
    expect(pro).not.toHaveProperty("thinking");
    expect(pro).toHaveProperty("reasoning_effort", "high");
  });

  it("Kimi mock transport:K2.7 不传思考开关/effort，K3 固定 reasoning_effort=high", async () => {
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
      temperature: 0.4,
      topP: 0.8,
    } as never;
    const flashContext = requestContext([
      ["modelOverrides", { provider: "kimi", visitorApiKey: "mock-kimi-key" }],
    ]);
    const proContext = requestContext([
      ["modelOverrides", { provider: "kimi", visitorApiKey: "mock-kimi-key", tier: "pro" }],
    ]);

    await getDeepseekModel(flashContext, "flash", { thinking: false }).doStream(options);
    await getDeepseekModel(proContext, "flash", { thinking: false }).doStream(options);

    expect(bodies[0]).toMatchObject({ model: KIMI_MODEL_IDS.flash });
    expect(bodies[0]).not.toHaveProperty("temperature");
    expect(bodies[0]).not.toHaveProperty("top_p");
    expect(bodies[0]).not.toHaveProperty("thinking");
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    expect(bodies[1]).toMatchObject({
      model: KIMI_MODEL_IDS.pro,
      reasoning_effort: "high",
    });
    expect(bodies[1]).not.toHaveProperty("thinking");
    expect(bodies[1]).not.toHaveProperty("enable_thinking");
    expect(bodies[1]).not.toHaveProperty("temperature");
    expect(bodies[1]).not.toHaveProperty("top_p");
  });
});

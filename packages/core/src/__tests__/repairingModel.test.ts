import { describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import { pmToPlainText, type PmDoc } from "@qingagent/pm-schema";
import {
  RepairingLanguageModelV2,
  RepairingModelRouterLanguageModel,
  isRetryableModelError,
  repairSupportedToolCallInput,
  wrapToolCallRepairingModel,
  type RepairableLanguageModel,
  type RepairableLanguageModelV2,
} from "../llm/repairingModel.js";
import { createAnnotationGroupsInputSchema } from "../tools/annotationGroups.js";
import { reviewCenterConsistencyParseFailure } from "./fixtures/reviewCenterConsistencyParseFailure.js";
import {
  PrefixCacheGuardError,
  __resetPrefixCacheGuardForTest,
  guardBeforeProviderCall,
  guardContext,
} from "../llm/prefixCacheGuard.js";

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    getMemory: () => null,
  },
  getObservability: () => null,
}));

vi.mock("../agents/qingagent.js", () => ({
  getQingagentSkills: vi.fn(async () => ({
    maybeRefresh: vi.fn(async () => {}),
    has: vi.fn(async () => false),
  })),
  qingagentAgent: {
    stream: vi.fn(),
    resumeStream: vi.fn(),
  },
}));

describe("isRetryableModelError", () => {
  it("识别 undici 连接超时及 AI SDK 包装后的嵌套 cause", () => {
    expect(isRetryableModelError({ code: "UND_ERR_CONNECT_TIMEOUT" })).toBe(true);
    expect(isRetryableModelError({ code: "UND_ERR_HEADERS_TIMEOUT" })).toBe(true);
    expect(isRetryableModelError({
      message: "provider request failed",
      cause: new TypeError("wrapped request error", {
        cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
      }),
    })).toBe(true);
  });

  it("AbortError 不归类为可重试网络错误", () => {
    expect(isRetryableModelError(new DOMException("aborted", "AbortError"))).toBe(false);
  });
});

function pmDoc(text: string, blockId = "block-a"): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      attrs: { blockId },
      content: [{ type: "text", text }],
    }],
  };
}

function streamParts(parts: unknown[]): ReadableStream<any> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

async function collectStreamParts(stream: ReadableStream<any>): Promise<any[]> {
  const reader = stream.getReader();
  const chunks: any[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return chunks;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function fakeV2Model(input: string): RepairableLanguageModelV2 {
  return {
    specificationVersion: "v2",
    provider: "qingagent-test",
    modelId: "fake-v2-toolcall-json",
    supportedUrls: Promise.resolve({}),
    async doGenerate() {
      return this.doStream({} as never);
    },
    async doStream() {
      return {
        stream: streamParts([
          { type: "tool-call", toolCallId: "edit-1", toolName: "editDraft", input },
          {
            type: "finish",
            finishReason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]),
      };
    },
  };
}

function fakeV3Model(input: string): RepairableLanguageModel {
  return {
    specificationVersion: "v3",
    provider: "qingagent-test",
    modelId: "fake-v3-toolcall-json",
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: "tool-call", toolCallId: "write-1", toolName: "writeDraft", input }],
        finishReason: { unified: "tool-calls" },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream() {
      return {
        stream: streamParts([
          { type: "tool-call", toolCallId: "write-1", toolName: "writeDraft", input },
          {
            type: "finish",
            finishReason: { unified: "tool-calls" },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]),
      };
    },
  };
}

describe("RepairingLanguageModelV2", () => {
  it("fake V2 模型的纯引号病 tool-call.input 可修复并跑通真实 editDraft", async () => {
    const badInput =
      "{\"ops\":[{\"action\":\"replaceText\",\"find\":\"旧文\",\"replace\":\"进入\"土地争夺\"阶段\"}]}";
    const model = new RepairingLanguageModelV2(fakeV2Model(badInput));
    const result = await model.doStream({} as never);
    const chunks = await collectStreamParts(result.stream);
    const toolCall = chunks.find((chunk) => chunk.type === "tool-call");

    expect(toolCall?.input).toContain("\\\"土地争夺\\\"");
    const args = JSON.parse(toolCall.input);

    const { createSession, createSessionScopedTools } = await import("../bridge/index.js");
    const state = createSession("repairing-model-real-editDraft");
    state.doc = pmDoc("旧文");
    const requestContext = new RequestContext([
      ["doc", state.doc],
      ["sessionId", state.sessionId],
    ]);
    const editDraft = createSessionScopedTools(state).editDraft;
    const editResult = await editDraft.execute!(args, { requestContext } as any) as {
      ok: boolean;
      applied: string[];
      error?: string;
    };

    expect(editResult).toMatchObject({ ok: true, applied: ["block-a"] });
    expect(pmToPlainText(state.docDraftCandidateDoc!)).toBe("进入\"土地争夺\"阶段");
  });

  it("R2:L1 一致性三组的裸引号坏 JSON 可修复并通过真实批注 schema", () => {
    const repaired = repairSupportedToolCallInput(
      "create_annotation_groups",
      reviewCenterConsistencyParseFailure.reconstructedInput,
    );

    expect(repaired).not.toBeNull();
    const parsed = JSON.parse(repaired!);
    expect(createAnnotationGroupsInputSchema.safeParse(parsed).success).toBe(true);
    expect(parsed.groups).toHaveLength(3);
    expect(parsed.groups[0].note).toBe('一处写"2022年11月"，另一处写"2023年"。');
    expect(parsed.groups[1].note).toContain('"1.13亿元"');
  });

  it("批注 JSON 截断无法安全修复时生成带组号和字段的诊断参数", () => {
    const truncated = '{"groups":[{"summary":"融资时间冲突","note":"一处写"2022年11月';
    const repaired = repairSupportedToolCallInput("create_annotation_groups", truncated);

    expect(repaired).not.toBeNull();
    const parsed = JSON.parse(repaired!);
    expect(parsed._parseFailure).toMatchObject({ groupIndex: 1, field: "note" });
    expect(parsed._parseFailure.message).toContain("每次≤3组");
  });
});

describe("wrapToolCallRepairingModel", () => {
  it("fake V3 模型保留 specificationVersion,并修复 stream/content tool-call.input", async () => {
    const badInput = '{"title":"测试","outline":"名言：","Less is more","。","intent":"express"}';
    const model = wrapToolCallRepairingModel(fakeV3Model(badInput));

    expect(model.specificationVersion).toBe("v3");

    const streamResult = await model.doStream({} as never) as { stream: ReadableStream<any> };
    const chunks = await collectStreamParts(streamResult.stream);
    const streamToolCall = chunks.find((chunk) => chunk.type === "tool-call");
    expect(JSON.parse(streamToolCall.input)).toMatchObject({
      title: "测试",
      outline: "名言：\"Less is more\"。",
      intent: "express",
    });

    const generateResult = await model.doGenerate({} as never) as { content: any[] };
    const contentToolCall = generateResult.content.find((part) => part.type === "tool-call");
    expect(JSON.parse(contentToolCall.input).outline).toBe("名言：\"Less is more\"。");
  });

  it("连续网络错误直接交给框架层，repairing 层只调用一次 provider", async () => {
    const networkError = Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
    const doStream = vi.fn(async (_options?: unknown) => {
      throw networkError;
    });
    const model = wrapToolCallRepairingModel({
      ...fakeV3Model("{}"),
      doStream,
    });

    await expect(model.doStream({} as never)).rejects.toBe(networkError);
    expect(doStream).toHaveBeenCalledTimes(1);
  });

  it("AbortError 立即上抛且不重试", async () => {
    const abortError = new DOMException("This operation was aborted", "AbortError");
    const doStream = vi.fn(async (_options?: unknown) => {
      throw abortError;
    });
    const model = wrapToolCallRepairingModel({
      ...fakeV3Model("{}"),
      doStream,
    });

    await expect(model.doStream({ abortSignal: AbortSignal.abort() } as never)).rejects.toBe(abortError);
    expect(doStream).toHaveBeenCalledTimes(1);
  });
});

describe("RepairingModelRouterLanguageModel prefix guard", () => {
  it("provider 边界在进入 super.doStream 前执行 strict 守卫", async () => {
    const previousGuard = process.env.QINGAGENT_PREFIX_CACHE_GUARD;
    process.env.QINGAGENT_PREFIX_CACHE_GUARD = "strict";
    __resetPrefixCacheGuardForTest();
    const context = { sessionId: "repairing-router-guard", lineage: "turn" as const };
    const firstOptions = {
      prompt: [
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "text", text: "第一轮" }] },
      ],
      tools: [],
    };
    const driftOptions = {
      prompt: [
        { role: "system", content: "sys changed" },
        { role: "user", content: [{ type: "text", text: "第一轮" }] },
      ],
      tools: [],
    };
    const model = new RepairingModelRouterLanguageModel({
      id: "deepseek/deepseek-v4-flash",
      url: "https://example.invalid/v1",
      apiKey: "test",
    });

    try {
      guardContext.run(context, () => guardBeforeProviderCall(firstOptions));

      await expect(
        guardContext.run(context, () => model.doStream(driftOptions as never)),
      ).rejects.toThrow(PrefixCacheGuardError);
    } finally {
      __resetPrefixCacheGuardForTest();
      if (previousGuard === undefined) delete process.env.QINGAGENT_PREFIX_CACHE_GUARD;
      else process.env.QINGAGENT_PREFIX_CACHE_GUARD = previousGuard;
    }
  });
});

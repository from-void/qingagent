import { RequestContext } from "@mastra/core/request-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import {
  MODEL_OVERRIDES_CONTEXT_KEY,
  beginSessionSnapshotTurn,
  clearSessionSnapshot,
  createSnapshottingQingagentModel,
} from "../llm/modelConfig.js";
import {
  buildTranslationSteeringTail,
  DerivativeDeltaBatcher,
  TRANSLATION_DELTA_FLUSH_BYTES,
  generateTranslations,
} from "../session/translationGeneration.js";
import {
  createDerivativeDoc,
  documentRepo,
  getDerivativeDocument,
  getDerivativeMeta,
  getDocumentsClient,
} from "@qingagent/db";
import { documentInput, prepareTempDocumentsDb, section, type TempDocumentsDb } from "@qingagent/db/testing";

function emptySse(): Response {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function textSse(chunks: string[], finishReason = "stop"): Response {
  const events = chunks.map((content) => `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`).join("");
  const finish = `data: ${JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 20,
      prompt_cache_hit_tokens: 100,
      prompt_cache_miss_tokens: 20,
    },
  })}\n\ndata: [DONE]\n\n`;
  return new Response(`${events}${finish}`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function captureMainSnapshot(requestContext: RequestContext): Promise<void> {
  beginSessionSnapshotTurn(requestContext);
  const model = createSnapshottingQingagentModel(requestContext);
  await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "主链前缀" }] }],
    tools: [{
      type: "function",
      name: "readDraft",
      description: "test",
      inputSchema: { type: "object", properties: {} },
    }],
    toolChoice: { type: "auto" },
  } as never);
}

async function collectFrames(generator: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of generator) frames.push(frame);
  return frames;
}

describe("generateTranslations 并发旁支", () => {
  let db: TempDocumentsDb;
  const sessionId = "translation-thread";
  const originalApiKey = process.env.DEEPSEEK_API_KEY;

  beforeEach(async () => {
    db = prepareTempDocumentsDb("qa-translation-generation-");
    process.env.DEEPSEEK_API_KEY = "sk-translation-test";
    await documentRepo.save(documentInput("translation-main", {
      threadId: sessionId,
      docVersion: 7,
      legacySections: [section("完整源文：产品 QingAgent 已经发布，数字 42 必须保留。")],
    }));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearSessionSnapshot(sessionId);
    // branch usage 是旁路异步记账，给当前微任务一个收口机会再关闭临时库。
    await new Promise((resolve) => setTimeout(resolve, 0));
    db.cleanup();
    if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalApiKey;
  });

  async function targets() {
    const english = await createDerivativeDoc({
      threadId: sessionId,
      sourceDocId: "translation-main",
      dtype: "translate",
      templateId: "translate-faithful",
      targetLang: "英语",
      privatePrompt: "保留产品名",
    });
    const japanese = await createDerivativeDoc({
      threadId: sessionId,
      sourceDocId: "translation-main",
      dtype: "translate",
      templateId: "translate-native",
      targetLang: "日语",
      privatePrompt: "数字不变",
    });
    return { english, japanese };
  }

  it("2 语言并发、delta 合帧并交错完成，逐路落库 generatedAt/docVersion", async () => {
    const { english, japanese } = await targets();
    let active = 0;
    let maxActive = 0;
    const translationBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const bodyText = String(init?.body ?? "{}");
      const body = JSON.parse(bodyText) as { stream_options?: unknown; messages?: Array<{ content?: unknown }> };
      if (!body.stream_options) return emptySse();
      translationBodies.push(bodyText);
      const tail = String(body.messages?.at(-1)?.content ?? "");
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, tail.includes("日语") ? 5 : 25));
      active -= 1;
      return tail.includes("日语")
        ? textSse(["<h1>日本語", "の見出し</h1>", "<p>QingAgent 42</p>"])
        : textSse(["<h1>English", " title</h1>", "<p>QingAgent 42</p>"]);
    }));
    const requestContext = new RequestContext([
      ["sessionId", sessionId],
      ["streamId", "main-stream"],
      ["runId", "translate-run"],
    ] as never) as RequestContext;
    await captureMainSnapshot(requestContext);

    const frames = await collectFrames(generateTranslations({
      sessionId,
      targets: [
        { docId: english.docId, targetLang: "英语" },
        { docId: japanese.docId, targetLang: "日语" },
      ],
      requestContext,
    }));

    expect(maxActive).toBe(2);
    expect(frames.slice(0, 2).map((frame) => frame.kind)).toEqual([
      "derivativeGenStarted",
      "derivativeGenStarted",
    ]);
    const deltas = frames.filter((frame): frame is Extract<BridgeFrame, { kind: "derivativeGenDelta" }> => frame.kind === "derivativeGenDelta");
    expect(deltas.filter((frame) => frame.data.docId === english.docId)).toHaveLength(1);
    expect(deltas.filter((frame) => frame.data.docId === japanese.docId)).toHaveLength(1);
    const finished = frames.filter((frame): frame is Extract<BridgeFrame, { kind: "derivativeGenFinished" }> => frame.kind === "derivativeGenFinished");
    expect(finished.map((frame) => frame.data.docId)).toEqual([japanese.docId, english.docId]);
    expect(finished.every((frame) => frame.data.docVersion === 1 && Boolean(frame.data.generatedAt))).toBe(true);
    expect((await getDerivativeDocument(english.docId))?.docVersion).toBe(1);
    expect((await getDerivativeDocument(japanese.docId))?.docVersion).toBe(1);
    expect((await getDerivativeMeta(english.docId))?.generatedAt).toBe(finished.find((frame) => frame.data.docId === english.docId)?.data.generatedAt);
    expect(translationBodies).toHaveLength(2);
    expect(translationBodies.every((body) => body.includes("完整源文：产品 QingAgent 已经发布，数字 42 必须保留。"))).toBe(true);
  });

  it("单路借道与 AI SDK 降级双败只发用户文案，不拖垮另一路", async () => {
    const { english, japanese } = await targets();
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const bodyText = String(init?.body ?? "{}");
      const body = JSON.parse(bodyText) as { stream_options?: unknown; messages?: Array<{ content?: unknown }> };
      if (!body.stream_options) return emptySse();
      if (bodyText.includes("日语")) return Response.json({ error: { message: "provider internal snapshot failure" } }, { status: 500 });
      const tail = String(body.messages?.at(-1)?.content ?? "");
      return tail.includes("英语")
        ? textSse(["<h1>English</h1>", "<p>success 42</p>"])
        : Response.json({ error: { message: "unexpected request" } }, { status: 500 });
    }));
    const requestContext = new RequestContext([
      ["sessionId", sessionId],
      ["streamId", "main-stream"],
      ["runId", "translate-failure-run"],
    ] as never) as RequestContext;
    await captureMainSnapshot(requestContext);
    const frames = await collectFrames(generateTranslations({
      sessionId,
      targets: [
        { docId: english.docId, targetLang: "英语" },
        { docId: japanese.docId, targetLang: "日语" },
      ],
      requestContext,
    }));
    const success = frames.find((frame): frame is Extract<BridgeFrame, { kind: "derivativeGenFinished" }> => frame.kind === "derivativeGenFinished");
    const failure = frames.find((frame): frame is Extract<BridgeFrame, { kind: "derivativeGenFailed" }> => frame.kind === "derivativeGenFailed");
    expect(success?.data.docId).toBe(english.docId);
    expect(failure?.data.docId).toBe(japanese.docId);
    expect(failure?.data.reason).toBe("译文生成失败，请重试");
    expect(failure?.data.reason).not.toMatch(/branch|snapshot|provider|fallback|QingML|commit|内部/i);
    expect((await getDerivativeDocument(english.docId))?.docVersion).toBe(1);
    expect((await getDerivativeDocument(japanese.docId))?.docVersion).toBe(0);
  });

  it("用户三项采样参数在翻译 branch 与 fallback 的实际请求体一致", async () => {
    const { english } = await targets();
    const translationBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (!body.stream_options) return emptySse();
      translationBodies.push(body);
      if (translationBodies.length === 1) {
        return Response.json(
          { error: { message: "force fallback" } },
          { status: 500 },
        );
      }
      return textSse(["<h1>English</h1>", "<p>QingAgent 42</p>"]);
    }));
    const requestContext = new RequestContext([
      ["sessionId", sessionId],
      ["streamId", "main-stream"],
      ["runId", "translate-params-run"],
      [MODEL_OVERRIDES_CONTEXT_KEY, {
        params: {
          temperature: 0.73,
          topP: 0.82,
          maxOutputTokens: 3456,
        },
      }],
    ] as never) as RequestContext;
    await captureMainSnapshot(requestContext);

    const frames = await collectFrames(generateTranslations({
      sessionId,
      targets: [{ docId: english.docId, targetLang: "英语" }],
      requestContext,
    }));

    expect(frames.some((frame) => frame.kind === "derivativeGenFinished")).toBe(true);
    expect(translationBodies).toHaveLength(2);
    expect(translationBodies.map((body) => ({
      temperature: body.temperature,
      topP: body.top_p,
      maxTokens: body.max_tokens,
    }))).toEqual([
      { temperature: 0.73, topP: 0.82, maxTokens: 3456 },
      { temperature: 0.73, topP: 0.82, maxTokens: 3456 },
    ]);
  });

  it("主分支 QingML 验证失败时丢弃其 delta，展示缓冲只接收 fallback", async () => {
    const { english } = await targets();
    let translationRequestCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { stream_options?: unknown };
      if (!body.stream_options) return emptySse();
      translationRequestCount += 1;
      return translationRequestCount === 1
        ? textSse(["<h1>截断坏首稿", "</h1><p>不应展示"], "length")
        : textSse(["<h1>English</h1>", "<p>valid fallback 42</p>"]);
    }));
    const requestContext = new RequestContext([
      ["sessionId", sessionId],
      ["streamId", "main-stream"],
      ["runId", "translate-buffer-run"],
    ] as never) as RequestContext;
    await captureMainSnapshot(requestContext);

    const frames = await collectFrames(generateTranslations({
      sessionId,
      targets: [{ docId: english.docId, targetLang: "英语" }],
      requestContext,
    }));
    const displayed = frames
      .filter((frame): frame is Extract<BridgeFrame, { kind: "derivativeGenDelta" }> =>
        frame.kind === "derivativeGenDelta")
      .map((frame) => frame.data.text)
      .join("");

    expect(translationRequestCount).toBe(2);
    expect(displayed).toBe("<h1>English</h1><p>valid fallback 42</p>");
    expect(displayed).not.toContain("这不是 QingML");
    expect(frames.some((frame) => frame.kind === "derivativeGenFinished")).toBe(true);
  });

  it("生成期间版本已推进时，翻译提交不得用最新版本覆盖", async () => {
    const { english } = await targets();
    let advanced = false;
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { stream_options?: unknown };
      if (!body.stream_options) return emptySse();
      if (!advanced) {
        advanced = true;
        await getDocumentsClient().execute({
          sql: "UPDATE documents SET doc_version = 1 WHERE id = ?",
          args: [english.docId],
        });
      }
      return textSse(["<h1>Late translation</h1>", "<p>must not overwrite</p>"]);
    }));
    const requestContext = new RequestContext([
      ["sessionId", sessionId],
      ["streamId", "main-stream"],
      ["runId", "translate-version-race-run"],
    ] as never) as RequestContext;
    await captureMainSnapshot(requestContext);

    const frames = await collectFrames(generateTranslations({
      sessionId,
      targets: [{ docId: english.docId, targetLang: "英语" }],
      requestContext,
    }));

    expect(frames.some((frame) => frame.kind === "derivativeGenFinished")).toBe(false);
    expect(frames.some((frame) => frame.kind === "derivativeGenFailed")).toBe(true);
    expect((await getDerivativeDocument(english.docId))?.docVersion).toBe(1);
  });

  it("delta batcher 的 200ms 与 2KB 两条门均会 flush", () => {
    vi.useFakeTimers();
    const frames: BridgeFrame[] = [];
    const batcher = new DerivativeDeltaBatcher("doc", (frame) => frames.push(frame));
    batcher.add("a");
    vi.advanceTimersByTime(199);
    expect(frames).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(frames).toEqual([{ kind: "derivativeGenDelta", data: { docId: "doc", text: "a" } }]);
    batcher.add("b".repeat(TRANSLATION_DELTA_FLUSH_BYTES));
    expect(frames).toHaveLength(2);
    batcher.dispose();
  });
});

describe("翻译脚注上下文", () => {
  it("把 sourceQingml 与保留 id 的明确范本放入真实旁支提示", () => {
    const tail = buildTranslationSteeringTail({
      targetLang: "英语",
      writingPrompt: "忠实翻译",
      privatePrompt: "",
      skillGuidance: "",
      sourceTitle: "标题",
      sourceText: "正文",
      sourceQingml: '<p>正文<footnote id="source_a">来源甲</footnote></p>',
    });
    expect(tail).toContain(
      '<p>正文<footnote id=\\"source_a\\">来源甲</footnote></p>',
    );
    expect(tail).toContain("保留在原引用位置并保持 id 不变");
    expect(tail).toContain("不要把它改成普通 [1] 文本");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import { createSession } from "../session/sessionState.js";

const mockState = vi.hoisted(() => {
  const schedulePersist = vi.fn(async () => {});
  const recordUsageEvent = vi.fn(async () => {});
  const memoryStore = { supportsObservationalMemory: true };
  const memory = {
    storage: {
      getStore: vi.fn(async (name: string) => name === "memory" ? memoryStore : undefined),
    },
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const omInstances: any[] = [];
  let status: Record<string, unknown> = {};
  let record: Record<string, unknown> | null = null;
  let observeError: Error | null = null;
  let observeResult: Record<string, unknown> = {
    observed: true,
    reflected: false,
    record: { id: "record-1" },
  };
  let reflectResult: Record<string, unknown> = {
    reflected: true,
    record: { id: "record-1" },
  };
  class MockObservationalMemory {
    config: Record<string, unknown>;
    persistMessages = vi.fn(async () => {});
    getStatus = vi.fn(async () => ({
      pendingTokens: 123,
      shouldObserve: false,
      shouldBuffer: true,
      shouldReflect: false,
      bufferedChunkCount: 0,
      canActivate: false,
      record: { id: "record-1" },
      ...status,
    }));
    buffer = vi.fn(async () => ({ buffered: true, record: { id: "record-1" } }));
    activate = vi.fn(async () => ({
      activated: true,
      activatedMessageIds: ["activated-id"],
      record: { id: "record-1", observedMessageIds: ["activated-id"] },
    }));
    observe = vi.fn(async () => {
      if (observeError) throw observeError;
      return observeResult;
    });
    reflect = vi.fn(async () => reflectResult);
    getRecord = vi.fn(async () => record);
    getObservations = vi.fn(async () => undefined);
    waitForBuffering = vi.fn(async () => {});
    __registerMastra = vi.fn();
    constructor(config: Record<string, unknown>) {
      this.config = config;
      omInstances.push(this);
    }
  }
  class MockTokenCounter {
    countMessages(messages: unknown[]) {
      return JSON.stringify(messages).length;
    }
  }
  return {
    schedulePersist,
    recordUsageEvent,
    logger,
    memory,
    omInstances,
    setStatus(next: Record<string, unknown>) {
      status = next;
    },
    setRecord(next: Record<string, unknown> | null) {
      record = next;
    },
    setObserveError(next: Error | null) {
      observeError = next;
    },
    setObserveResult(next: Record<string, unknown>) {
      observeResult = next;
    },
    setReflectResult(next: Record<string, unknown>) {
      reflectResult = next;
    },
    MockObservationalMemory,
    MockTokenCounter,
  };
});

vi.mock("@mastra/memory/processors", () => ({
  ObservationalMemory: mockState.MockObservationalMemory,
  TokenCounter: mockState.MockTokenCounter,
}));

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => mockState.logger,
  },
  getMemory: () => mockState.memory,
  getObservability: () => null,
}));

vi.mock("../session/threadPersistence.js", () => ({
  QINGAGENT_RESOURCE_ID: "qingagent-user",
  schedulePersist: mockState.schedulePersist,
}));

vi.mock("@qingagent/db", () => ({
  resolveDbUrl: () => "file::memory:",
  recordUsageEvent: mockState.recordUsageEvent,
}));

describe("OM sidecar 接线形状", () => {
  const originalSidecar = process.env.QINGAGENT_OM_SIDECAR;
  const originalCompress = process.env.QINGAGENT_OM_COMPRESS;
  const originalThreshold = process.env.QINGAGENT_OM_COMPRESS_THRESHOLD_TOKENS;
  const originalRecentTurns = process.env.QINGAGENT_OM_COMPRESS_RECENT_TURNS;
  const originalObserveMessageTokens = process.env.QINGAGENT_OM_OBSERVE_MESSAGE_TOKENS;
  const originalBufferTokens = process.env.QINGAGENT_OM_BUFFER_TOKENS;

  beforeEach(() => {
    process.env.QINGAGENT_OM_SIDECAR = "1";
    delete process.env.QINGAGENT_OM_COMPRESS_RECENT_TURNS;
    delete process.env.QINGAGENT_OM_OBSERVE_MESSAGE_TOKENS;
    delete process.env.QINGAGENT_OM_BUFFER_TOKENS;
    mockState.schedulePersist.mockClear();
    mockState.recordUsageEvent.mockClear();
    mockState.memory.storage.getStore.mockClear();
    mockState.omInstances.length = 0;
    mockState.setStatus({});
    mockState.setRecord(null);
    mockState.setObserveError(null);
    mockState.setObserveResult({
      observed: true,
      reflected: false,
      record: { id: "record-1" },
    });
    mockState.setReflectResult({
      reflected: true,
      record: { id: "record-1" },
    });
    mockState.logger.debug.mockClear();
    mockState.logger.info.mockClear();
    mockState.logger.warn.mockClear();
    mockState.logger.error.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalSidecar === undefined) delete process.env.QINGAGENT_OM_SIDECAR;
    else process.env.QINGAGENT_OM_SIDECAR = originalSidecar;
    if (originalCompress === undefined) delete process.env.QINGAGENT_OM_COMPRESS;
    else process.env.QINGAGENT_OM_COMPRESS = originalCompress;
    if (originalThreshold === undefined) delete process.env.QINGAGENT_OM_COMPRESS_THRESHOLD_TOKENS;
    else process.env.QINGAGENT_OM_COMPRESS_THRESHOLD_TOKENS = originalThreshold;
    if (originalRecentTurns === undefined) delete process.env.QINGAGENT_OM_COMPRESS_RECENT_TURNS;
    else process.env.QINGAGENT_OM_COMPRESS_RECENT_TURNS = originalRecentTurns;
    if (originalObserveMessageTokens === undefined) delete process.env.QINGAGENT_OM_OBSERVE_MESSAGE_TOKENS;
    else process.env.QINGAGENT_OM_OBSERVE_MESSAGE_TOKENS = originalObserveMessageTokens;
    if (originalBufferTokens === undefined) delete process.env.QINGAGENT_OM_BUFFER_TOKENS;
    else process.env.QINGAGENT_OM_BUFFER_TOKENS = originalBufferTokens;
  });

  it("首次 memory store 临时失败后会在下次访问重新初始化", async () => {
    mockState.memory.storage.getStore.mockRejectedValueOnce(new Error("temporary storage outage"));
    const { getOmObservations } = await import("../session/omSidecar.js");

    await expect(getOmObservations({
      threadId: "om-init-retry",
      resourceId: "qingagent-user",
    })).resolves.toBeUndefined();
    expect(mockState.memory.storage.getStore).toHaveBeenCalledTimes(1);
    expect(mockState.omInstances).toHaveLength(0);

    await expect(getOmObservations({
      threadId: "om-init-retry",
      resourceId: "qingagent-user",
    })).resolves.toBeUndefined();
    expect(mockState.memory.storage.getStore).toHaveBeenCalledTimes(2);
    expect(mockState.omInstances).toHaveLength(1);
    expect(mockState.omInstances[0]!.getObservations).toHaveBeenCalledTimes(1);
  });

  it("OM model 在主链快照可用时通过 BranchCall 生成并按 omObserve 记调用", async () => {
    const {
      beginSessionSnapshotTurn,
      createSnapshottingQingagentModel,
    } = await import("../llm/modelConfig.js");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const modelOverrides = {
      visitorApiKey: "visitor-key",
      baseUrl: "https://example.test/v1",
      modelIds: { flash: "deepseek-v4-flash" },
      protocol: "openai",
    };
    const mainContext = new RequestContext([
      ["sessionId", "om-wire-branch"],
      ["streamId", "stream-main"],
      ["runId", "run-om-wire-branch"],
      ["modelOverrides", modelOverrides],
    ] as never) as RequestContext;
    beginSessionSnapshotTurn(mainContext);
    const mainModel = createSnapshottingQingagentModel(mainContext);
    const primed = await mainModel.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "主链锚点" }] }],
      tools: [],
      toolChoice: { type: "auto" },
    } as never);
    await primed.stream.pipeTo(new WritableStream());

    mockState.setStatus({ shouldObserve: true, shouldBuffer: false });
    const { runOmSidecarAfterTurn } = await import("../session/omSidecar.js");
    const state = createSession("om-wire-branch");
    state.threadId = state.sessionId;
    state.messages.push({ role: "user", content: "需要观察的事实" });
    await runOmSidecarAfterTurn(state, mainContext);

    const om = mockState.omInstances[0]!;
    const sidecarContext = om.observe.mock.calls[0][0].requestContext as RequestContext;
    const frozenSnapshot = sidecarContext.get("omBranchSnapshot") as { bodyText?: string } | null;
    expect(frozenSnapshot?.bodyText).toContain("主链锚点");
    const modelFactory = om.config.model as (input: { requestContext?: RequestContext }) => any;
    const observerModel = modelFactory({ requestContext: sidecarContext });
    fetchMock.mockResolvedValueOnce(Response.json({
      id: "om-branch",
      model: "deepseek-v4-flash",
      choices: [{ message: { role: "assistant", content: "- 用户需要严谨表达" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 8,
        prompt_cache_hit_tokens: 95,
        prompt_cache_miss_tokens: 5,
      },
    }));
    const generated = await observerModel.doGenerate({
      prompt: [
        { role: "system", content: "提炼长期观察" },
        { role: "user", content: [{ type: "text", text: "请提炼" }] },
      ],
    });

    expect(generated.content).toEqual([{ type: "text", text: "- 用户需要严谨表达" }]);
    await vi.waitFor(() => expect(mockState.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "om-wire-branch",
      runId: "run-om-wire-branch",
      callSite: "omObserve",
      cacheHitTokens: 95,
      cacheMissTokens: 5,
    })));
    const replayBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(replayBody.messages.at(-1).content).toContain("长期观察提炼任务");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 后续 turn 即使领取新 lease，已排队 OM context 仍只携带 A 轮快照，不会按 sessionId 换成 B 轮。
    beginSessionSnapshotTurn(new RequestContext([
      ["sessionId", "om-wire-branch"],
      ["streamId", "stream-next"],
    ] as never));
    expect(sidecarContext.get("omBranchSnapshot")).toBe(frozenSnapshot);
  });

  it("OM BranchModel 以真实实例访问私有字段，并在方法替换后刷新绑定", async () => {
    const symbolReader = Symbol("om-private-reader");
    class PrivateFieldModel {
      #value = "om-private-ok";

      get privateValue(): string {
        return this.#value;
      }

      readPrivate(): string {
        return this.#value;
      }

      [symbolReader](): string {
        return this.#value;
      }

      async doGenerate(_options?: unknown): Promise<{ value: string }> {
        return { value: this.#value };
      }

      async doStream(_options?: unknown): Promise<{ value: string; stream: ReadableStream }> {
        return { value: this.#value, stream: new ReadableStream() };
      }
    }

    const { createOmBranchModel } = await import("../session/omSidecar.js");
    const target = new PrivateFieldModel();
    const model = createOmBranchModel(
      target as never,
      undefined,
      { sessionId: "om-private-proxy" } as never,
      "omObserve",
    ) as unknown as PrivateFieldModel;

    expect(model.privateValue).toBe("om-private-ok");
    const first = model.readPrivate;
    expect(model.readPrivate).toBe(first);
    expect(first()).toBe("om-private-ok");
    expect(model[symbolReader]).toBe(model[symbolReader]);
    expect(model[symbolReader]()).toBe("om-private-ok");

    target.readPrivate = function (this: PrivateFieldModel): string {
      return this === target ? "om-rebound-ok" : "wrong-this";
    };
    const rebound = model.readPrivate;
    expect(rebound).not.toBe(first);
    expect(rebound()).toBe("om-rebound-ok");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(model.doGenerate()).resolves.toEqual({ value: "om-private-ok" });
    await expect(model.doStream()).resolves.toMatchObject({ value: "om-private-ok" });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("用 thread scope sidecar 持久化 MastraDBMessage，并以对象参数触发 buffer", async () => {
    const { getOmObservations, runOmSidecarAfterTurn } = await import("../session/omSidecar.js");
    const state = createSession("om-wire-buffer");
    state.threadId = state.sessionId;
    state.messages.push({ role: "user", content: "第一轮" });

    await runOmSidecarAfterTurn(state, new RequestContext([
      ["sessionId", state.sessionId],
    ] as never));

    const om = mockState.omInstances[0]!;
    expect(om.config).toMatchObject({
      scope: "thread",
      observation: { observeAttachments: false, messageTokens: 100_000, bufferTokens: false },
      reflection: { observationTokens: 40_000 },
    });
    const modelFactory = om.config.model as (input: { requestContext?: RequestContext }) => {
      modelId?: string;
    };
    const visitorModel = modelFactory({
      requestContext: new RequestContext([
        ["modelOverrides", {
          visitorApiKey: "visitor-key",
          baseUrl: "http://127.0.0.1:9999/v1",
          modelIds: { flash: "observer-visitor-flash" },
          protocol: "openai",
        }],
      ]),
    });
    expect(visitorModel.modelId).toBe("observer-visitor-flash");
    expect(om.persistMessages).toHaveBeenCalledTimes(1);
    expect(om.persistMessages.mock.calls[0][1]).toBe("om-sidecar:om-wire-buffer");
    expect(om.persistMessages.mock.calls[0][2]).toBe("qingagent-user:om-sidecar");
    expect(om.persistMessages.mock.calls[0][0][0]).toMatchObject({
      id: "om-wire-buffer-1-1",
      threadId: "om-sidecar:om-wire-buffer",
      resourceId: "qingagent-user:om-sidecar",
      role: "user",
    });
    expect(om.getStatus).toHaveBeenCalledWith({
      threadId: "om-sidecar:om-wire-buffer",
      resourceId: "qingagent-user:om-sidecar",
      messages: expect.arrayContaining([
        expect.objectContaining({
          id: "om-wire-buffer-1-1",
          threadId: "om-sidecar:om-wire-buffer",
          resourceId: "qingagent-user:om-sidecar",
        }),
      ]),
    });
    expect(om.buffer).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "om-sidecar:om-wire-buffer",
      resourceId: "qingagent-user:om-sidecar",
      messages: expect.arrayContaining([
        expect.objectContaining({ id: "om-wire-buffer-1-1" }),
      ]),
      pendingTokens: 123,
    }));
    expect(om.observe).not.toHaveBeenCalled();
    expect(om.reflect).not.toHaveBeenCalled();
    expect(state.omSidecarCursor).toEqual({ turnIndex: 1, seqInTurn: 1 });
    expect(mockState.schedulePersist).toHaveBeenCalledWith(state, "om_sidecar:cursor");

    await getOmObservations({
      threadId: "om-wire-buffer",
      resourceId: "qingagent-user",
    });
    expect(om.getObservations).toHaveBeenCalledWith(
      "om-sidecar:om-wire-buffer",
      "qingagent-user:om-sidecar",
    );
  });

  it("OpenAI observer model 每次轻构建，后续调用不会复用首次 RequestContext", async () => {
    const {
      beginSessionSnapshotTurn,
      clearSessionSnapshot,
      getSessionSnapshot,
    } = await import("../llm/modelConfig.js");
    const { runOmSidecarAfterTurn } = await import("../session/omSidecar.js");
    const state = createSession("om-model-context-owner");
    state.threadId = state.sessionId;
    state.messages.push({ role: "user", content: "初始化 sidecar" });
    await runOmSidecarAfterTurn(state, new RequestContext([
      ["sessionId", state.sessionId],
    ] as never));
    const modelFactory = mockState.omInstances[0]!.config.model as (
      input: { requestContext?: RequestContext },
    ) => any;
    const overrides = {
      visitorApiKey: "context-owner-key",
      baseUrl: "https://context-owner.test/v1",
      modelIds: { flash: "context-owner-flash" },
      protocol: "openai",
    };
    const firstContext = new RequestContext([
      ["sessionId", "om-context-first"],
      ["streamId", "stream-first"],
      ["modelOverrides", overrides],
    ] as never) as RequestContext;
    const secondContext = new RequestContext([
      ["sessionId", "om-context-second"],
      ["streamId", "stream-second"],
      ["modelOverrides", overrides],
    ] as never) as RequestContext;
    beginSessionSnapshotTurn(firstContext);
    beginSessionSnapshotTurn(secondContext);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })));

    await modelFactory({ requestContext: firstContext }).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "first-marker" }] }],
    });
    await modelFactory({ requestContext: secondContext }).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "second-marker" }] }],
    });

    expect(getSessionSnapshot(firstContext)?.bodyText).toContain("first-marker");
    expect(getSessionSnapshot(firstContext)?.bodyText).not.toContain("second-marker");
    expect(getSessionSnapshot(secondContext)?.bodyText).toContain("second-marker");
    clearSessionSnapshot("om-context-first");
    clearSessionSnapshot("om-context-second");
  });

  it("getStatus.shouldObserve 时以对象参数触发 observe，不走 buffer", async () => {
    const { runOmSidecarAfterTurn } = await import("../session/omSidecar.js");
    mockState.setStatus({ shouldObserve: true, shouldBuffer: true });
    const state = createSession("om-wire-observe");
    state.threadId = state.sessionId;
    state.messages.push({ role: "user", content: "第一轮" });

    await runOmSidecarAfterTurn(state, new RequestContext([
      ["sessionId", state.sessionId],
    ] as never));

    const om = mockState.omInstances[0]!;
    expect(om.observe).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "om-sidecar:om-wire-observe",
      resourceId: "qingagent-user:om-sidecar",
      messages: expect.arrayContaining([
        expect.objectContaining({ id: "om-wire-observe-1-1" }),
      ]),
    }));
    expect(om.observe.mock.calls[0][0].requestContext.get("omBranchCallSite")).toBe("omObserve");
    expect(om.buffer).not.toHaveBeenCalled();
    expect(om.reflect).not.toHaveBeenCalled();
  });

  it("压缩激活后仅在观察成功落库时重建追加投影与单调删除集", async () => {
    process.env.QINGAGENT_OM_COMPRESS = "1";
    process.env.QINGAGENT_OM_COMPRESS_RECENT_TURNS = "1";
    const { prepareOmContextForTurn, runOmSidecarAfterTurn } = await import(
      "../session/omSidecar.js"
    );
    const state = createSession("om-wire-observation-cycle");
    state.threadId = state.sessionId;
    state.turnCounter = 3;
    state.messages.push(
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "第一轮回复" },
      { role: "user", content: "第二轮" },
      { role: "assistant", content: "第二轮回复" },
      { role: "user", content: "第三轮" },
      { role: "assistant", content: "第三轮回复" },
    );
    state.omObservedMessageIds = [
      `${state.sessionId}-1-1`,
      `${state.sessionId}-1-2`,
    ];
    state.omCompressionActive = true;
    state.omCompressionEpoch = 1;
    const previousSnapshot = {
      epoch: 1,
      observations: "- 旧观察",
      removedMessageIds: ["历史已删除消息", `${state.sessionId}-1-1`],
    };
    state.omCompressionSnapshot = previousSnapshot;
    mockState.setStatus({ shouldObserve: true, shouldBuffer: false });
    mockState.setObserveResult({
      observed: true,
      reflected: false,
      record: {
        id: "record-observed",
        activeObservations: "- 旧观察\n- 新观察",
        observedMessageIds: [
          `${state.sessionId}-1-1`,
          `${state.sessionId}-1-2`,
          `${state.sessionId}-2-1`,
          `${state.sessionId}-2-2`,
        ],
      },
    });

    await runOmSidecarAfterTurn(state);

    expect(state.omCompressionSnapshot).not.toBe(previousSnapshot);
    expect(state.omCompressionSnapshot?.observations.startsWith(
      previousSnapshot.observations,
    )).toBe(true);
    expect(state.omCompressionSnapshot?.observations).toBe("- 旧观察\n- 新观察");
    expect(state.omCompressionSnapshot?.removedMessageIds).toEqual([
      "历史已删除消息",
      `${state.sessionId}-1-1`,
      `${state.sessionId}-1-2`,
      `${state.sessionId}-2-1`,
      `${state.sessionId}-2-2`,
    ]);
    expect(state.omCompressionEpoch).toBe(2);
    expect(state.omCompressionSnapshot?.epoch).toBe(2);
    expect(mockState.schedulePersist).toHaveBeenCalledWith(
      state,
      "om_projection:observation_cycle",
    );

    const context = await prepareOmContextForTurn(state);
    expect(JSON.stringify(context.messagesForModel)).toContain("新观察");
    expect(JSON.stringify(context.messagesForModel)).not.toContain("第一轮回复");
    expect(JSON.stringify(context.messagesForModel)).not.toContain("第二轮回复");
    expect(JSON.stringify(context.messagesForModel)).toContain("第三轮回复");
  });

  it("后台 OM 只接收瘦 RequestContext 快照，不携带 live messages 引用", async () => {
    const { runOmSidecarAfterTurn } = await import("../session/omSidecar.js");
    const state = createSession("om-wire-context-snapshot");
    state.threadId = state.sessionId;
    state.messages.push({ role: "user", content: "第一轮" });
    const overrides = {
      visitorApiKey: "visitor-key",
      baseUrl: "http://127.0.0.1:9999/v1",
      modelIds: { flash: "observer-visitor-flash" },
      protocol: "openai",
    };
    const requestContext = new RequestContext([
      ["modelOverrides", overrides],
      ["messages", state.messages],
      ["runId", "run-om-context-snapshot"],
      ["origin", "manual"],
    ]) as RequestContext<unknown>;

    await runOmSidecarAfterTurn(state, requestContext);

    const om = mockState.omInstances[0]!;
    const bufferArg = om.buffer.mock.calls[0][0];
    const sidecarContext = bufferArg.requestContext as RequestContext<unknown>;
    expect(sidecarContext).not.toBe(requestContext);
    expect(sidecarContext.get("messages")).toBeUndefined();
    expect(sidecarContext.get("mastra__threadId")).toBe(
      "om-sidecar:om-wire-context-snapshot",
    );
    expect(sidecarContext.get("mastra__resourceId")).toBe(
      "qingagent-user:om-sidecar",
    );
    expect(sidecarContext.get("modelOverrides")).toEqual(overrides);
    expect(sidecarContext.get("runId")).toBe("run-om-context-snapshot");
    const modelFactory = om.config.model as (input: { requestContext?: RequestContext }) => {
      modelId?: string;
    };
    expect(modelFactory({ requestContext: sidecarContext }).modelId).toBe(
      "observer-visitor-flash",
    );
  });

  it("后台观察连续失败升级为 error，并明确积压与随下批重试语义", async () => {
    mockState.setStatus({ shouldObserve: true, shouldBuffer: false });
    mockState.setObserveError(new Error("observe exploded"));
    const { scheduleOmSidecarAfterTurn } = await import("../session/omSidecar.js");
    const state = createSession("om-wire-handoff-failure");
    state.threadId = state.sessionId;
    state.omCompressionActive = true;
    state.omCompressionEpoch = 4;
    const snapshotBeforeFailure = {
      epoch: 4,
      observations: "- 失败前观察",
      removedMessageIds: ["既有删除消息"],
    };
    state.omCompressionSnapshot = snapshotBeforeFailure;
    state.messages.push({ role: "user", content: "第一批" });
    const requestContext = new RequestContext([
      ["sessionId", state.sessionId],
      ["runId", "run-om-failure"],
    ] as never);

    scheduleOmSidecarAfterTurn(state, requestContext);
    await vi.waitFor(() => expect(mockState.logger.error).toHaveBeenCalledTimes(1));
    expect(String(mockState.logger.error.mock.calls[0]?.[0])).toContain(
      "该批观察失败，将随下批新消息重试",
    );
    expect(mockState.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("background turn handoff failed"),
      expect.anything(),
    );

    state.messages.push({ role: "user", content: "第二批" });
    scheduleOmSidecarAfterTurn(state, requestContext);
    await vi.waitFor(() => expect(mockState.logger.error).toHaveBeenCalledTimes(2));
    expect(mockState.logger.error).toHaveBeenLastCalledWith(
      expect.stringContaining("连续 2 次，观察积压正在累积"),
      expect.objectContaining({
        sessionId: state.sessionId,
        error: "observe exploded",
        consecutiveFailures: 2,
      }),
    );
    expect(state.omCompressionSnapshot).toBe(snapshotBeforeFailure);
    expect(state.omCompressionEpoch).toBe(4);
  });

  it("getStatus.shouldReflect 时触发 reflect", async () => {
    process.env.QINGAGENT_OM_COMPRESS = "1";
    const { prepareOmContextForTurn, runOmSidecarAfterTurn } = await import(
      "../session/omSidecar.js"
    );
    mockState.setStatus({
      shouldBuffer: false,
      shouldReflect: true,
      record: {
        id: "record-1",
        observedMessageIds: ["om-wire-reflect-1-1"],
      },
    });
    mockState.setReflectResult({
      reflected: true,
      record: {
        id: "record-reflected",
        activeObservations: "- 反思后的整体观察",
        observedMessageIds: [],
      },
    });
    const state = createSession("om-wire-reflect");
    state.threadId = state.sessionId;
    state.omObservedMessageIds = ["legacy-observed"];
    state.omCompressionActive = true;
    state.omCompressionEpoch = 7;
    const snapshotBeforeReflection = {
      epoch: 7,
      observations: "- 旧观察第一行\n- 旧观察第二行",
      removedMessageIds: ["历史已删除消息"],
    };
    state.omCompressionSnapshot = snapshotBeforeReflection;
    state.messages.push({ role: "user", content: "第一轮" });

    await runOmSidecarAfterTurn(state, new RequestContext([
      ["sessionId", state.sessionId],
    ] as never));

    const om = mockState.omInstances[0]!;
    expect(om.reflect).toHaveBeenCalledWith(
      "om-sidecar:om-wire-reflect",
      "qingagent-user:om-sidecar",
      undefined,
      expect.any(RequestContext),
    );
    expect(om.reflect.mock.calls[0][3].get("omBranchCallSite")).toBe("omReflect");
    expect(state.omObservedMessageIds).toEqual([
      "legacy-observed",
      "om-wire-reflect-1-1",
    ]);
    expect(mockState.schedulePersist).toHaveBeenCalledWith(
      state,
      "om_sidecar:observed_ids",
    );
    expect(state.omCompressionSnapshot).not.toBe(snapshotBeforeReflection);
    expect(state.omCompressionSnapshot).toEqual({
      epoch: 8,
      observations: "- 反思后的整体观察",
      removedMessageIds: ["历史已删除消息"],
    });
    expect(state.omCompressionEpoch).toBe(8);
    const context = await prepareOmContextForTurn(state);
    expect(JSON.stringify(context.messagesForModel)).toContain("反思后的整体观察");
    expect(JSON.stringify(context.messagesForModel)).not.toContain("旧观察第一行");
  });

  it("getStatus.canActivate 时先激活 buffered observations 并提交 activated ids", async () => {
    const { runOmSidecarAfterTurn } = await import("../session/omSidecar.js");
    mockState.setStatus({
      canActivate: true,
      shouldBuffer: false,
      shouldReflect: false,
      record: {
        id: "record-activate",
        observedMessageIds: ["om-wire-activate-1-1"],
      },
    });
    const state = createSession("om-wire-activate");
    state.threadId = state.sessionId;
    state.messages.push({ role: "user", content: "第一轮" });

    await runOmSidecarAfterTurn(state);

    const om = mockState.omInstances[0]!;
    expect(om.activate).toHaveBeenCalledWith({
      threadId: "om-sidecar:om-wire-activate",
      resourceId: "qingagent-user:om-sidecar",
      messages: expect.arrayContaining([
        expect.objectContaining({ id: "om-wire-activate-1-1" }),
      ]),
    });
    expect(om.getStatus).toHaveBeenCalledTimes(2);
    expect(state.omObservedMessageIds).toEqual([
      "om-wire-activate-1-1",
      "activated-id",
    ]);
    expect(mockState.schedulePersist).toHaveBeenCalledWith(
      state,
      "om_sidecar:observed_ids",
    );
  });

  it("resume 准备上下文时不首次开启压缩，保留尾部长期观察注入", async () => {
    process.env.QINGAGENT_OM_COMPRESS = "1";
    process.env.QINGAGENT_OM_COMPRESS_THRESHOLD_TOKENS = "1";
    mockState.setRecord({
      activeObservations: "- 第一轮事实已经被观察",
      observedMessageIds: ["om-wire-resume-no-latch-1-1"],
    });
    const { prepareOmContextForTurn } = await import("../session/omSidecar.js");
    const state = createSession("om-wire-resume-no-latch");
    state.threadId = state.sessionId;
    state.messages.push(
      { role: "user", content: "第一轮 " + "长文本 ".repeat(30) },
      { role: "assistant", content: "第一轮回复" },
      { role: "user", content: "第二轮" },
    );

    const context = await prepareOmContextForTurn(state, undefined, {
      allowCompressionActivation: false,
    });

    expect(context.compressed).toBe(false);
    expect(context.messagesForModel).toBe(state.messages);
    expect(context.tailObservationPrompt).toContain("[长期观察]");
    expect(context.tailObservationPrompt).toContain("第一轮事实已经被观察");
    expect(state.omCompressionActive).toBe(false);
    expect(mockState.schedulePersist).not.toHaveBeenCalledWith(
      state,
      "om_projection:compression_latch",
    );
  });
});

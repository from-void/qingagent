import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import { createSession } from "../bridge/sessionState.js";

const mockState = vi.hoisted(() => {
  const schedulePersist = vi.fn(async () => {});
  const memoryStore = { supportsObservationalMemory: true };
  const memory = {
    storage: {
      getStore: vi.fn(async (name: string) => name === "memory" ? memoryStore : undefined),
    },
  };
  const omInstances: any[] = [];
  let status: Record<string, unknown> = {};
  let record: Record<string, unknown> | null = null;
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
    observe = vi.fn(async () => ({ observed: true, reflected: false, record: { id: "record-1" } }));
    reflect = vi.fn(async () => ({ reflected: true, record: { id: "record-1" } }));
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
    memory,
    omInstances,
    setStatus(next: Record<string, unknown>) {
      status = next;
    },
    setRecord(next: Record<string, unknown> | null) {
      record = next;
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
    getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  getMemory: () => mockState.memory,
  getObservability: () => null,
}));

vi.mock("../bridge/threadPersistence.js", () => ({
  QINGAGENT_RESOURCE_ID: "qingagent-user",
  schedulePersist: mockState.schedulePersist,
}));

describe("OM sidecar 接线形状", () => {
  const originalSidecar = process.env.QINGAGENT_OM_SIDECAR;
  const originalCompress = process.env.QINGAGENT_OM_COMPRESS;
  const originalThreshold = process.env.QINGAGENT_OM_COMPRESS_THRESHOLD_TOKENS;

  beforeEach(() => {
    process.env.QINGAGENT_OM_SIDECAR = "1";
    mockState.schedulePersist.mockClear();
    mockState.memory.storage.getStore.mockClear();
    mockState.omInstances.length = 0;
    mockState.setStatus({});
    mockState.setRecord(null);
    vi.resetModules();
  });

  afterEach(() => {
    if (originalSidecar === undefined) delete process.env.QINGAGENT_OM_SIDECAR;
    else process.env.QINGAGENT_OM_SIDECAR = originalSidecar;
    if (originalCompress === undefined) delete process.env.QINGAGENT_OM_COMPRESS;
    else process.env.QINGAGENT_OM_COMPRESS = originalCompress;
    if (originalThreshold === undefined) delete process.env.QINGAGENT_OM_COMPRESS_THRESHOLD_TOKENS;
    else process.env.QINGAGENT_OM_COMPRESS_THRESHOLD_TOKENS = originalThreshold;
  });

  it("用 thread scope sidecar 持久化 MastraDBMessage，并以对象参数触发 buffer", async () => {
    const { getOmObservations, runOmSidecarAfterTurn } = await import("../bridge/omSidecar.js");
    const state = createSession("om-wire-buffer");
    state.threadId = state.sessionId;
    state.messages.push({ role: "user", content: "第一轮" });

    await runOmSidecarAfterTurn(state);

    const om = mockState.omInstances[0]!;
    expect(om.config).toMatchObject({
      scope: "thread",
      observation: { observeAttachments: false, messageTokens: 30_000 },
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

  it("getStatus.shouldObserve 时以对象参数触发 observe，不走 buffer", async () => {
    const { runOmSidecarAfterTurn } = await import("../bridge/omSidecar.js");
    mockState.setStatus({ shouldObserve: true, shouldBuffer: true });
    const state = createSession("om-wire-observe");
    state.threadId = state.sessionId;
    state.messages.push({ role: "user", content: "第一轮" });

    await runOmSidecarAfterTurn(state);

    const om = mockState.omInstances[0]!;
    expect(om.observe).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "om-sidecar:om-wire-observe",
      resourceId: "qingagent-user:om-sidecar",
      messages: expect.arrayContaining([
        expect.objectContaining({ id: "om-wire-observe-1-1" }),
      ]),
    }));
    expect(om.buffer).not.toHaveBeenCalled();
    expect(om.reflect).not.toHaveBeenCalled();
  });

  it("后台 OM 只接收瘦 RequestContext 快照，不携带 live messages 引用", async () => {
    const { runOmSidecarAfterTurn } = await import("../bridge/omSidecar.js");
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
    const modelFactory = om.config.model as (input: { requestContext?: RequestContext }) => {
      modelId?: string;
    };
    expect(modelFactory({ requestContext: sidecarContext }).modelId).toBe(
      "observer-visitor-flash",
    );
  });

  it("getStatus.shouldReflect 时触发 reflect", async () => {
    const { runOmSidecarAfterTurn } = await import("../bridge/omSidecar.js");
    mockState.setStatus({
      shouldBuffer: false,
      shouldReflect: true,
      record: {
        id: "record-1",
        observedMessageIds: ["om-wire-reflect-1-1"],
      },
    });
    const state = createSession("om-wire-reflect");
    state.threadId = state.sessionId;
    state.omObservedMessageIds = ["legacy-observed"];
    state.messages.push({ role: "user", content: "第一轮" });

    await runOmSidecarAfterTurn(state);

    const om = mockState.omInstances[0]!;
    expect(om.reflect).toHaveBeenCalledWith(
      "om-sidecar:om-wire-reflect",
      "qingagent-user:om-sidecar",
      undefined,
      undefined,
    );
    expect(state.omObservedMessageIds).toEqual([
      "legacy-observed",
      "om-wire-reflect-1-1",
    ]);
    expect(mockState.schedulePersist).toHaveBeenCalledWith(
      state,
      "om_sidecar:observed_ids",
    );
  });

  it("getStatus.canActivate 时先激活 buffered observations 并提交 activated ids", async () => {
    const { runOmSidecarAfterTurn } = await import("../bridge/omSidecar.js");
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
    const { prepareOmContextForTurn } = await import("../bridge/omSidecar.js");
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

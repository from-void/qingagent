import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCallSpec } from "@qingagent/contract-ts";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  submitQueued: vi.fn(async () => ({ completion: Promise.resolve([]) })),
  submit: vi.fn(async () => []),
  schedulePersist: vi.fn(async () => undefined),
  resolveRequestModelOverrides: vi.fn(async () => ({
    provider: "deepseek" as const,
    visitorApiKey: "ask-more-key",
  })),
}));

vi.mock("../gateway/bridgeHandler", () => ({
  getSession: mocks.getSession,
  sessionManager: {
    submitQueued: mocks.submitQueued,
    submit: mocks.submit,
  },
}));

vi.mock("../modelOverridesProvider", () => ({
  resolveRequestModelOverrides: mocks.resolveRequestModelOverrides,
}));

vi.mock("@qingagent/core", async () => {
  const actual = await vi.importActual<typeof import("@qingagent/core")>("@qingagent/core");
  return {
    ...actual,
    schedulePersist: mocks.schedulePersist,
    streamMoreQuestions: async function* () {
      yield [{
        id: "q-extra-audience",
        label: "还需要补充哪些读者信息？",
        kind: { kind: "text" as const },
        options: [],
        placeholder: "可选",
      }];
    },
  };
});

function questionnaireSpec(): ToolCallSpec {
  return {
    id: "plan-draft-actor",
    name: "planDraft",
    render: { kind: "rightForm" },
    status: { kind: "pending" },
    body: {
      kind: "askUser",
      data: {
        id: "plan-draft-actor",
        mode: { kind: "fullpage" },
        purpose: null,
        source: null,
        rationale: null,
        questions: [],
      },
    },
    result: null,
  };
}

describe("POST /api/v1/ask-more actor 回填", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("模型覆盖与追加问题只经 SessionActor 命令回填，路由不直接改会话", async () => {
    const { createSession } = await vi.importActual<typeof import("@qingagent/core")>(
      "@qingagent/core",
    );
    const session = createSession("ask-more-actor-route");
    session.chatHistory.push({
      id: "message-1",
      role: { kind: "agent" },
      ts: "2026-08-04T00:00:00.000Z",
      parts: [{ kind: "toolCall", data: questionnaireSpec() }],
      chips: null,
    });
    mocks.getSession.mockReturnValue(session);
    let releaseStarted!: () => void;
    const startedCompletion = new Promise<never[]>((resolve) => {
      releaseStarted = () => resolve([]);
    });
    mocks.submitQueued.mockResolvedValueOnce({ completion: startedCompletion });

    const { askMoreRoutes } = await import("../routes/askMore");
    const response = await askMoreRoutes.request("/ask-more", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sessionId,
        toolCallId: "plan-draft-actor",
        currentQuestions: [],
        currentAnswers: {},
      }),
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("expected SSE response body");
    let progressTimer!: ReturnType<typeof setTimeout>;
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        progressTimer = setTimeout(
          () => reject(new Error("timed out waiting for askMore progress")),
          2_000,
        );
      }),
    ]);
    clearTimeout(progressTimer);
    const decoder = new TextDecoder();
    let body = decoder.decode(first.value, { stream: true });
    // started 只需先进入 actor 队列；即便前方命令未完成，模型侧 progress 仍实时下发。
    expect(body).toContain("event: progress");
    expect(mocks.submit).not.toHaveBeenCalled();

    releaseStarted();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      body += decoder.decode(next.value, { stream: true });
    }
    body += decoder.decode();
    expect(body).toContain("event: done");
    expect(mocks.submitQueued).toHaveBeenCalledTimes(1);
    expect(mocks.submitQueued).toHaveBeenCalledWith(session.sessionId, {
      command: {
        kind: "updateAskMore",
        data: {
          phase: "started",
          sessionId: session.sessionId,
          toolCallId: "plan-draft-actor",
        },
      },
      modelOverrides: {
        provider: "deepseek",
        visitorApiKey: "ask-more-key",
      },
    });
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(mocks.submit).toHaveBeenCalledWith(session.sessionId, {
      command: {
        kind: "updateAskMore",
        data: {
          phase: "completed",
          sessionId: session.sessionId,
          toolCallId: "plan-draft-actor",
          questions: [{
            id: "q-extra-audience",
            label: "还需要补充哪些读者信息？",
            kind: { kind: "text" },
            options: [],
            placeholder: "可选",
          }],
        },
      },
    });
    expect(session.modelOverrides).toBeUndefined();
    const questionnaire = session.chatHistory[0]!.parts[0]!;
    if (questionnaire.kind !== "toolCall" || questionnaire.data.body.kind !== "askUser") {
      throw new Error("expected askUser tool call");
    }
    expect(questionnaire.data.body.data.questions).toEqual([]);
    expect(mocks.schedulePersist).not.toHaveBeenCalled();
  }, 20_000);

  it("actor 内已有写入未结束时，askMore 的模型覆盖与历史回填都排队等待", async () => {
    const { createSession } = await vi.importActual<typeof import("@qingagent/core")>(
      "@qingagent/core",
    );
    const { InMemoryFrameLog } = await import("../gateway/frameLog");
    const { SessionManager } = await import("../gateway/sessionManager");
    const { handleCommand } = await import("../gateway/commandRouter");
    const { sessions } = await import("../gateway/sessionRegistry");
    const session = createSession("ask-more-actor-order");
    session.chatHistory.push({
      id: "message-1",
      role: { kind: "agent" },
      ts: "2026-08-04T00:00:00.000Z",
      parts: [{ kind: "toolCall", data: questionnaireSpec() }],
      chips: null,
    });
    sessions.set(session.sessionId, session);

    let firstBlockStarted!: () => void;
    const firstBlockStartedPromise = new Promise<void>((resolve) => {
      firstBlockStarted = resolve;
    });
    let releaseFirstBlock!: () => void;
    const firstBlockReleasePromise = new Promise<void>((resolve) => {
      releaseFirstBlock = resolve;
    });
    const manager = new SessionManager({
      frameLog: new InMemoryFrameLog(),
      handleCommand,
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
    });

    try {
      const firstBlock = manager.runExclusive(session.sessionId, async function* () {
        firstBlockStarted();
        await firstBlockReleasePromise;
      });
      await firstBlockStartedPromise;

      const startedUpdate = manager.submit(session.sessionId, {
        command: {
          kind: "updateAskMore",
          data: {
            phase: "started",
            sessionId: session.sessionId,
            toolCallId: "plan-draft-actor",
          },
        },
        modelOverrides: {
          provider: "kimi",
          visitorApiKey: "actor-key",
        },
      });
      await Promise.resolve();

      expect(session.modelOverrides).toBeUndefined();
      const before = session.chatHistory[0]!.parts[0]!;
      if (before.kind !== "toolCall" || before.data.body.kind !== "askUser") {
        throw new Error("expected askUser tool call");
      }
      expect(before.data.body.data.questions).toEqual([]);
      expect(mocks.schedulePersist).not.toHaveBeenCalled();

      releaseFirstBlock();
      await Promise.all([firstBlock, startedUpdate]);

      expect(session.modelOverrides).toEqual({
        provider: "kimi",
        visitorApiKey: "actor-key",
      });
      expect(before.data.body.data.questions).toEqual([]);

      let secondBlockStarted!: () => void;
      const secondBlockStartedPromise = new Promise<void>((resolve) => {
        secondBlockStarted = resolve;
      });
      let releaseSecondBlock!: () => void;
      const secondBlockReleasePromise = new Promise<void>((resolve) => {
        releaseSecondBlock = resolve;
      });
      const secondBlock = manager.runExclusive(session.sessionId, async function* () {
        secondBlockStarted();
        await secondBlockReleasePromise;
      });
      await secondBlockStartedPromise;
      const completedUpdate = manager.submit(session.sessionId, {
        command: {
          kind: "updateAskMore",
          data: {
            phase: "completed",
            sessionId: session.sessionId,
            toolCallId: "plan-draft-actor",
            questions: [{
              id: "q-extra-audience",
              label: "还需要补充哪些读者信息？",
              kind: { kind: "text" },
              options: [],
              placeholder: "可选",
            }],
          },
        },
      });
      await Promise.resolve();

      expect(before.data.body.data.questions).toEqual([]);
      expect(mocks.schedulePersist).not.toHaveBeenCalled();

      releaseSecondBlock();
      await Promise.all([secondBlock, completedUpdate]);

      const after = session.chatHistory[0]!.parts[0]!;
      if (after.kind !== "toolCall" || after.data.body.kind !== "askUser") {
        throw new Error("expected askUser tool call");
      }
      expect(after.data.body.data.questions).toEqual([
        expect.objectContaining({
          id: "q-extra-audience",
          label: "还需要补充哪些读者信息？",
        }),
      ]);
      expect(mocks.schedulePersist).toHaveBeenCalledWith(session, "askMore");
    } finally {
      await manager.disposeAll();
      sessions.delete(session.sessionId);
    }
  });
});

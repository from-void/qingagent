import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  schedulePersist: vi.fn(),
}));

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

vi.mock("../session/threadPersistence.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../session/threadPersistence.js")>(),
  schedulePersist: mocks.schedulePersist,
}));

describe("runAgentTurn 提前关闭资源结算", () => {
  beforeEach(() => {
    mocks.schedulePersist.mockReset();
  });

  it("finally 持久化未决时也会先释放 turn 资源", async () => {
    let releasePersist!: () => void;
    const pendingPersist = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    mocks.schedulePersist.mockImplementation(
      async (_state, reason: string) =>
        reason === "runAgentTurn:finally" ? pendingPersist : undefined,
    );
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");
    const { createSession } = await import("../session/sessionState.js");
    const state = createSession("consumer-close-with-pending-persist");
    const generator = runAgentTurn(state, "开始处理");

    await expect(generator.next()).resolves.toMatchObject({
      value: {
        kind: "stream",
        data: { kind: "start" },
      },
      done: false,
    });
    expect(state._abortController).not.toBeNull();
    expect(state._activeTurnPromise).not.toBeNull();
    expect(state._turnOwner).not.toBeNull();

    const closePromise = generator.return(undefined);
    await vi.waitFor(() => {
      expect(mocks.schedulePersist).toHaveBeenCalledWith(
        state,
        "runAgentTurn:finally",
      );
    });

    expect(state.streamId).toBeNull();
    expect(state._abortController).toBeNull();
    expect(state._activeTurnPromise).toBeNull();
    expect(state._turnOwner).toBeNull();

    releasePersist();
    await closePromise;
  });
});

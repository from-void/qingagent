import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import type { Material } from "../types/material.js";

const mocks = vi.hoisted(() => ({
  agentStream: vi.fn(),
  getSkills: vi.fn(),
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
  getQingagentSkills: mocks.getSkills,
  qingagentAgent: {
    stream: mocks.agentStream,
    resumeStream: vi.fn(),
  },
}));

vi.mock("../session/threadPersistence.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../session/threadPersistence.js")>(),
  schedulePersist: mocks.schedulePersist,
}));

describe("runAgentTurn 提前关闭资源结算", () => {
  beforeEach(() => {
    mocks.agentStream.mockReset();
    mocks.getSkills.mockReset().mockResolvedValue({
      maybeRefresh: vi.fn(async () => {}),
      has: vi.fn(async () => false),
    });
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

function material(
  overrides: Partial<Material> & Pick<Material, "id">,
): Material {
  return {
    id: overrides.id,
    filename: overrides.filename ?? "素材.txt",
    mimeType: overrides.mimeType ?? "text/plain",
    text: overrides.text ?? "可核对的素材正文",
    summary: overrides.summary ?? null,
    fileId: overrides.fileId ?? null,
    metadata: overrides.metadata ?? {
      pages: null,
      wordCount: 8,
      title: null,
      parseState: "ready",
    },
    createdAt: overrides.createdAt ?? "2026-07-29T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-29T00:00:00.000Z",
  };
}

async function collectFrames(
  generator: AsyncGenerator<BridgeFrame>,
): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of generator) frames.push(frame);
  return frames;
}

describe("来源核查前置条件", () => {
  beforeEach(() => {
    mocks.agentStream.mockReset();
    mocks.getSkills.mockReset();
    mocks.schedulePersist.mockReset();
  });

  it("无素材时在进入模型前返回 blocked，既不下结论也不产批注", async () => {
    const [
      {
        runAgentTurn,
        SOURCE_REVIEW_NO_MATERIAL_REASON,
      },
      { createSession },
    ] = await Promise.all([
      import("../agent-run/runAgentTurn.js"),
      import("../session/sessionState.js"),
    ]);
    const state = createSession("source-review-no-material");
    const frames = await collectFrames(runAgentTurn(
      state,
      "请联网查证正文里的数字",
      [],
      [],
      [],
      null,
      undefined,
      undefined,
      {
        type: "source",
        templateId: "source-default",
        templateName: "标准来源核查",
      },
    ));

    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({
      kind: "stream",
      data: { kind: "start" },
    });
    expect(frames[1]).toMatchObject({
      kind: "stream",
      data: {
        kind: "draftingFailed",
        data: {
          reason: SOURCE_REVIEW_NO_MATERIAL_REASON,
          retriable: false,
        },
      },
    });
    expect(frames[2]).toMatchObject({
      kind: "stream",
      data: {
        kind: "end",
        data: {
          reason: {
            kind: "error",
            data: SOURCE_REVIEW_NO_MATERIAL_REASON,
          },
        },
      },
    });
    expect(mocks.getSkills).not.toHaveBeenCalled();
    expect(mocks.agentStream).not.toHaveBeenCalled();
    expect(state.chatHistory).toEqual([]);
    expect(state.annotationGroups).toEqual([]);
  });

  it("只把解析成功且有内容的会话素材视为可对照素材", async () => {
    const {
      hasReviewableSourceMaterial,
      reviewPreconditionFailure,
    } = await import("../agent-run/runAgentTurn.js");
    const context = {
      type: "source" as const,
      templateId: "source-default",
      templateName: "标准来源核查",
    };

    expect(reviewPreconditionFailure(context, new Map())).not.toBeNull();
    expect(hasReviewableSourceMaterial(new Map([
      ["error", material({
        id: "error",
        text: "",
        summary: "解析失败",
        metadata: {
          pages: null,
          wordCount: 0,
          title: null,
          parseState: "error",
          parseError: "文件损坏",
        },
      })],
    ]))).toBe(false);
    expect(reviewPreconditionFailure(context, new Map([
      ["ready", material({ id: "ready" })],
    ]))).toBeNull();
    expect(reviewPreconditionFailure({
      ...context,
      type: "privacy",
    }, new Map())).toBeNull();
  });
});

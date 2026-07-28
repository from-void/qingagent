import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import {
  commitPatches,
  commitReviewGroups,
} from "../bridgeCore";
import type { CommandExecutionContext } from "../commandTypes";
import { handleReviewCommand } from "../reviewCommands";
import { getOrRestoreSession } from "../sessionLifecycle";

vi.mock("../bridgeCore", () => ({
  commitPatches: vi.fn(),
  commitReviewGroups: vi.fn(),
  ignoreAnnotationGroups: vi.fn(),
  insertReviewDismissalSignal: vi.fn(),
  updatePatchVerdict: vi.fn(),
}));

vi.mock("../commandTracing", () => ({
  bindClientTraceId: vi.fn(),
}));

vi.mock("../sessionLifecycle", () => ({
  findSessionByPatch: vi.fn(),
  findSessionByReviewBatchId: vi.fn(),
  getOrRestoreSession: vi.fn(),
}));

const context: CommandExecutionContext = {
  sessionId: "session-1",
  clientTraceId: undefined,
  resolvedClientTraceId: undefined,
  origin: "manual",
  modelOverrides: undefined,
  client: undefined,
  commandAbortSignal: undefined,
};

async function collectFrames(
  generator: AsyncGenerator<BridgeFrame>,
): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of generator) frames.push(frame);
  return frames;
}

describe("handleReviewCommand commitPatches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOrRestoreSession).mockResolvedValue({
      sessionId: "session-1",
      docId: "doc-1",
      annotationGroups: [],
    } as never);
    vi.mocked(commitReviewGroups).mockImplementation(async function* () {
      yield {
        kind: "sessionMeta",
        data: { sessionId: "session-1", title: "batches" },
      };
    });
    vi.mocked(commitPatches).mockImplementation(async function* () {
      yield {
        kind: "sessionMeta",
        data: { sessionId: "session-1", title: "patches" },
      };
    });
  });

  it("同时提交 patch ids 与 review batch ids 时处理两组目标", async () => {
    const frames = await collectFrames(handleReviewCommand({
      kind: "commitPatches",
      data: {
        ids: ["patch-1", "patch-2"],
        reviewBatchIds: ["batch-1"],
      },
    }, context));

    expect(commitReviewGroups).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1" }),
      {
        acceptReviewBatchIds: ["batch-1"],
        keepPendingReviewBatchIds: [],
      },
    );
    expect(commitPatches).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1" }),
      ["patch-1", "patch-2"],
    );
    expect(frames.map((frame) => frame.kind === "sessionMeta" ? frame.data.title : null))
      .toEqual(["batches", "patches"]);
  });

  it("单独提交任一目标字段时保持原有分支行为", async () => {
    await collectFrames(handleReviewCommand({
      kind: "commitPatches",
      data: { ids: ["patch-1"] },
    }, context));
    expect(commitPatches).toHaveBeenCalledTimes(1);
    expect(commitReviewGroups).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(getOrRestoreSession).mockResolvedValue({
      sessionId: "session-1",
      docId: "doc-1",
      annotationGroups: [],
    } as never);
    await collectFrames(handleReviewCommand({
      kind: "commitPatches",
      data: { ids: [], reviewBatchIds: ["batch-1"] },
    }, context));
    expect(commitReviewGroups).toHaveBeenCalledTimes(1);
    expect(commitPatches).not.toHaveBeenCalled();
  });
});

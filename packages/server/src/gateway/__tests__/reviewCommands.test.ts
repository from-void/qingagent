import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import {
  commitPatches,
  commitReviewGroups,
  expandReviewIds,
  updatePatchVerdict,
} from "../bridgeCore";
import type { CommandExecutionContext } from "../commandTypes";
import { handleReviewCommand } from "../reviewCommands";
import { getOrRestoreSession } from "../sessionLifecycle";

vi.mock("../bridgeCore", () => ({
  commitPatches: vi.fn(),
  commitReviewGroups: vi.fn(),
  expandReviewIds: vi.fn(),
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
      patchVerdicts: new Map(),
    } as never);
    vi.mocked(expandReviewIds).mockImplementation((
      _session,
      _ids,
      reviewBatchIds,
    ) => {
      return reviewBatchIds?.includes("batch-1")
        ? ["patch-2", "patch-3"]
        : [];
    });
    vi.mocked(updatePatchVerdict).mockImplementation(async function* (
      session,
      id,
      verdict,
    ) {
      session.patchVerdicts.set(id!, verdict);
      yield {
        kind: "sessionMeta",
        data: { sessionId: "session-1", title: `verdict:${id}` },
      };
    });
    vi.mocked(commitPatches).mockImplementation(async function* () {
      yield {
        kind: "sessionMeta",
        data: { sessionId: "session-1", title: "patches" },
      };
    });
  });

  it("ids 与 batch 重叠时先接受 batch 目标，再去重为一次文档提交", async () => {
    const frames = await collectFrames(handleReviewCommand({
      kind: "commitPatches",
      data: {
        ids: ["patch-1", "patch-2"],
        reviewBatchIds: ["batch-1"],
      },
    }, context));

    expect(expandReviewIds).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1" }),
      [],
      ["batch-1"],
      { command: "commit", skipped: "acceptReviewBatchId" },
    );
    expect(updatePatchVerdict).toHaveBeenCalledTimes(2);
    expect(updatePatchVerdict).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: "session-1" }),
      "patch-2",
      "accepted",
    );
    expect(updatePatchVerdict).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: "session-1" }),
      "patch-3",
      "accepted",
    );
    expect(commitPatches).toHaveBeenCalledTimes(1);
    expect(commitPatches).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1" }),
      ["patch-1", "patch-2", "patch-3"],
    );
    expect(frames.map((frame) => frame.kind === "sessionMeta" ? frame.data.title : null))
      .toEqual(["verdict:patch-2", "verdict:patch-3", "patches"]);
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
      patchVerdicts: new Map(),
    } as never);
    await collectFrames(handleReviewCommand({
      kind: "commitPatches",
      data: { ids: [], reviewBatchIds: ["batch-1"] },
    }, context));
    expect(commitReviewGroups).not.toHaveBeenCalled();
    expect(commitPatches).toHaveBeenCalledTimes(1);
    expect(commitPatches).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1" }),
      ["patch-2", "patch-3"],
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "@qingagent/db/testing";

const mocks = vi.hoisted(() => ({
  draftTemplate: vi.fn(),
}));

vi.mock("@qingagent/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@qingagent/core")>(),
  draftTemplate: mocks.draftTemplate,
}));

import { handleCommand } from "../gateway/bridgeHandler";

async function collectFrames(generator: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of generator) frames.push(frame);
  return frames;
}

async function createSession(): Promise<string> {
  const frames = await collectFrames(handleCommand({
    kind: "startSession",
    data: { mode: { kind: "new", data: { template: null } } },
  }));
  const meta = frames.find((frame) => frame.kind === "sessionMeta");
  if (meta?.kind !== "sessionMeta") throw new Error("缺少 sessionMeta");
  return meta.data.sessionId;
}

let db: TempDocumentsDb;
beforeEach(() => {
  db = prepareTempDocumentsDb("qa-draft-template-bridge-");
  mocks.draftTemplate.mockReset().mockResolvedValue({
    name: "投资人审查",
    prompt: "逐项检查市场、壁垒与回报。",
  });
});
afterEach(() => db.cleanup());

describe("draftTemplate bridge 命令", () => {
  it("透传场景、意图与 abortSignal，并返回 templateDrafted 帧", async () => {
    const sessionId = await createSession();
    const controller = new AbortController();
    const frames = await collectFrames(handleCommand({
      kind: "draftTemplate",
      data: {
        sessionId,
        scene: { kind: "review", type: "role", label: "角色审查" },
        intent: { name: "投资人", prompt: "检查回报" },
      },
    }, undefined, "manual", undefined, undefined, undefined, controller.signal));

    expect(frames).toContainEqual({
      kind: "templateDrafted",
      data: { name: "投资人审查", prompt: "逐项检查市场、壁垒与回报。" },
    });
    expect(mocks.draftTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId }),
      {
        scene: { kind: "review", type: "role", label: "角色审查" },
        intent: { name: "投资人", prompt: "检查回报" },
      },
      expect.objectContaining({}),
    );
    const requestContext = mocks.draftTemplate.mock.calls[0]?.[2];
    expect(requestContext.get("abortSignal")).toBe(controller.signal);
  });
});

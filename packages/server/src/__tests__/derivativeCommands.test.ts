import { describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";

const mocks = vi.hoisted(() => ({
  getOrRestoreSession: vi.fn(async () => ({ threadId: "session-empty" })),
  listDerivativesByThread: vi.fn(async () => []),
}));

vi.mock("../gateway/sessionLifecycle", () => ({
  getOrRestoreSession: mocks.getOrRestoreSession,
}));

vi.mock("../gateway/bridgeCore", () => ({
  createDerivativeDoc: vi.fn(),
  deleteDerivativeDoc: vi.fn(),
  generateTranslations: vi.fn(),
  getDerivativeDocument: vi.fn(),
  getDerivativeMeta: vi.fn(),
  listDerivativesByThread: mocks.listDerivativesByThread,
  loadMainDocumentByThread: vi.fn(),
  updateParams: vi.fn(),
}));

import { handleDerivativeCommand } from "../gateway/derivativeCommands";

describe("handleDerivativeCommand", () => {
  it("零条衍生稿时仍返回原 requestId 对应的 derivativesListed 空数组帧", async () => {
    const frames: BridgeFrame[] = [];
    const requestId = "request-list-empty";

    for await (const frame of handleDerivativeCommand({
      kind: "listDerivatives",
      data: { sessionId: "session-empty", requestId },
    }, {} as never)) {
      frames.push(frame);
    }

    expect(frames).toEqual([{
      kind: "derivativesListed",
      data: { requestId, items: [] },
    }]);
    expect(mocks.listDerivativesByThread).toHaveBeenCalledWith("session-empty");
  });
});

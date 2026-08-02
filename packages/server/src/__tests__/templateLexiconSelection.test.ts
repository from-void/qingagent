import { describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";

const mocks = vi.hoisted(() => ({
  getOrRestoreSession: vi.fn(async (sessionId: string) => ({ sessionId })),
  setEnabledLexicons: vi.fn(async (enabledLexiconIds: string[]) => [
    { id: "lexicon-ad", name: "广告法极限词", entryCount: 2, description: "广告合规", enabled: enabledLexiconIds.includes("lexicon-ad") },
    { id: "lexicon-medical", name: "医疗健康违禁宣称", entryCount: 2, description: "医疗合规", enabled: enabledLexiconIds.includes("lexicon-medical") },
  ]),
}));

vi.mock("../gateway/sessionLifecycle", () => ({
  getOrRestoreSession: mocks.getOrRestoreSession,
}));

vi.mock("../gateway/bridgeCore", () => ({
  deleteReviewTemplate: vi.fn(),
  deleteStyleTemplate: vi.fn(),
  draftTemplate: vi.fn(),
  getReviewDocSupplement: vi.fn(),
  getReviewTemplate: vi.fn(),
  getSelectedReviewTemplate: vi.fn(),
  getStyleTemplate: vi.fn(),
  listLexiconEntries: vi.fn(),
  listLexicons: vi.fn(),
  listReviewTemplates: vi.fn(),
  listStyleTemplates: vi.fn(),
  saveReviewTemplate: vi.fn(),
  saveStyleTemplate: vi.fn(),
  selectReviewTemplate: vi.fn(),
  setEnabledLexicons: mocks.setEnabledLexicons,
  upsertReviewDocSupplement: vi.fn(),
}));

import { handleTemplateCommand } from "../gateway/templateCommands";

describe("handleTemplateCommand 词库选择", () => {
  it("持久化启用集合并回传同源权威列表", async () => {
    const frames: BridgeFrame[] = [];

    for await (const frame of handleTemplateCommand({
      kind: "setEnabledLexicons",
      data: {
        sessionId: "session-1",
        requestId: "request-1",
        enabledLexiconIds: ["lexicon-ad"],
      },
    }, {} as never)) {
      frames.push(frame);
    }

    expect(mocks.setEnabledLexicons).toHaveBeenCalledWith(["lexicon-ad"]);
    expect(frames).toEqual([{
      kind: "enabledLexiconsSet",
      data: {
        requestId: "request-1",
        lexicons: [
          expect.objectContaining({ id: "lexicon-ad", enabled: true }),
          expect.objectContaining({ id: "lexicon-medical", enabled: false }),
        ],
      },
    }]);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getPmContentHash, pmToLegacySections, type PmDoc } from "@qingagent/pm-schema";
import {
  documentInput,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";

const { memory, threads } = vi.hoisted(() => {
  const threads = new Map<string, Record<string, unknown>>();
  const memory = {
    getThreadById: vi.fn(async ({ threadId }: { threadId: string }) =>
      threads.get(threadId) ?? null),
    recall: vi.fn(async () => ({ messages: [] })),
    listThreads: vi.fn(async () => ({ threads: [], total: 0, hasMore: false })),
    updateThread: vi.fn(),
    saveThread: vi.fn(),
  };
  return { memory, threads };
});

vi.mock("../../../core/src/mastra.js", () => ({
  mastra: {
    getLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    getMemory: () => memory,
    getAgent: () => ({}),
  },
  getObservability: () => null,
}));

vi.mock("../../../core/src/agents/qingagent.js", () => ({
  getQingagentSkills: vi.fn(async () => ({
    maybeRefresh: vi.fn(async () => undefined),
    has: vi.fn(async () => false),
  })),
  qingagentAgent: { stream: vi.fn(), resumeStream: vi.fn() },
}));

let tempDb: TempDocumentsDb;
let core: typeof import("@qingagent/core");
let app: typeof import("../app.js").app;
let bridge: typeof import("../gateway/bridgeHandler.js");

function paragraphDoc(text: string): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      attrs: { blockId: "cold-events-p" },
      content: [{ type: "text", text }],
    }],
  };
}

async function readSseUntil(
  response: Response,
  controller: AbortController,
  needle: string,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response has no body");
  const decoder = new TextDecoder();
  const deadline = Date.now() + 3_000;
  let body = "";
  while (!body.includes(needle) && Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
        setTimeout(() => resolve({ done: false, value: new Uint8Array() }), 25);
      }),
    ]);
    if (next.done) break;
    if (next.value.length > 0) body += decoder.decode(next.value, { stream: true });
  }
  controller.abort();
  await reader.cancel().catch(() => undefined);
  return body;
}

beforeAll(async () => {
  tempDb = prepareTempDocumentsDb("qa-pending-draft-cold-events-");
  core = await import("@qingagent/core");
  ({ app } = await import("../app.js"));
  bridge = await import("../gateway/bridgeHandler.js");
});

afterAll(() => {
  tempDb.cleanup();
});

describe("GET /api/v1/events 冷恢复待审冲突", () => {
  it("从持久层只读快照补发冲突提示且不消费或写库", async () => {
    const sessionId = "pending-draft-cold-events";
    const oldBase = paragraphDoc("旧基线");
    const current = paragraphDoc("后续已修改正文");
    const draft = paragraphDoc("过期待审草稿");
    await core.documentRepo.save(documentInput(sessionId, {
      id: sessionId,
      threadId: sessionId,
      docVersion: 5,
      lastSyncedVersion: 5,
      legacySections: pmToLegacySections(current) as never,
      pmDoc: current,
    }));
    await core.documentDraftRepo.savePending({
      docId: sessionId,
      threadId: sessionId,
      baseVersion: 4,
      baseHash: getPmContentHash(oldBase),
      draftPmDoc: draft,
    });
    threads.set(sessionId, {
      id: sessionId,
      title: "冷恢复冲突",
      resourceId: "qingagent-user",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      metadata: {
        docId: sessionId,
        docState: { kind: "pendingReview" },
        docVersion: 5,
        lastContentEditedAt: "2026-01-01T00:00:00.000Z",
        doc: current,
        legacySections: pmToLegacySections(current),
        messages: [],
      },
    });
    bridge.forgetSession(sessionId);
    bridge.sessionManager.frameLog.evict(sessionId);

    const controller = new AbortController();
    const response = await app.request(
      `/api/v1/events?sessionId=${sessionId}&after=0&epoch=0`,
      { signal: controller.signal },
    );
    expect(response.status).toBe(200);

    const body = await readSseUntil(response, controller, "draftingFailed");

    expect(body).toContain("正文已变化，请重新生成本轮审阅。");
    expect(body).not.toContain("docDiffReady");
    expect(bridge.getSession(sessionId)).toBeUndefined();
    await expect(core.documentDraftRepo.load(sessionId)).resolves.toMatchObject({
      status: "pending_review",
    });
    expect(memory.updateThread).not.toHaveBeenCalled();

    bridge.sessionManager.frameLog.evict(sessionId);
    threads.delete(sessionId);
  });
});

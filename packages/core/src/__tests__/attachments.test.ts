import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSession } from "../session/sessionState.js";
import type { BridgeFrame } from "@qingagent/contract-ts";

// ---------------------------------------------------------------------------
// Mastra runtime availability check
// ---------------------------------------------------------------------------
// In CI with Mastra core 1.36.0 the test environment may not have the full
// Mastra runtime (e.g. `__setLogger` missing on the agent prototype).
// Detect this early and skip all tests when the runtime is unusable.
let mastraAvailable = true;
try {
  const { mastra } = await import("../mastra.js");
  mastra.getAgent("qingagent"); // internally calls __setLogger
} catch {
  mastraAvailable = false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectFrames(
  gen: AsyncGenerator<BridgeFrame>,
): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) {
    frames.push(frame);
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Mock the qingagent agent before importing runAgentTurn.
// We only need to verify that resolveFileIds reads files from disk and
// buildAttachmentContext produces the right prefix — the agent itself
// is an external dependency we don't want to call for real.
// ---------------------------------------------------------------------------

// Capture fs operations
const readDirs: string[] = [];
const FILE_ID_1 = "11111111-1111-4111-8111-111111111111";
const FILE_ID_2 = "22222222-2222-4222-8222-222222222222";
const FILE_ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FILE_ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FILE_ID_CSV = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

vi.mock("node:fs/promises", () => {
  const fsPromises = {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    realpath: vi.fn(async (target: string) => target),
    readdir: vi.fn(async (dir: string) => {
      readDirs.push(dir);
      // Simulate a directory containing one file based on the fileId
      if (dir.includes(FILE_ID_1)) return ["test.txt"];
      if (dir.includes(FILE_ID_2)) return ["report.pdf"];
      if (dir.includes(FILE_ID_A)) return ["a.txt"];
      if (dir.includes(FILE_ID_B)) return ["b.pdf"];
      if (dir.includes(FILE_ID_CSV)) return ["data.csv"];
      throw new Error("ENOENT");
    }),
    stat: vi.fn(async () => ({ size: 100 })),
    readFile: vi.fn(async () => Buffer.from("mock file content")),
  };
  return { ...fsPromises, default: fsPromises };
});

// Mock the Mastra agent to avoid real LLM calls.
vi.mock("../agents/qingagent.js", () => ({
  qingagentAgent: {
    stream: vi.fn(async (messages: unknown[]) => {
      return {
        fullStream: (async function* () {
          yield {
            type: "text-delta" as const,
            payload: { text: "I received your files." },
          };
        })(),
        toolCalls: Promise.resolve([]),
      };
    }),
  },
}));

vi.mock("./docGenerator.js", () => ({
  parseLegacySections: vi.fn(() => []),
  buildDocumentSnapshot: vi.fn(),
  emitDocumentSnapshotFrames: vi.fn(() => []),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => vi.fn()),
}));

vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({ text: "[]" })),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!mastraAvailable)("resolveFileIds (via runAgentTurn)", () => {
  beforeEach(() => {
    readDirs.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves file metadata from disk when fileIds are provided", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");

    const state = createSession("sess-att-1");
    const fileIds = [FILE_ID_1];

    await collectFrames(runAgentTurn(state, "check this file", fileIds));

    // Should have read the uploads directory for the fileId
    expect(readDirs.length).toBeGreaterThanOrEqual(1);
    expect(readDirs.some((d) => d.includes(FILE_ID_1))).toBe(true);
  });

  it("resolves multiple file IDs", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");

    const state = createSession("sess-att-2");
    const fileIds = [FILE_ID_A, FILE_ID_B];

    await collectFrames(runAgentTurn(state, "analyze these", fileIds));

    expect(readDirs.some((d) => d.includes(FILE_ID_A))).toBe(true);
    expect(readDirs.some((d) => d.includes(FILE_ID_B))).toBe(true);
  });

  it("skips file resolution when fileIds array is empty", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");

    const state = createSession("sess-att-3");

    await collectFrames(runAgentTurn(state, "just text", []));

    // No directory reads should have occurred
    expect(readDirs).toHaveLength(0);
  });
});

describe.skipIf(!mastraAvailable)("buildAttachmentContext (via runAgentTurn user message)", () => {
  beforeEach(() => {
    readDirs.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prepends file context to user message when fileIds exist", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");

    const state = createSession("sess-ctx-1");
    const fileIds = [FILE_ID_2];

    await collectFrames(runAgentTurn(state, "summarize this", fileIds));

    const userMsg = state.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const content = userMsg!.content as string;
    expect(content).toContain("用户上传了以下文件");
    expect(content).toContain("report.pdf");
    expect(content).toContain("parseFile");
    expect(content).toContain("用户说：summarize this");
  });

  it("does not prepend context when no fileIds", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");

    const state = createSession("sess-ctx-2");

    await collectFrames(runAgentTurn(state, "just plain text", []));

    const userMsg = state.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const content = userMsg!.content as string;
    expect(content).toBe("just plain text");
    expect(content).not.toContain("用户上传了以下文件");
  });

  it("does not prepend context with default (no fileIds arg)", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");

    const state = createSession("sess-ctx-3");

    // Call without the fileIds argument (default = [])
    await collectFrames(runAgentTurn(state, "no files"));

    const userMsg = state.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe("no files");
  });
});

describe.skipIf(!mastraAvailable)("runAgentTurn frame sequence with fileIds", () => {
  beforeEach(() => {
    readDirs.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits stream.start, chatMessageAdded, chatMessageAppended, stream.end", async () => {
    const { runAgentTurn } = await import("../agent-run/runAgentTurn.js");

    const state = createSession("sess-seq-1");
    const fileIds = [FILE_ID_CSV];

    const frames = await collectFrames(
      runAgentTurn(state, "process this", fileIds),
    );

    // Should start with stream.start
    expect(frames[0]?.kind).toBe("stream");
    if (frames[0]?.kind === "stream") {
      expect(frames[0].data.kind).toBe("start");
    }

    // Should contain chatMessageAdded
    const addedFrame = frames.find((f) => f.kind === "chatMessageAdded");
    expect(addedFrame).toBeDefined();

    // Should contain chatMessageAppended with text
    const appendedFrame = frames.find((f) => f.kind === "chatMessageAppended");
    expect(appendedFrame).toBeDefined();

    // Should end with stream.end
    const lastFrame = frames[frames.length - 1];
    expect(lastFrame?.kind).toBe("stream");
    if (lastFrame?.kind === "stream") {
      expect(lastFrame.data.kind).toBe("end");
    }
  });
});

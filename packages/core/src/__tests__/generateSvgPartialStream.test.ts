import { RequestContext } from "@mastra/core/request-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  recordUsageEvent: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
}));
vi.mock("@qingagent/db", () => ({
  resolveDbUrl: () => "file::memory:",
  recordUsageEvent: mocks.recordUsageEvent,
}));

import {
  beginSessionSnapshotTurn,
  clearSessionSnapshot,
  createSnapshottingQingagentModel,
} from "../llm/modelConfig.js";
import { generateSvgTool } from "../tools/generateSvg.js";

const SESSION_ID = "generate-svg-partial-stream";
const originalApiKey = process.env.DEEPSEEK_API_KEY;

function requestContext(): RequestContext {
  return new RequestContext([
    ["sessionId", SESSION_ID],
    ["streamId", "stream-main"],
    ["runId", "run-generate-svg-partial-stream"],
  ] as never) as RequestContext;
}

function emptySse(): Response {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function captureSnapshot(context: RequestContext): Promise<void> {
  beginSessionSnapshotTurn(context);
  const model = createSnapshottingQingagentModel(context);
  await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "主链前缀" }] }],
    tools: [{
      type: "function",
      name: "generateSvg",
      description: "生成 SVG",
      inputSchema: { type: "object", properties: {} },
    }],
    toolChoice: { type: "auto" },
  } as never);
}

function branchSvgSse(advanceClock: () => void): Response {
  const encoder = new TextEncoder();
  const deltas = [
    "好的，下面是插图：\n```xml\n",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450"><rect x="0" y="0" width="800" height="450" fill="#efe7d6"/>',
    '<circle cx="220" cy="225" r="80" fill="#d9b45f"/>',
    '<circle cx="580" cy="225" r="80" fill="#315c72"/></svg>\n```',
  ];
  const events = [
    ...deltas.map((content, index) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: index === deltas.length - 1 ? "stop" : null }] })}\n\n`
    ),
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 24 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(new ReadableStream({
    pull(controller) {
      const event = events.shift();
      if (event === undefined) {
        controller.close();
        return;
      }
      advanceClock();
      controller.enqueue(encoder.encode(event));
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

describe("generateSvg BranchCall 流式 partialSvg", () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "sk-generate-svg-partial-test";
    mocks.mkdir.mockReset();
    mocks.recordUsageEvent.mockReset();
    mocks.writeFile.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSessionSnapshot(SESSION_ID);
    if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalApiKey;
  });

  it("BranchCall 验真后回放分段 SVG 时，streaming progress 携带并递增 partialSvg", async () => {
    let now = new Date().getTime();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const context = requestContext();
    const fetchMock = vi.fn().mockResolvedValueOnce(emptySse());
    vi.stubGlobal("fetch", fetchMock);
    await captureSnapshot(context);
    fetchMock.mockResolvedValueOnce(branchSvgSse(() => { now += 500; }));

    const writes: Array<Record<string, unknown>> = [];
    const result = await generateSvgTool.execute!({
      description: "两个相连的概念圆形",
      style: null,
      aspect: "16:9",
    }, {
      requestContext: context,
      writer: { write: (chunk: Record<string, unknown>) => { writes.push(chunk); } },
    } as never) as { ok: boolean };

    expect(result.ok).toBe(true);
    const partials = writes
      .filter((chunk) => chunk.type === "generatesvg-progress")
      .map((chunk) => chunk.progress as { stage?: string; partialSvg?: string | null })
      .filter((progress) => progress.stage === "streaming" && progress.partialSvg)
      .map((progress) => progress.partialSvg as string);

    expect(partials.length).toBeGreaterThanOrEqual(2);
    expect(partials.every((svg) => svg.startsWith("<svg"))).toBe(true);
    expect(partials[1]!.length).toBeGreaterThan(partials[0]!.length);
  });
});

import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../discovery.js", () => ({
  discoverInstance: vi.fn(async () => ({
    port: 45678,
    pid: process.pid,
    version: "test",
    token: "secret-token",
    startedAt: "2026-07-09T00:00:00.000Z",
  })),
}));

const originalFetch = globalThis.fetch;
const dirs: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("qa cli", () => {
  it("isDirectRun 识别软链入口,import main 不触发自执行", async () => {
    const { isDirectRun } = await import("../cli.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "qa-cli-symlink-test-"));
    dirs.push(dir);
    const realCliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
    const linkPath = path.join(dir, "qa");
    await symlink(realCliPath, linkPath);

    expect(isDirectRun(linkPath)).toBe(true);
  });

  it("chat log 请求 /chat 并打印可读角色", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn(async (input) => {
      expect(String(input)).toBe("http://127.0.0.1:45678/api/v1/external/sessions/s1/chat?limit=2");
      return new Response(JSON.stringify({
        sessionId: "s1",
        messages: [
          { id: "m1", role: { kind: "user" }, ts: "2026-07-09T00:00:00.000Z", text: "你好" },
          { id: "m2", role: { kind: "agent" }, ts: "2026-07-09T00:00:01.000Z", text: "已收到" },
        ],
      }));
    }) as typeof fetch;

    await main(["chat", "log", "-s", "s1", "--limit", "2"]);

    expect(stdout.mock.calls.map((call) => call[0]).join("")).toBe("你  你好\n青简  已收到\n");
    expect(stdout.mock.calls.map((call) => call[0]).join("")).not.toContain("secret-token");
  });

  it("chat log --json 打印服务端原始精简响应", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        sessionId: "s1",
        messages: [{ id: "m1", role: { kind: "user" }, ts: "2026-07-09T00:00:00.000Z", text: "你好" }],
      })),
    ) as typeof fetch;

    await main(["chat", "log", "-s", "s1", "--json"]);

    const output = stdout.mock.calls.map((call) => call[0]).join("");
    expect(JSON.parse(output)).toEqual({
      sessionId: "s1",
      messages: [{ id: "m1", role: { kind: "user" }, ts: "2026-07-09T00:00:00.000Z", text: "你好" }],
    });
    expect(output).not.toContain("secret-token");
  });

  it("files list 请求 /files 并打印材料和文件夹源", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn(async (input) => {
      expect(String(input)).toBe("http://127.0.0.1:45678/api/v1/external/sessions/s1/files");
      return new Response(JSON.stringify({
        sessionId: "s1",
        materials: [
          {
            id: "mat-1",
            filename: "brief.md",
            mime: "text/markdown",
            summary: "这是一段很重要的材料摘要",
            wordCount: 12,
            byteLen: 36,
            parseState: "ready",
            sourceUrl: null,
            createdAt: "2026-07-09T00:00:00.000Z",
          },
        ],
        folderSources: [
          { id: "fld-1", displayName: "资料夹", provider: "desktop-local", status: "connected" },
        ],
      }));
    }) as typeof fetch;

    await main(["files", "list", "-s", "s1"]);

    const output = stdout.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("材料区 session=s1");
    expect(output).toContain("- mat-1  brief.md  12字");
    expect(output).toContain("摘要: 这是一段很重要的材料摘要");
    expect(output).toContain("- fld-1  资料夹  desktop-local/connected");
    expect(output).not.toContain("secret-token");
  });

  it("files read 请求材料全文并提示截断", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn(async (input) => {
      expect(String(input)).toBe("http://127.0.0.1:45678/api/v1/external/sessions/s1/files/mat-1/text?maxBytes=3");
      return new Response(JSON.stringify({
        id: "mat-1",
        filename: "brief.md",
        mime: "text/markdown",
        text: "abc",
        byteLen: 6,
        truncated: true,
      }));
    }) as typeof fetch;

    await main(["files", "read", "-s", "s1", "--material", "mat-1", "--max-bytes", "3"]);

    expect(stdout.mock.calls.map((call) => call[0]).join("")).toBe("abc\n");
    expect(stderr.mock.calls.map((call) => call[0]).join("")).toContain("[qa] material truncated id=mat-1 byteLen=6");
  });

  it("doc events 带 after,连接后打印 ready marker", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn(async (input) => {
      expect(String(input)).toBe("http://127.0.0.1:45678/api/v1/external/sessions/s1/events?after=41");
      return new Response(sseStream([
        { seq: 42, kind: "docCommitted", data: { version: 2 } },
      ]));
    }) as typeof fetch;

    await main(["doc", "events", "-s", "s1", "--after", "41", "--until", "reviewed"]);

    expect(stderr.mock.calls.map((call) => call[0]).join("")).toContain("[qa] watching session=s1 after=41\n");
    expect(stderr.mock.calls.map((call) => call[0]).join("")).toContain("[qa] events exited reason=reviewed received=1\n");
    expect(stdout.mock.calls.map((call) => call[0]).join("")).toContain("\"kind\":\"docCommitted\"");
  });

  it("doc events --until 未显式 after 时从 tip 开始,不从 0 回放旧帧", async () => {
    const { main } = await import("../cli.js");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:45678/api/v1/external/sessions/s1/events?after=tip");
      return new Response(openSseStream(init?.signal));
    }) as typeof fetch;

    await main(["doc", "events", "-s", "s1", "--until", "reviewed", "--timeout", "10ms"]);

    const err = stderr.mock.calls.map((call) => call[0]).join("");
    expect(err).toContain("--until 未提供 --after");
    expect(err).toContain("[qa] watching session=s1 after=tip\n");
    expect(err.trim().endsWith("[qa] events exited reason=timeout received=0")).toBe(true);
  });

  it("doc events 使用 proposeSeq 监听时没有新裁决帧会 timeout", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:45678/api/v1/external/sessions/s1/events?after=99");
      return new Response(openSseStream(init?.signal));
    }) as typeof fetch;

    await main(["doc", "events", "-s", "s1", "--after", "99", "--until", "reviewed", "--timeout", "10ms"]);

    expect(stdout.mock.calls.map((call) => call[0]).join("")).toBe("");
    expect(stderr.mock.calls.map((call) => call[0]).join("")).toContain("[qa] events exited reason=timeout received=0");
  });

  it("doc events 收到 meta gap 时以 reason=gap 退出且不输出 meta", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn(async () =>
      new Response(sseRawStream([
        `event: meta\ndata: ${JSON.stringify({ epoch: 1, minSeq: 1, nextSeq: 1, gap: true })}\n\n`,
      ])),
    ) as typeof fetch;

    await main(["doc", "events", "-s", "s1", "--after", "999", "--until", "reviewed"]);

    expect(stdout.mock.calls.map((call) => call[0]).join("")).toBe("");
    expect(stderr.mock.calls.map((call) => call[0]).join("")).toContain("[qa] events exited reason=gap received=0");
  });

  it("doc events 无 follow/until 时按 meta.nextSeq 读完整 backlog", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn(async () =>
      new Response(sseRawStream([
        `event: meta\ndata: ${JSON.stringify({ epoch: 1, minSeq: 3, nextSeq: 5, gap: false })}\n\n`,
        `event: frame\ndata: ${JSON.stringify({ seq: 3, kind: "sessionMeta", data: { title: "a" } })}\n\n`,
        `event: frame\ndata: ${JSON.stringify({ seq: 4, kind: "sessionMeta", data: { title: "b" } })}\n\n`,
      ])),
    ) as typeof fetch;

    await main(["doc", "events", "-s", "s1", "--after", "2"]);

    const out = stdout.mock.calls.map((call) => call[0]).join("");
    expect(out).toContain("\"seq\":3");
    expect(out).toContain("\"seq\":4");
    expect(stderr.mock.calls.map((call) => call[0]).join("")).toContain("[qa] events exited reason=limit received=2");
  });

  it("doc events 连接阶段 timeout 走 reason=timeout", async () => {
    const { main } = await import("../cli.js");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    ) as typeof fetch;

    await main(["doc", "events", "-s", "s1", "--timeout", "10ms"]);

    expect(stderr.mock.calls.map((call) => call[0]).join("").trim()).toBe("[qa] events exited reason=timeout received=0");
  });

  it("doc events 连接拒绝归类为实例不可达", async () => {
    const { main } = await import("../cli.js");
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await expect(main(["doc", "events", "-s", "s1"])).rejects.toMatchObject({
      name: "QaCliError",
      code: "NO_INSTANCE",
      message: "实例不可达: fetch failed",
    });
  });

  it.each([
    [401, "AUTH_FAILED", "unauthorized"],
    [404, "SESSION_NOT_FOUND", "SESSION_NOT_FOUND"],
  ])("doc events HTTP %i 保留服务端错误分类", async (status, code, error) => {
    const { main } = await import("../cli.js");
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error, code, nextStep: "按服务端指引处理" }), { status }),
    ) as typeof fetch;

    await expect(main(["doc", "events", "-s", "s1"])).rejects.toMatchObject({
      name: "QaCliError",
      code,
      message: error,
    });
  });

  it("doc events timeout 到点自退", async () => {
    const { main } = await import("../cli.js");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn(async (_input, init) =>
      new Response(openSseStream(init?.signal)),
    ) as typeof fetch;

    await main(["doc", "events", "-s", "s1", "--timeout", "10ms"]);

    const err = stderr.mock.calls.map((call) => call[0]).join("");
    expect(err).toContain("[qa] watching session=s1 after=0\n");
    expect(err.trim().endsWith("[qa] events exited reason=timeout received=0")).toBe(true);
  });
});

function sseStream(frames: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    },
  });
}

function sseRawStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function openSseStream(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("event: ping\ndata: {}\n\n"));
      signal?.addEventListener("abort", () => {
        controller.error(new DOMException("aborted", "AbortError"));
      });
    },
  });
}

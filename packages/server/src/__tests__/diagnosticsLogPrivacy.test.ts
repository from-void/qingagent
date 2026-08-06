import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { collectLogs } from "../diagnostics/collect";

describe("diagnostics log scope and privacy", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("L1 按完整 console 记录过滤会话并投影多行 messagePreview 原文", async () => {
    const dir = await writeMainLog([
      consoleRecord("2026-08-06T01:00:00.000Z", [
        "runAgentTurn started {",
        "  sessionId: 's-picked',",
        "  messagePreview: '用户消息第一行\\n' +",
        "    \"用户消息第二行 sessionId: 's-fake'\",",
        "  fileCount: 0",
        "}",
      ]),
      consoleRecord("2026-08-06T01:01:00.000Z", [
        "runAgentTurn started {",
        "  sessionId: 's-deleted',",
        "  messagePreview: '已删会话原文',",
        "  fileCount: 0",
        "}",
      ]),
      "[2026-08-06T01:01:30.000Z] [LOG] <-- DELETE /api/v1/sessions/s-deleted",
      "[2026-08-06T01:02:00.000Z] [ERROR] global renderer crash",
    ]);
    dirs.push(dir);

    const logs = await collectLogs(dir, {
      days: 7,
      privacyLevel: "L1",
      sessionIds: ["s-picked"],
    });
    const text = logs.map((file) => file.content).join("\n");

    expect(text).toContain("s-picked");
    expect(text).toContain("global renderer crash");
    expect(text).toContain("messagePreview: '[redacted]'");
    expect(text).not.toContain("用户消息第一行");
    expect(text).not.toContain("用户消息第二行");
    expect(text).not.toContain("s-deleted");
    expect(text).not.toContain("已删会话原文");
  });

  it("L2 只给勾选会话保留 preview，无法归属的 preview 仍投影", async () => {
    const dir = await writeMainLog([
      consoleRecord("2026-08-06T02:00:00.000Z", [
        "runAgentTurn started {",
        "  sessionId: 's-picked',",
        "  messagePreview: '已授权会话原文',",
        "}",
      ]),
      consoleRecord("2026-08-06T02:01:00.000Z", [
        "runAgentTurn started {",
        "  sessionId: 's-deleted',",
        "  messagePreview: '已删会话原文',",
        "}",
      ]),
      consoleRecord("2026-08-06T02:02:00.000Z", [
        "unscoped event {",
        "  textPreview: '无法归属的原文',",
        "}",
      ]),
    ]);
    dirs.push(dir);

    const logs = await collectLogs(dir, {
      days: 7,
      privacyLevel: "L2",
      sessionIds: ["s-picked"],
    });
    const text = logs.map((file) => file.content).join("\n");

    expect(text).toContain("已授权会话原文");
    expect(text).not.toContain("s-deleted");
    expect(text).not.toContain("已删会话原文");
    expect(text).not.toContain("无法归属的原文");
    expect(text).toContain("textPreview: '[redacted]'");
  });

  it("L2 空范围不导出任何会话日志，但保留已投影的全局故障", async () => {
    const dir = await writeMainLog([
      consoleRecord("2026-08-06T02:30:00.000Z", [
        "runAgentTurn started {",
        "  sessionId: 's-deleted',",
        "  messagePreview: '无授权会话原文',",
        "}",
      ]),
      consoleRecord("2026-08-06T02:31:00.000Z", [
        "global failure {",
        "  outputTail: '无法归属的响应原文',",
        "}",
      ]),
    ]);
    dirs.push(dir);

    const logs = await collectLogs(dir, { privacyLevel: "L2", sessionIds: [] });
    const text = logs.map((file) => file.content).join("\n");

    expect(text).not.toContain("s-deleted");
    expect(text).not.toContain("无授权会话原文");
    expect(text).not.toContain("无法归属的响应原文");
    expect(text).toContain("global failure");
    expect(text).toContain("outputTail: '[redacted]'");
  });

  it("L1 处理单行 JSON、转义引号与截断的 preview 字段", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "diag-log-dirty-"));
    dirs.push(dir);
    await writeFile(
      path.join(dir, "server-2026-08-06.log"),
      [
        JSON.stringify({
          ts: "2026-08-06T03:00:00.000Z",
          level: "info",
          message: "selected",
          extra: { sessionId: "s-picked", messagePreview: "带\\转义与\"引号\"的原文" },
        }),
        JSON.stringify({
          ts: "2026-08-06T03:01:00.000Z",
          level: "info",
          message: "deleted",
          extra: { sessionId: "s-deleted", textSnippet: "已删 JSON 原文" },
        }),
        "[2026-08-06T03:02:00.000Z] [WARN] truncated event {",
        "  sessionId: 's-picked',",
        "  outputTail: '缺少收尾的截断原文",
      ].join("\n"),
      "utf8",
    );

    const logs = await collectLogs(dir, {
      privacyLevel: "L1",
      sessionIds: ["s-picked"],
    });
    const text = logs.map((file) => file.content).join("\n");

    expect(text).toContain("s-picked");
    expect(text).toContain("messagePreview");
    expect(text).toContain("outputTail: '[redacted]'");
    expect(text).not.toContain("带\\转义");
    expect(text).not.toContain("已删 JSON 原文");
    expect(text).not.toContain("s-deleted");
    expect(text).not.toContain("缺少收尾的截断原文");
  });

  it("L1 递归投影 JSON 中真正承载正文的 content/text/qingml 字段", async () => {
    const leaks = [
      "LEAK-CONTENT-7QX 完整用户提示词",
      "LEAK-TEXT-7QX 整篇文档正文",
      "LEAK-QINGML-7QX <p>内部文档块</p>",
    ];
    const raw = JSON.stringify({
      ts: "2026-08-06T03:10:00.000Z",
      level: "error",
      message: "structured failure",
      sessionId: "s-picked",
      request: {
        content: leaks[0],
        nested: [{ text: leaks[1] }, { qingml: leaks[2] }],
      },
      requestContext: "保留结构上下文",
      contentHash: "sha256:diagnostic-hash",
      statusCode: 503,
    });
    expect(findKnownLeaks(raw, leaks)).toEqual(leaks);

    const dir = await writeMainLog([raw]);
    dirs.push(dir);
    const logs = await collectLogs(dir, {
      privacyLevel: "L1",
      sessionIds: ["s-picked"],
    });
    const text = logs.map((file) => file.content).join("\n");

    expect(findKnownLeaks(text, leaks)).toEqual([]);
    expect(text).toContain('"content":"[redacted]"');
    expect(text).toContain('"text":"[redacted]"');
    expect(text).toContain('"qingml":"[redacted]"');
    expect(text).toContain('"requestContext":"保留结构上下文"');
    expect(text).toContain('"contentHash":"sha256:diagnostic-hash"');
    expect(text).toContain('"statusCode":503');

    const authorized = await collectLogs(dir, {
      privacyLevel: "L2",
      sessionIds: ["s-picked"],
    });
    expect(findKnownLeaks(authorized.map((file) => file.content).join("\n"), leaks)).toEqual(leaks);
  });

  it("L1 单独收口 util.inspect 的 Upstream LLM API error 对象转储", async () => {
    const leaks = [
      "LEAK-PROMPT-7QX 请写完整报告",
      "LEAK-DOC-7QX 全篇文档块正文",
      "LEAK-ASSISTANT-7QX 联系电话 13912345678",
    ];
    const dump = inspect({
      sessionId: "s-picked",
      error: Object.assign(new Error("provider unavailable"), {
        url: "https://api.example.test/v1/chat/completions",
        statusCode: 503,
        requestBodyValues: {
          messages: [
            { role: "user", content: leaks[0] },
            { role: "tool", content: JSON.stringify({ ok: true, blocks: [{ text: leaks[1] }] }) },
            { role: "assistant", content: leaks[2] },
          ],
        },
      }),
    }, { depth: 6, breakLength: 80 });
    const raw = consoleRecord("2026-08-06T03:20:00.000Z", [
      `Upstream LLM API error ${dump}`,
    ]);
    expect(findKnownLeaks(raw, leaks)).toEqual(leaks);

    const dir = await writeMainLog([raw]);
    dirs.push(dir);
    const logs = await collectLogs(dir, {
      privacyLevel: "L1",
      sessionIds: ["s-picked"],
    });
    const text = logs.map((file) => file.content).join("\n");

    expect(findKnownLeaks(text, leaks)).toEqual([]);
    expect(text).toContain("Upstream LLM API error");
    expect(text).toContain("[content redacted:chars=");

    const authorized = await collectLogs(dir, {
      privacyLevel: "L2",
      sessionIds: ["s-picked"],
    });
    expect(findKnownLeaks(authorized.map((file) => file.content).join("\n"), leaks)).toEqual([]);
  });

  it("L1 对嵌套转义 JSON 的内容字段 fail-closed，不在 [redacted] 后留下尾巴", async () => {
    const leaks = [
      "LEAK-PREVIEW-HEAD-7QX 前半段",
      "LEAK-PREVIEW-TAIL-7QX 人工巡检后的正文尾巴",
    ];
    const nestedJson = JSON.stringify({
      revisionCount: 2,
      previewExcerpt: `${leaks[0]} \\"${leaks[1]}\\"`,
      lengthStatus: "accepted_first_pass",
    });
    const raw = consoleRecord("2026-08-06T03:30:00.000Z", [
      "nested result {",
      "  sessionId: 's-picked',",
      `  data: ${inspect(nestedJson)},`,
      "}",
    ]);
    expect(findKnownLeaks(raw, leaks)).toEqual(leaks);

    const dir = await writeMainLog([raw]);
    dirs.push(dir);
    const logs = await collectLogs(dir, {
      privacyLevel: "L1",
      sessionIds: ["s-picked"],
    });
    const text = logs.map((file) => file.content).join("\n");

    expect(findKnownLeaks(text, leaks)).toEqual([]);
    expect(text).toContain("nested result");
    expect(text).toContain("[content redacted:chars=");
  });

  it("L1 不把 requestContext 中的 text 子串误判为正文键", async () => {
    const raw = consoleRecord("2026-08-06T03:40:00.000Z", [
      "ordinary diagnostic {",
      "  sessionId: 's-picked',",
      "  requestContext: '保留模型请求阶段',",
      "  statusCode: 503,",
      "}",
    ]);
    const dir = await writeMainLog([raw]);
    dirs.push(dir);

    const logs = await collectLogs(dir, {
      privacyLevel: "L1",
      sessionIds: ["s-picked"],
    });
    const text = logs.map((file) => file.content).join("\n");

    expect(text).toContain("requestContext: '保留模型请求阶段'");
    expect(text).toContain("statusCode: 503");
    expect(text).not.toContain("[content redacted:chars=");
  });
});

function findKnownLeaks(text: string, leaks: string[]): string[] {
  return leaks.filter((leak) => text.includes(leak));
}

function consoleRecord(at: string, lines: string[]): string {
  const [first, ...rest] = lines;
  return [`[${at}] [INFO] ${first}`, ...rest].join("\n");
}

async function writeMainLog(records: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "diag-log-privacy-"));
  await writeFile(
    path.join(dir, "main-2026-08-06.log"),
    `${records.join("\n")}\n`,
    "utf8",
  );
  return dir;
}

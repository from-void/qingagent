import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
});

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

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

  it("sessions list 有后续页时提示使用 --all", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn(async (input) => {
      expect(String(input)).toBe("http://127.0.0.1:45678/api/v1/external/sessions?limit=2");
      return new Response(JSON.stringify({
        sessions: [
          { id: "s1", title: "会话一", state: "empty", updatedAt: "2026-07-25T00:00:00.000Z" },
          { id: "s2", title: "会话二", state: "editing", updatedAt: "2026-07-24T00:00:00.000Z" },
        ],
        total: 5,
        hasMore: true,
      }));
    }) as typeof fetch;

    await main(["sessions", "list", "--limit", "2"]);

    const rendered = stdout.mock.calls.map((call) => call[0]).join("");
    expect(rendered).toContain("\"total\": 5");
    expect(rendered.endsWith("还有 3 个会话,用 --all 查看\n")).toBe(true);
  });

  it("template pull/push 保留乐观锁元数据并回写新 updatedAt", async () => {
    const { main } = await import("../cli.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "qa-cli-template-"));
    dirs.push(dir);
    const filePath = path.join(dir, "legal.md");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const first = {
      id: "review-custom-1",
      type: "custom",
      name: "法务口径审查",
      prompt: "第一版规则",
      builtin: false,
      selected: false,
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:01.000Z",
    };
    let phase = "pull";
    globalThis.fetch = vi.fn(async (input, init) => {
      if (phase === "pull") {
        expect(String(input)).toMatch(/\/review-templates\/review-custom-1$/);
        return new Response(JSON.stringify({ template: first }));
      }
      expect(init?.method).toBe("PUT");
      expect(String(input)).toMatch(/\/review-templates\/review-custom-1$/);
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        name: "法务口径审查",
        prompt: "第二版规则",
        expectedUpdatedAt: first.updatedAt,
      });
      expect(new Headers(init?.headers).get("X-QA-Client")).toBeTruthy();
      return new Response(JSON.stringify({
        template: {
          ...first,
          prompt: "第二版规则",
          updatedAt: "2026-07-27T00:00:02.000Z",
        },
      }));
    }) as typeof fetch;

    await main(["template", "pull", first.id, "--out", filePath]);
    expect(await readFile(filePath, "utf8")).toContain(`updatedAt: '${first.updatedAt}'`);
    await writeFile(
      filePath,
      (await readFile(filePath, "utf8")).replace("第一版规则", "第二版规则"),
      "utf8",
    );
    phase = "push";
    await main(["template", "push", filePath]);
    expect(await readFile(filePath, "utf8"))
      .toContain("updatedAt: '2026-07-27T00:00:02.000Z'");
    expect(stdout.mock.calls.map((call) => call[0]).join("")).not.toContain("secret-token");
  });

  it("template create/select/rm 使用 external 模板端点", async () => {
    const { main } = await import("../cli.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "qa-cli-template-create-"));
    dirs.push(dir);
    const promptPath = path.join(dir, "prompt.md");
    await writeFile(promptPath, "逐条检查法律风险", "utf8");
    const requests: Array<{ url: string; method: string }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (url.endsWith("/review-templates") && method === "POST") {
        return new Response(JSON.stringify({
          template: {
            id: "review-custom-new",
            type: "custom",
            name: "法务",
            prompt: "逐条检查法律风险",
            builtin: false,
            selected: false,
            createdAt: "now",
            updatedAt: "now",
          },
        }));
      }
      if (url.endsWith("/select")) {
        return new Response(JSON.stringify({
          selected: true,
          id: "review-custom-new",
          type: "custom",
        }));
      }
      return new Response(JSON.stringify({ deleted: true, id: "review-custom-new" }));
    }) as typeof fetch;

    await main(["template", "create", "--type", "custom", "--name", "法务", "--file", promptPath]);
    await main(["template", "select", "review-custom-new"]);
    await main(["template", "rm", "review-custom-new"]);
    expect(requests.map(({ url, method }) => `${method} ${new URL(url).pathname}`)).toEqual([
      "POST /api/v1/external/review-templates",
      "POST /api/v1/external/review-templates/review-custom-new/select",
      "DELETE /api/v1/external/review-templates/review-custom-new",
    ]);
  });

  it("review run --wait 忽略 editing 中间态，批注进入 review list 后才返回", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let reviewReads = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/sessions/s1/review/run")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          type: "custom",
          templateId: "legal",
          supplement: "只看合同",
        });
        return new Response(JSON.stringify({
          queued: true,
          note: "已入队,执行结果以 events 为准",
          type: "custom",
          templateId: "legal",
          afterSeq: 12,
        }));
      }
      if (url.includes("/sessions/s1/events?after=12")) {
        return new Response(sseStream([
          { seq: 13, kind: "stream", data: { kind: "start", data: { streamId: "run-1" } } },
          {
            seq: 14,
            kind: "docStateChanged",
            data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: true },
          },
          {
            seq: 15,
            kind: "docStateChanged",
            data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: false },
          },
          {
            seq: 16,
            kind: "annotationGroupsReady",
            data: {
              groups: [{
                id: "annotation-new",
                summary: "合同风险",
                note: "需补充责任边界",
                origin: "review:custom",
                status: "reviewing",
                anchors: [],
              }],
            },
          },
        ]));
      }
      expect(url).toContain("/sessions/s1/review");
      reviewReads += 1;
      return new Response(JSON.stringify({
        sessionId: "s1",
        docVersion: 3,
        state: "editing",
        agentBusy: false,
        patches: [],
        annotations: reviewReads === 1
          ? []
          : [{
            id: "annotation-new",
            summary: "合同风险",
            note: "需补充责任边界",
            origin: "review:custom",
            status: "reviewing",
            anchors: [],
          }],
      }));
    }) as typeof fetch;

    await main([
      "review", "run", "-s", "s1", "--type", "custom",
      "--template", "legal", "--supplement", "只看合同", "--wait",
    ]);

    expect(reviewReads).toBe(2);
    expect(stdout.mock.calls.map((call) => call[0]).join(""))
      .toContain('"kind":"annotationGroupsReady"');
    expect(stderr.mock.calls.map((call) => call[0]).join("")).toContain(
      "[qa] events exited reason=review-run-complete",
    );
  });

  it("review run --wait 无批注时等待本轮 stream end 并对账 review list", async () => {
    const { main } = await import("../cli.js");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let reviewReads = 0;
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/sessions/s1/review/run")) {
        return new Response(JSON.stringify({
          queued: true,
          note: "已入队,执行结果以 events 为准",
          type: "source",
          templateId: "source-default",
          afterSeq: 20,
        }));
      }
      if (url.includes("/sessions/s1/events?after=20")) {
        return new Response(sseStream([
          { seq: 21, kind: "stream", data: { kind: "start", data: { streamId: "run-2" } } },
          {
            seq: 22,
            kind: "docStateChanged",
            data: { state: { kind: "editing" }, activeOverlay: null, agentBusy: true },
          },
          {
            seq: 23,
            kind: "stream",
            data: { kind: "end", data: { streamId: "run-2", reason: { kind: "done" } } },
          },
        ]));
      }
      reviewReads += 1;
      return new Response(JSON.stringify({
        sessionId: "s1",
        docVersion: 3,
        state: "editing",
        agentBusy: false,
        patches: [],
        annotations: [],
      }));
    }) as typeof fetch;

    await main(["review", "run", "-s", "s1", "--type", "source", "--wait"]);

    expect(reviewReads).toBe(1);
    expect(stderr.mock.calls.map((call) => call[0]).join(""))
      .toContain("[qa] events exited reason=review-run-complete");
  });

  it("skills validate 不联网，install/update 先验证本地目录再发送 files", async () => {
    const { main } = await import("../cli.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "qa-cli-skill-dir-"));
    dirs.push(dir);
    await mkdir(path.join(dir, "child"));
    await writeFile(
      path.join(dir, "SKILL.md"),
      "---\nname: legal-review\ndescription: 法务审查\n---\n# 根技能\n",
    );
    await writeFile(
      path.join(dir, "child", "SKILL.md"),
      "---\nname: contract-check\ndescription: 合同核对\n---\n# 子技能\n",
    );
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    await main(["skills", "validate", dir, "--json"]);
    expect(fetchMock).not.toHaveBeenCalled();

    globalThis.fetch = vi.fn(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        files: Array<{ path: string; content: string }>;
      };
      expect(body.files.map((file) => file.path)).toEqual([
        "child/SKILL.md",
        "SKILL.md",
      ]);
      if (init?.method === "PUT") {
        expect(String(input)).toMatch(/\/skills\/legal-review$/);
        return new Response(JSON.stringify({ updated: true, name: "legal-review" }));
      }
      expect(String(input)).toMatch(/\/external\/skills$/);
      return new Response(JSON.stringify({ installed: true, name: "legal-review" }));
    }) as typeof fetch;
    await main(["skills", "install", dir]);
    await main(["skills", "update", "legal-review", dir]);
  });

  it("skills list/show/rm/enable/disable 命令路径与响应口径一致", async () => {
    const { main } = await import("../cli.js");
    const requested: string[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
      requested.push(key);
      if (url.endsWith("/skills")) return new Response(JSON.stringify({ skills: [] }));
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({
          skill: {
            name: "demo",
            description: "演示",
            source: "installed",
            userInvocable: true,
            enabled: true,
            body: "# demo",
            children: [],
          },
        }));
      }
      return new Response(JSON.stringify({ name: "demo", enabled: true, deleted: true }));
    }) as typeof fetch;
    await main(["skills", "list"]);
    await main(["skills", "show", "demo"]);
    await main(["skills", "enable", "demo"]);
    await main(["skills", "disable", "demo"]);
    await main(["skills", "rm", "demo"]);
    expect(requested).toEqual([
      "GET /api/v1/external/skills",
      "GET /api/v1/external/skills/demo",
      "POST /api/v1/external/skills/demo/enable",
      "POST /api/v1/external/skills/demo/disable",
      "DELETE /api/v1/external/skills/demo",
    ]);
  });

  it("sessions list --all 自动翻页并输出全量 JSON 元信息", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const requestedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith("?limit=2&offset=0")) {
        return new Response(JSON.stringify({
          sessions: [
            { id: "s1", title: "会话一", state: "empty", updatedAt: "2026-07-25T00:00:00.000Z" },
            { id: "s2", title: "会话二", state: "editing", updatedAt: "2026-07-24T00:00:00.000Z" },
          ],
          total: 3,
          hasMore: true,
        }));
      }
      expect(url.endsWith("?limit=2&offset=2")).toBe(true);
      return new Response(JSON.stringify({
        sessions: [
          { id: "s3", title: "会话三", state: "pendingReview", updatedAt: "2026-07-23T00:00:00.000Z" },
        ],
        total: 3,
        hasMore: false,
      }));
    }) as typeof fetch;

    await main(["sessions", "list", "--all", "--limit", "2", "--json"]);

    expect(requestedUrls).toEqual([
      "http://127.0.0.1:45678/api/v1/external/sessions?limit=2&offset=0",
      "http://127.0.0.1:45678/api/v1/external/sessions?limit=2&offset=2",
    ]);
    expect(JSON.parse(stdout.mock.calls.map((call) => call[0]).join(""))).toMatchObject({
      sessions: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
      total: 3,
      hasMore: false,
    });
  });

  it.each([
    ["后续 flag", [
      "doc", "propose", "-s", "s1", "--expect-version", "3",
      "--str-replace", "旧文", "--json",
    ]],
    ["下一个多值选项", [
      "doc", "propose", "-s", "s1", "--expect-version", "3",
      "--str-replace", "旧文", "--str-replace", "另一处旧文", "另一处新文",
    ]],
    ["参数结尾", [
      "doc", "propose", "-s", "s1", "--expect-version", "3",
      "--str-replace", "旧文",
    ]],
  ])("doc propose --str-replace 缺值时不把%s当替换文本", async (_label, args) => {
    const { main } = await import("../cli.js");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "proposed" })));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(main(args)).rejects.toMatchObject({
      code: "VALIDATION",
      message: "--str-replace 需要旧文和新文",
    });
    expect(fetchMock).not.toHaveBeenCalled();
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

  it.each(["abc", "0", "-1", "1.5"])(
    "chat log --limit %s 在发请求前报错",
    async (limit) => {
      const { main } = await import("../cli.js");
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as typeof fetch;

      await expect(
        main(["chat", "log", "-s", "s1", "--limit", limit]),
      ).rejects.toThrow("--limit 必须是正整数");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

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

  it("review list 打印修改 diff 摘要、冲突和批注", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn(async (input) => {
      expect(String(input)).toBe(
        "http://127.0.0.1:45678/api/v1/external/sessions/s1/review",
      );
      return new Response(JSON.stringify({
        sessionId: "s1",
        docVersion: 3,
        state: "pendingReview",
        agentBusy: false,
        patches: [{
          id: "patch-1",
          reviewBatchId: "batch-1",
          groupMode: "independent",
          status: "conflict",
          baseVersion: 3,
          summary: "替换口径",
          beforeText: "旧口径",
          afterText: "新口径",
          conflict: { kind: "target_text_changed", message: "正文已变化" },
        }],
        annotations: [{
          id: "annotation-1",
          summary: "核对数字",
          note: "与材料不一致",
          origin: "source-check",
          severity: "error",
          status: "reviewing",
          anchors: [],
        }],
      }));
    }) as typeof fetch;

    await main(["review", "list", "-s", "s1"]);

    const rendered = stdout.mock.calls.map((call) => call[0]).join("");
    expect(rendered).toContain("审查 session=s1 v3 state=pendingReview");
    expect(rendered).toContain("- patch-1  [conflict] 替换口径");
    expect(rendered).toContain("旧口径 → 新口径");
    expect(rendered).toContain("冲突: target_text_changed 正文已变化");
    expect(rendered).toContain("- annotation-1  [error/reviewing] 核对数字");
  });

  it("review show --patch 请求详情并打印完整 diff", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn(async (input) => {
      expect(String(input)).toBe(
        "http://127.0.0.1:45678/api/v1/external/sessions/s1/review/patches/patch%2F1",
      );
      return new Response(JSON.stringify({
        sessionId: "s1",
        patch: {
          id: "patch/1",
          reviewBatchId: "batch-1",
          groupMode: "independent",
          status: "reviewing",
          baseVersion: 3,
          summary: "替换口径",
          beforeText: "完整旧文",
          afterText: "完整新文",
          conflict: null,
          anchor: {
            blockId: "block-1",
            pmFrom: 1,
            pmTo: 5,
            quote: "完整旧文",
          },
          diff: {
            op: "replace",
            blockPath: [0, 1],
            summary: "替换口径",
            beforeText: "完整旧文",
            afterText: "完整新文",
            anchor: {},
          },
        },
      }));
    }) as typeof fetch;

    await main(["review", "show", "-s", "s1", "--patch", "patch/1"]);

    const rendered = stdout.mock.calls.map((call) => call[0]).join("");
    expect(rendered).toContain("修改建议 patch/1 [reviewing]");
    expect(rendered).toContain("原文:\n完整旧文");
    expect(rendered).toContain("改为:\n完整新文");
    expect(rendered).toContain("diff: replace blockPath=0.1");
  });

  it("review accept --patch 发送版本保护的逐条裁决", async () => {
    const { main } = await import("../cli.js");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe(
        "http://127.0.0.1:45678/api/v1/external/sessions/s1/review/verdicts",
      );
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        expectedDocVersion: 3,
        patchId: "patch-1",
        verdict: "accepted",
      });
      return new Response(JSON.stringify({
        status: "marked",
        docVersion: 3,
        patchIds: ["patch-1"],
        verdict: "accepted",
        reviewingCount: 1,
        seq: 9,
      }));
    }) as typeof fetch;

    await main([
      "review",
      "accept",
      "-s",
      "s1",
      "--expect-version",
      "3",
      "--patch",
      "patch-1",
      "--json",
    ]);
  });

  it.each([
    ["accept", "accept_all"],
    ["reject", "reject_all"],
    ["commit", "commit"],
  ] as const)("review %s 全量动作调用 commit action=%s", async (command, action) => {
    const { main } = await import("../cli.js");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe(
        "http://127.0.0.1:45678/api/v1/external/sessions/s1/review/commit",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        expectedDocVersion: 3,
        action,
      });
      return new Response(JSON.stringify({
        status: "reviewed",
        docVersion: action === "reject_all" ? 3 : 4,
        acceptedCount: action === "reject_all" ? 0 : 2,
        rejectedCount: action === "reject_all" ? 2 : 0,
        remainingCount: 0,
        outcomeQueued: action === "reject_all",
        outcome: { acceptedCount: 0, rejectedCount: 0, hunks: [] },
        seq: 10,
      }));
    }) as typeof fetch;

    await main([
      "review",
      command,
      "-s",
      "s1",
      "--expect-version",
      "3",
      ...(command === "commit" ? [] : ["--all"]),
      "--json",
    ]);
  });

  it("review annotation ignore 透传 remember 与版本", async () => {
    const { main } = await import("../cli.js");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe(
        "http://127.0.0.1:45678/api/v1/external/sessions/s1/review/annotations/ignore",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        expectedDocVersion: 3,
        annotationIds: ["annotation-1"],
        rememberDismissal: true,
      });
      return new Response(JSON.stringify({
        status: "ignored",
        annotationIds: ["annotation-1"],
        remainingAnnotationCount: 0,
        seq: 11,
      }));
    }) as typeof fetch;

    await main([
      "review",
      "annotation",
      "ignore",
      "-s",
      "s1",
      "--expect-version",
      "3",
      "--annotation",
      "annotation-1",
      "--remember",
      "--json",
    ]);
  });

  it("review 命令拒绝歧义目标和非法版本", async () => {
    const { main } = await import("../cli.js");

    await expect(
      main([
        "review",
        "accept",
        "-s",
        "s1",
        "--expect-version",
        "3",
        "--patch",
        "p1",
        "--all",
      ]),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      main([
        "review",
        "commit",
        "-s",
        "s1",
        "--expect-version",
        "-1",
      ]),
    ).rejects.toMatchObject({ code: "VALIDATION" });
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

  it.each([
    ["非法目标", ["doc", "events", "-s", "s1", "--until", "reviewd"]],
    ["缺少目标值", ["doc", "events", "-s", "s1", "--until"]],
    ["后续 flag 不能充当目标值", [
      "doc", "events", "-s", "s1", "--until", "--timeout", "10ms",
    ]],
  ])("doc events --until %s 时在连接前拒绝", async (_label, args) => {
    const { main } = await import("../cli.js");
    const fetchMock = vi.fn(async () => new Response());
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(main(args)).rejects.toMatchObject({
      code: "VALIDATION",
      message: "--until 必须是 reviewed、committed 或 review",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("doc events 非 follow 在目标命中前 EOF 时明确失败", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    globalThis.fetch = vi.fn(async () =>
      new Response(sseRawStream([
        `event: meta\ndata: ${JSON.stringify({ epoch: 1, minSeq: 42, nextSeq: 43, gap: false })}\n\n`,
        `event: frame\ndata: ${JSON.stringify({ seq: 42, kind: "sessionMeta", data: { title: "未裁决" } })}\n\n`,
      ])),
    ) as typeof fetch;

    await expect(
      main(["doc", "events", "-s", "s1", "--after", "41", "--until", "reviewed"]),
    ).rejects.toMatchObject({
      code: "EVENT_TARGET_NOT_REACHED",
      message: "事件流提前结束，目标 reviewed 尚未到达",
    });

    expect(stdout.mock.calls.map((call) => call[0]).join("")).toContain("\"seq\":42");
    expect(stderr.mock.calls.map((call) => call[0]).join(""))
      .toContain("[qa] events exited reason=eof received=1");
  });

  it("doc events --follow 遇 EOF 后用最后 seq 自动重连补拉", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let call = 0;
    globalThis.fetch = vi.fn(async (input) => {
      call += 1;
      if (call === 1) {
        expect(String(input)).toContain("/events?after=4");
        return new Response(sseStream([
          { seq: 5, kind: "sessionMeta", data: { sessionId: "s1", title: "续传前" } },
        ]));
      }
      expect(String(input)).toContain("/events?after=5");
      return new Response(sseStream([
        { seq: 6, kind: "docCommitted", data: { version: 2 } },
      ]));
    }) as typeof fetch;

    await main([
      "doc", "events", "-s", "s1", "--after", "4",
      "--follow", "--until", "reviewed", "--timeout", "2s",
    ]);

    const output = stdout.mock.calls.map((entry) => entry[0]).join("");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(output).toContain("\"seq\":5");
    expect(output).toContain("\"seq\":6");
    expect(stderr.mock.calls.map((entry) => entry[0]).join(""))
      .toContain("[qa] events exited reason=reviewed received=2");
  });

  it("doc events --follow 检测到 epoch 变化后从新日志起点续传", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const requestedUrls: string[] = [];
    let call = 0;
    globalThis.fetch = vi.fn(async (input) => {
      call += 1;
      requestedUrls.push(String(input));
      if (call === 1) {
        return new Response(sseRawStream([
          `event: meta\ndata: ${JSON.stringify({ epoch: 1, minSeq: 100, nextSeq: 101, gap: false })}\n\n`,
          `event: frame\ndata: ${JSON.stringify({ seq: 100, kind: "sessionMeta", data: { title: "旧日志" } })}\n\n`,
        ]));
      }
      if (call === 2) {
        return new Response(sseRawStream([
          `event: meta\ndata: ${JSON.stringify({ epoch: 2, minSeq: 1, nextSeq: 102, gap: false })}\n\n`,
          `event: frame\ndata: ${JSON.stringify({ seq: 101, kind: "sessionMeta", data: { title: "追平旧游标" } })}\n\n`,
        ]));
      }
      return new Response(sseRawStream([
        `event: meta\ndata: ${JSON.stringify({ epoch: 2, minSeq: 1, nextSeq: 102, gap: false })}\n\n`,
        `event: frame\ndata: ${JSON.stringify({ seq: 1, kind: "docCommitted", data: { version: 2 } })}\n\n`,
      ]));
    }) as typeof fetch;

    await main([
      "doc", "events", "-s", "s1", "--after", "99",
      "--follow", "--until", "reviewed", "--timeout", "2s",
    ]);

    expect(requestedUrls).toEqual([
      "http://127.0.0.1:45678/api/v1/external/sessions/s1/events?after=99",
      "http://127.0.0.1:45678/api/v1/external/sessions/s1/events?after=100",
      "http://127.0.0.1:45678/api/v1/external/sessions/s1/events?after=0",
    ]);
    const output = stdout.mock.calls.map((entry) => entry[0]).join("");
    expect(output).toContain("\"seq\":1");
    expect(output).not.toContain("\"seq\":101");
    expect(stderr.mock.calls.map((entry) => entry[0]).join(""))
      .toContain("[qa] log rebuilt, resuming from seq=1");
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

  it("doc events 首次收到 gap 且尚无事件时从 minSeq 自动重订", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let requestCount = 0;
    globalThis.fetch = vi.fn(async (input) => {
      requestCount += 1;
      if (requestCount === 1) {
        expect(String(input)).toBe("http://127.0.0.1:45678/api/v1/external/sessions/s1/events?after=0");
        return new Response(sseRawStream([
          `event: meta\ndata: ${JSON.stringify({ epoch: 1, minSeq: 41, nextSeq: 43, gap: true })}\n\n`,
        ]));
      }
      expect(String(input)).toBe("http://127.0.0.1:45678/api/v1/external/sessions/s1/events?after=40");
      return new Response(sseRawStream([
        `event: meta\ndata: ${JSON.stringify({ epoch: 1, minSeq: 41, nextSeq: 43, gap: false })}\n\n`,
        `event: frame\ndata: ${JSON.stringify({ seq: 41, kind: "docCommitted", data: { version: 2 } })}\n\n`,
      ]));
    }) as typeof fetch;

    await main(["doc", "events", "-s", "s1", "--after", "0", "--until", "reviewed"]);

    expect(requestCount).toBe(2);
    expect(stdout.mock.calls.map((call) => call[0]).join("")).toContain("\"seq\":41");
    const err = stderr.mock.calls.map((call) => call[0]).join("");
    expect(err).toContain("[qa] log truncated, resuming from seq=41\n");
    expect(err).toContain("[qa] watching session=s1 after=40\n");
    expect(err).not.toContain("events exited reason=gap");
  });

  it("doc events 自动重订后再次收到 gap 时以 reason=gap 退出且不输出 meta", async () => {
    const { main } = await import("../cli.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchMock = vi.fn(async () => new Response(sseRawStream([
      `event: meta\ndata: ${JSON.stringify({ epoch: 1, minSeq: 1, nextSeq: 1, gap: true })}\n\n`,
    ])));
    globalThis.fetch = fetchMock as typeof fetch;

    await main(["doc", "events", "-s", "s1", "--after", "999", "--until", "reviewed"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stdout.mock.calls.map((call) => call[0]).join("")).toBe("");
    expect(stderr.mock.calls.map((call) => call[0]).join("")).toContain("[qa] log truncated, resuming from seq=1");
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

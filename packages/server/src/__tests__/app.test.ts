import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as core from "@qingagent/core";
import { getMemory, QINGAGENT_RESOURCE_ID } from "@qingagent/core";
import { app } from "../app";
import {
  publicStreamErrorReason,
  redactStreamErrorForLog,
} from "../routes/stream";
import {
  publicAskMoreErrorMessage,
  redactAskMoreErrorForLog,
} from "../routes/askMore";

// Helper: perform a request against the Hono app without starting a real server.
async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

async function readSseUntil(
  res: Response,
  controller: AbortController,
  needle: string,
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("SSE response has no body");
  const decoder = new TextDecoder();
  let body = "";
  const deadline = Date.now() + 2_000;
  while (!body.includes(needle)) {
    if (Date.now() > deadline) {
      controller.abort();
      throw new Error(`Timed out waiting for SSE fragment: ${needle}`);
    }
    const next = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
        setTimeout(() => resolve({ done: false, value: new Uint8Array() }), 50);
      }),
    ]);
    if (next.done) break;
    if (next.value.length > 0) {
      body += decoder.decode(next.value, { stream: true });
    }
  }
  controller.abort();
  await reader.cancel().catch(() => undefined);
  return body;
}

// -----------------------------------------------------------------------
// Health
// -----------------------------------------------------------------------
describe("GET /health", () => {
  it("返回服务状态与浏览器/PDF 能力状态", async () => {
    const res = await request("GET", "/health");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      status: "ok",
      capabilities: {
        browser: {
          status: expect.stringMatching(/^(unknown|available|unavailable)$/),
          sandbox: expect.stringMatching(/^(required|disabled-by-explicit-override)$/),
          reason: null,
        },
        pdfExport: {
          enabled: true,
          renderer: "playwright",
        },
      },
    });
  });
});

describe("CORS 安全默认值", () => {
  const savedTrustedOrigins = process.env.QINGAGENT_TRUSTED_ORIGINS;

  afterAll(() => {
    if (savedTrustedOrigins === undefined) delete process.env.QINGAGENT_TRUSTED_ORIGINS;
    else process.env.QINGAGENT_TRUSTED_ORIGINS = savedTrustedOrigins;
  });

  it("不受信 Origin 不回显 Access-Control-Allow-Origin", async () => {
    const res = await app.request("/api/v1/capabilities", {
      headers: { Origin: "https://evil.test" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("localhost 与 QINGAGENT_TRUSTED_ORIGINS 共享 trustedOrigin 判定并允许带凭据", async () => {
    const localhost = await app.request("/api/v1/capabilities", {
      headers: { Origin: "http://localhost:6173" },
    });
    expect(localhost.headers.get("access-control-allow-origin")).toBe("http://localhost:6173");
    expect(localhost.headers.get("access-control-allow-credentials")).toBe("true");

    process.env.QINGAGENT_TRUSTED_ORIGINS = "https://trusted.example";
    const trusted = await app.request("/api/v1/capabilities", {
      headers: { Origin: "https://trusted.example" },
    });
    expect(trusted.headers.get("access-control-allow-origin")).toBe("https://trusted.example");
    expect(trusted.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("畸形 Origin 不崩溃且不放行 CORS 读取", async () => {
    const res = await app.request("/api/v1/capabilities", {
      headers: { Origin: "http://[" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("GET /api/v1/capabilities", () => {
  const savedRuntime = process.env.QINGAGENT_RUNTIME;
  const savedLocal = process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
  const savedBrowser = process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES;
  const savedMutation = process.env.QINGAGENT_ALLOW_SKILL_MUTATION;

  afterAll(() => {
    if (savedRuntime === undefined) delete process.env.QINGAGENT_RUNTIME;
    else process.env.QINGAGENT_RUNTIME = savedRuntime;
    if (savedLocal === undefined) delete process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
    else process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = savedLocal;
    if (savedBrowser === undefined) delete process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES;
    else process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = savedBrowser;
    if (savedMutation === undefined) delete process.env.QINGAGENT_ALLOW_SKILL_MUTATION;
    else process.env.QINGAGENT_ALLOW_SKILL_MUTATION = savedMutation;
  });

  it("宣告 skills.mutationEnabled——默认关闭,仅 QINGAGENT_ALLOW_SKILL_MUTATION=1 时开启", async () => {
    delete process.env.QINGAGENT_ALLOW_SKILL_MUTATION;
    await expect((await request("GET", "/api/v1/capabilities")).json()).resolves.toMatchObject({
      skills: { mutationEnabled: false },
    });

    process.env.QINGAGENT_ALLOW_SKILL_MUTATION = "1";
    await expect((await request("GET", "/api/v1/capabilities")).json()).resolves.toMatchObject({
      skills: { mutationEnabled: true },
    });

    process.env.QINGAGENT_ALLOW_SKILL_MUTATION = "0";
    await expect((await request("GET", "/api/v1/capabilities")).json()).resolves.toMatchObject({
      skills: { mutationEnabled: false },
    });
  });

  it("默认不宣称本地/浏览器文件夹能力开启", async () => {
    delete process.env.QINGAGENT_RUNTIME;
    delete process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
    delete process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES;

    const res = await request("GET", "/api/v1/capabilities");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      folderSources: {
        desktopLocal: { enabled: false },
        browserFsAccess: { enabled: false },
      },
    });
  });

  it("只读反映 server folder source 开关，不改默认值", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";

    const res = await request("GET", "/api/v1/capabilities");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      folderSources: {
        desktopLocal: { enabled: true },
        browserFsAccess: { enabled: true },
      },
    });
  });
});

// -----------------------------------------------------------------------
// Home
// -----------------------------------------------------------------------
describe("GET /api/v1/home", () => {
  // 干净环境（CI）下线程存储为空，home feed 会返回空数组。
  // 这里先种一条确定的 session，让用例自给自足、不依赖本地遗留数据。
  const SEED_THREAD_ID = "home-feed-test-seed";

  beforeAll(async () => {
    await getMemory().saveThread({
      thread: {
        id: SEED_THREAD_ID,
        title: "测试草稿",
        resourceId: QINGAGENT_RESOURCE_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {
          title: "测试草稿",
          legacySections: [
            { kind: "p", data: { text: "这是正文开头，用来确认首页卡片副标题优先显示文档内容。" } },
          ],
          threadSummary: {
            sectionCount: 1,
            wordCount: 20,
            status: "init",
            materialCount: 0,
          },
        },
      },
    });
  });

  afterAll(async () => {
    await getMemory().deleteThread(SEED_THREAD_ID);
  });

  it("returns 200 with valid HomeFeed shape", async () => {
    const res = await request("GET", "/api/v1/home");
    expect(res.status).toBe(200);
    const json = await res.json();

    // HomeFeed has recent_sessions and pinned_docs
    expect(Array.isArray(json.recent_sessions)).toBe(true);
    expect(json.recent_sessions.length).toBeGreaterThan(0);
    expect(Array.isArray(json.pinned_docs)).toBe(true);

    // Each SessionMeta has the required fields
    const session = json.recent_sessions[0];
    expect(session).toHaveProperty("id");
    expect(session).toHaveProperty("title");
    expect(session).toHaveProperty("created_at");
    expect(session).toHaveProperty("summary");
    expect(session).toHaveProperty("status");
    expect(session.status).toEqual({ kind: "Active" });

    const seeded = json.recent_sessions.find(
      (item: { id: string }) => item.id === SEED_THREAD_ID,
    );
    expect(seeded?.summary).toBe("这是正文开头，用来确认首页卡片副标题优先显示文档内容。");

    // pinned_docs is currently allowed to be empty until pinning is implemented.
    for (const doc of json.pinned_docs as Array<{ id: string; title: string; updated_at: string }>) {
      expect(doc).toHaveProperty("id");
      expect(doc).toHaveProperty("title");
      expect(doc).toHaveProperty("updated_at");
    }
  });
});

// -----------------------------------------------------------------------
// Skills
// -----------------------------------------------------------------------
describe("GET /api/v1/skills", () => {
  it("returns built-in skills enabled by default", async () => {
    const readDisabledSet = vi.spyOn(core, "readDisabledSet").mockResolvedValue(new Set());
    const res = await request("GET", "/api/v1/skills");
    readDisabledSet.mockRestore();
    expect(res.status).toBe(200);
    const json = await res.json() as {
      skills: Array<{
        name: string;
        source: string;
        enabled: boolean;
        label?: string;
        summary?: string;
        icon?: string;
        userInvocable?: boolean;
        config?: string;
        tools?: string[];
        children: Array<{
          name: string;
          label: string;
          summary: string;
          description: string;
          icon: string;
          children: unknown[];
        }>;
      }>;
    };

    const byName = new Map(json.skills.map((skill) => [skill.name, skill]));
    for (const name of ["browser-ops", "web-search", "image-gen", "diagram-viz", "materials"]) {
      expect(byName.get(name)).toMatchObject({
        source: "builtin",
        enabled: true,
      });
    }
    expect(byName.get("diagram-viz")).toMatchObject({
      label: "图表可视化",
      summary: "判断是否画图并生成美观、可编辑的 Mermaid 或 draw.io 图表",
      icon: "diagram",
      userInvocable: true,
    });
    expect(byName.get("diagram-viz")?.children).toHaveLength(2);
    expect(byName.get("diagram-viz")?.children.map((skill) => skill.name)).toEqual([
      "drawio",
      "mermaid",
    ]);
    expect(byName.get("image-gen")).toMatchObject({
      label: "画配图",
      userInvocable: true,
      tools: ["generateSvg", "prepareImageEditSource", "importGeneratedImage"],
    });
    expect(byName.get("image-gen")?.children).toHaveLength(2);
    expect(byName.get("image-gen")?.children.map((skill) => skill.name)).toEqual([
      "codex-image",
      "svg",
    ]);
    expect(byName.get("web-search")).toMatchObject({
      label: "联网搜",
      summary: "搜资料、核事实、找出处",
      icon: "search",
      userInvocable: true,
      config: "search-provider",
      tools: ["webSearch", "fetchArticle"],
    });
    expect(byName.get("materials")).toMatchObject({
      label: "读资料",
      summary: "读取上传文件与资料库并引用",
      userInvocable: false,
      tools: ["readDocument", "searchDocuments"],
    });
    expect(byName.get("cli-auth")).toMatchObject({
      label: "命令行授权",
      summary: "安全处理阻塞等待扫码或网页授权的 CLI",
      userInvocable: false,
    });
    expect(byName.get("review")).toMatchObject({
      label: "文档审查",
      summary: "统一执行八类文档审查",
      icon: "search",
      userInvocable: true,
      tools: [
        "lexicon_list",
        "sensitive_scan",
        "lexicon_manage",
        "style_template_get",
        "readDraft",
        "readMaterial",
        "run_python",
        "run_js",
        "editDraft",
        "create_annotation_groups",
      ],
    });
    expect(byName.get("review")?.children).toHaveLength(8);
    expect(byName.get("review")?.children.map((skill) => skill.name)).toEqual([
      "consistency",
      "custom",
      "deai",
      "format",
      "privacy",
      "role",
      "sensitive",
      "source-check",
    ]);
    expect(byName.get("review")?.children[0]).toMatchObject({
      label: "一致性审查",
      summary: "对照文档自身核查并验算一致性问题。",
      icon: "star",
      children: [],
    });
    expect(byName.get("web-search")?.children).toEqual([]);
    for (const nonTopLevelName of [
      "sensitive-review",
      "sensitive",
      "source-check",
      "deai-review",
      "deai",
      "consistency-review",
      "consistency",
      "privacy-review",
      "privacy",
      "format-review",
      "format",
      "role-review",
      "role",
      "custom-review",
      "codex-image",
      "svg",
      "custom",
      "mermaid",
      "drawio",
    ]) {
      expect(byName.has(nonTopLevelName)).toBe(false);
    }
    expect(byName.has("dingtalk-docs")).toBe(false);
    expect(json.skills.map((skill) => skill.name).slice(0, 8)).toEqual([
      "browser-ops",
      "web-search",
      "image-gen",
      "image-reading",
      "doc-calc",
      "materials",
      "github-materials",
      "feishu",
    ]);
  });
});

describe("GET /api/v1/skills/:name", () => {
  it("returns one skill detail with body", async () => {
    const res = await request("GET", "/api/v1/skills/web-search");
    expect(res.status).toBe(200);
    const json = await res.json() as {
      name: string;
      label: string;
      body: string;
      config?: string;
      tools?: string[];
    };
    expect(json).toMatchObject({
      name: "web-search",
      label: "联网搜",
      config: "search-provider",
      tools: ["webSearch", "fetchArticle"],
    });
    expect(json.body).toContain("# 联网搜索");
    expect(json.body.trimStart().startsWith("---")).toBe(false);
  });
});

describe("POST /api/v1/skills/:name/:action", () => {
  const savedMutation = process.env.QINGAGENT_ALLOW_SKILL_MUTATION;

  afterAll(() => {
    if (savedMutation === undefined) delete process.env.QINGAGENT_ALLOW_SKILL_MUTATION;
    else process.env.QINGAGENT_ALLOW_SKILL_MUTATION = savedMutation;
  });

  it("真实 app 中央 mutation 守卫拒绝跨站 skills action", async () => {
    process.env.QINGAGENT_ALLOW_SKILL_MUTATION = "1";
    const path = "/api/v1/skills/__nope__/enable";

    const rejected = await app.request(path, {
      method: "POST",
      headers: { Origin: "https://evil.test" },
    });
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toEqual({ error: "跨站请求被拒绝" });

    const allowed = await app.request(path, {
      method: "POST",
      headers: { Origin: "http://localhost:6173" },
    });
    expect(allowed.status).not.toBe(403);
    expect(allowed.status).toBe(404);
  });
});

describe("上游错误脱敏", () => {
  it("stream / ask-more 日志脱敏函数不会保留 key 样式明文", () => {
    const raw = new Error(
      'Authorization: Bearer sk-live-stream-secret "x-api-key":"sk-live-askmore-secret" plain sk-live-plain-secret',
    );

    const streamLog = redactStreamErrorForLog(raw);
    const askMoreLog = redactAskMoreErrorForLog(raw);

    for (const log of [streamLog, askMoreLog]) {
      expect(log).not.toContain("sk-live-stream-secret");
      expect(log).not.toContain("sk-live-askmore-secret");
      expect(log).not.toContain("sk-live-plain-secret");
      expect(log).toContain("sk-[REDACTED]");
    }
    expect(publicStreamErrorReason()).toBe("模型服务暂时不可用，请稍后重试");
    expect(publicAskMoreErrorMessage()).toBe("上游模型服务暂时不可用，请稍后重试");
  });
});

describe("POST /api/v1/ask-more 请求体契约", () => {
  async function expectAskMoreBodyAccepted(body: unknown) {
    const res = await request("POST", "/api/v1/ask-more", {
      toolCallId: "plan-draft-contract",
      ...(body as Record<string, unknown>),
    });
    expect(res.status).not.toBe(400);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Session not found" });
  }

  it("接受无 options 的自由文本题", async () => {
    await expectAskMoreBodyAccepted({
      sessionId: "missing-askmore-session",
      currentQuestions: [
        {
          id: "other_requirements",
          label: "还有哪些其他重要信息或特别要求",
          kind: { kind: "text" },
        },
      ],
      currentAnswers: {
        other_requirements: { chosen: [], freeText: null },
      },
    });
  });

  it("接受选项题与无 options 文本题混合", async () => {
    await expectAskMoreBodyAccepted({
      sessionId: "missing-askmore-session",
      currentQuestions: [
        {
          id: "audience",
          label: "目标读者",
          kind: { kind: "single" },
          options: [{ value: "public", label: "大众读者" }],
        },
        {
          id: "notes",
          label: "补充说明",
          kind: { kind: "text" },
        },
      ],
      currentAnswers: {
        audience: { chosen: ["public"], freeText: null },
        notes: { chosen: [], freeText: "需要兼顾专业性和可读性" },
      },
    });
  });

  it("保留全带 options 的既有问题形状", async () => {
    await expectAskMoreBodyAccepted({
      sessionId: "missing-askmore-session",
      currentQuestions: [
        {
          id: "tone",
          label: "语气",
          kind: { kind: "multi" },
          options: [
            { value: "warm", label: "温和" },
            { value: "sharp", label: "锋利" },
          ],
        },
      ],
      currentAnswers: {
        tone: { chosen: ["warm"] },
      },
    });
  });

  it("接受空 currentQuestions 且允许缺省 currentAnswers", async () => {
    await expectAskMoreBodyAccepted({
      sessionId: "missing-askmore-session",
      currentQuestions: [],
    });
  });
});

// -----------------------------------------------------------------------
// History
// -----------------------------------------------------------------------
describe("GET /api/v1/history", () => {
  it("returns 200 with valid HistoryList shape", async () => {
    const res = await request("GET", "/api/v1/history");
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(Array.isArray(json.entries)).toBe(true);
    expect(json.entries).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------
// Command submit + events
// -----------------------------------------------------------------------
describe("POST /api/v1/stream", () => {
  it("accepts startSession command and exposes frames from /events", async () => {
    const command = {
      kind: "startSession",
      data: { mode: { kind: "new", data: { template: null } } },
    };
    const res = await request("POST", "/api/v1/commands", command);
    expect(res.status).toBe(200);
    const json = await res.json() as { accepted: boolean; sessionId: string; epoch: number };
    expect(json.accepted).toBe(true);
    expect(json.sessionId).toBeTruthy();

    const controller = new AbortController();
    const events = await app.request(
      `/api/v1/events?sessionId=${encodeURIComponent(json.sessionId)}&after=0&epoch=${json.epoch}`,
      { method: "GET", signal: controller.signal },
    );
    const contentType = events.headers.get("content-type");
    expect(contentType).toContain("text/event-stream");

    const body = await readSseUntil(events, controller, "sessionMeta");
    expect(body).toContain("event: frame");
    expect(body).toContain("sessionMeta");
  });

  it("emits sanitized draftingFailed frame from /events on background error", async () => {
    // Send a sendMessage for a non-existent session to trigger error path
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const command = {
        kind: "sendMessage",
        data: {
          sessionId: "sk-live-session-secret",
          text: "hello",
          mentions: [],
          skills: [],
          chips: [],
        },
      };
      const res = await request("POST", "/api/v1/commands", command);
      expect(res.status).toBe(200);
      const accepted = await res.text();
      expect(accepted).not.toContain("sk-live-session-secret");

      const controller = new AbortController();
      const events = await app.request(
        "/api/v1/events?sessionId=sk-live-session-secret&after=0",
        { method: "GET", signal: controller.signal },
      );
      const body = await readSseUntil(events, controller, "draftingFailed");
      // Should contain a draftingFailed frame
      expect(body).toContain("draftingFailed");
      expect(body).toContain("模型服务暂时不可用，请稍后重试");
      expect(body).not.toContain("sk-live-session-secret");
      expect(body).not.toContain("Session not found");
      const logged = consoleError.mock.calls.flat().map(String).join("\n");
      expect(logged).not.toContain("sk-live-session-secret");
      expect(logged).not.toContain("Session not found");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("accepts sendMessage with fileIds field", async () => {
    const command = {
      kind: "sendMessage",
      data: {
        sessionId: "nonexistent",
        text: "check this file",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: ["11111111-1111-4111-8111-111111111111"],
      },
    };
    const res = await request("POST", "/api/v1/stream", command);
    // Should not return 400 — fileIds are valid
    expect(res.status).toBe(200);
  });

  it("accepts sendMessage with empty fileIds array", async () => {
    const command = {
      kind: "sendMessage",
      data: {
        sessionId: "nonexistent",
        text: "no files",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: [],
      },
    };
    const res = await request("POST", "/api/v1/stream", command);
    expect(res.status).toBe(200);
  });

  it("accepts sendMessage without fileIds field (backward compat)", async () => {
    const command = {
      kind: "sendMessage",
      data: {
        sessionId: "nonexistent",
        text: "old client",
        mentions: [],
        skills: [],
        chips: [],
      },
    };
    const res = await request("POST", "/api/v1/stream", command);
    // Should not return 400 — fileIds is optional
    expect(res.status).toBe(200);
  });

  it("accepts sendMessage with a valid skills array", async () => {
    const command = {
      kind: "sendMessage",
      data: {
        sessionId: "nonexistent",
        text: "use a skill",
        mentions: [],
        skills: [{ id: "browser-ops", version: null }],
        chips: [],
        fileIds: [],
      },
    };
    const res = await request("POST", "/api/v1/stream", command);
    expect(res.status).toBe(200);
  });

  it("rejects sendMessage with non-array skills", async () => {
    const command = {
      kind: "sendMessage",
      data: {
        sessionId: "s-1",
        text: "bad",
        mentions: [],
        skills: "browser-ops",
        chips: [],
        fileIds: [],
      },
    };
    const res = await request("POST", "/api/v1/stream", command);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("skills");
  });

  it("rejects sendMessage with non-array fileIds", async () => {
    const command = {
      kind: "sendMessage",
      data: {
        sessionId: "s-1",
        text: "bad",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: "not-an-array",
      },
    };
    const res = await request("POST", "/api/v1/stream", command);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("fileIds");
  });

  it("rejects sendMessage with non-string fileIds element", async () => {
    const command = {
      kind: "sendMessage",
      data: {
        sessionId: "s-1",
        text: "bad",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: [123],
      },
    };
    const res = await request("POST", "/api/v1/stream", command);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("fileIds[0]");
  });

  it("rejects sendMessage with non-UUID fileIds element", async () => {
    const command = {
      kind: "sendMessage",
      data: {
        sessionId: "s-1",
        text: "bad",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: ["../secret"],
      },
    };
    const res = await request("POST", "/api/v1/stream", command);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("fileIds[0]");
    expect(json.error).toContain("valid UUID");
  });

  it("accepts a structurally valid updateDoc command", async () => {
    const command = {
      kind: "updateDoc",
      data: {
        sessionId: "nonexistent",
        expectedDocumentSnapshot: 1,
        baseContentHash: "pmv1-base",
        legacySections: [{ kind: "p", data: { text: "正文" } }],
        clientMutationId: "mutation-1",
      },
    };
    const res = await request("POST", "/api/v1/stream", command);
    // 结构校验已通过；不存在的会话进入 Actor 后按统一业务失败协议返回 422。
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "COMMAND_FAILED" },
    });
  });

  it("rejects updateDoc with missing sessionId", async () => {
    const command = {
      kind: "updateDoc",
      data: {
        sessionId: "",
        expectedDocumentSnapshot: 1,
        legacySections: [{ kind: "p", data: { text: "正文" } }],
        clientMutationId: "mutation-1",
      },
    };
    const res = await request("POST", "/api/v1/stream", command);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("sessionId");
  });

  it("rejects updateDoc with empty baseContentHash", async () => {
    const command = {
      kind: "updateDoc",
      data: {
        sessionId: "s-1",
        expectedDocumentSnapshot: 1,
        baseContentHash: "",
        legacySections: [{ kind: "p", data: { text: "正文" } }],
        clientMutationId: "mutation-1",
      },
    };
    const res = await request("POST", "/api/v1/stream", command);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("baseContentHash");
  });

  it("rejects updateDoc with non-integer expectedDocumentSnapshot", async () => {
    const command = {
      kind: "updateDoc",
      data: {
        sessionId: "s-1",
        expectedDocumentSnapshot: 1.5,
        legacySections: [{ kind: "p", data: { text: "正文" } }],
        clientMutationId: "mutation-1",
      },
    };
    const res = await request("POST", "/api/v1/stream", command);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("expectedDocumentSnapshot");
  });

  it("rejects updateDoc with non-array legacySections", async () => {
    const command = {
      kind: "updateDoc",
      data: {
        sessionId: "s-1",
        expectedDocumentSnapshot: 1,
        legacySections: "bad",
        clientMutationId: "mutation-1",
      },
    };
    const res = await request("POST", "/api/v1/stream", command);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("legacySections must be an array");
  });

  it("rejects updateDoc with missing clientMutationId", async () => {
    const command = {
      kind: "updateDoc",
      data: {
        sessionId: "s-1",
        expectedDocumentSnapshot: 1,
        legacySections: [{ kind: "p", data: { text: "正文" } }],
        clientMutationId: "",
      },
    };
    const res = await request("POST", "/api/v1/stream", command);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("clientMutationId");
  });
});

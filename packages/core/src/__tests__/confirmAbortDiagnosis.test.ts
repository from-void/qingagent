import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withIdleTimeout } from "../agent-run/streamErrors.js";
import { commandCardFromResult } from "../agent-run/toolCards.js";
import { abortAndCleanupTurn } from "../agent-run/turnCleanup.js";
import { killedCommandNotice } from "../workspace/gatedExecuteCommandTool.js";
import {
  CONFIRM_RESUME_WALL_TIMEOUT_MS,
  ConfirmService,
} from "../confirm/confirmService.js";
import { SANDBOX_TIMEOUT_MS } from "../workspace/sessionWorkspace.js";
import { resolveReadWallPolicy } from "../workspace/readWallPolicy.js";
import { buildSeatbeltReadWallProfile } from "../workspace/readWallSeatbelt.js";
import { createSession } from "../session/sessionState.js";
import type { PendingConfirm } from "../session/sessionState.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pendingConfirm(toolCallId: string): PendingConfirm {
  return {
    confirmId: `confirm-${toolCallId}`,
    runId: "run-1",
    toolCallId,
    toolName: "mastra_workspace_execute_command",
    commandDigest: "digest",
    spec: {
      id: `confirm-${toolCallId}`,
      kind: "install",
      title: "安装工具",
      say: "需要确认",
      commandPreview: "npx -y pkg skill add demo",
      footHint: "仅本次",
      primaryLabel: "安装并继续",
      secondaryLabel: "先跳过",
    },
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    status: "pending",
  };
}

describe("待确认期间的无帧判定", () => {
  it("判死回调返回 false 时不产错误帧,后到的 chunk 仍会被投递", async () => {
    let release!: (value: string) => void;
    const pendingChunk = new Promise<string>((resolve) => {
      release = resolve;
    });
    async function* source(): AsyncGenerator<string> {
      yield await pendingChunk;
    }
    const verdicts: boolean[] = [];
    const monitored = withIdleTimeout(source(), 5, () => {
      verdicts.push(false);
      // 有待确认卡 → 本轮活着,否决判死。
      return false;
    });

    const collected: unknown[] = [];
    const consume = (async () => {
      for await (const chunk of monitored) collected.push(chunk);
    })();
    await vi.waitFor(() => expect(verdicts.length).toBeGreaterThan(0));
    release("late-chunk");
    await consume;

    expect(collected).toEqual(["late-chunk"]);
    // 否决期间绝不能冒出 idleTimeout 错误帧。
    expect(collected.some((chunk) => typeof chunk === "object")).toBe(false);
  });

  it("回调返回 true 时仍按原语义判死并产错误帧", async () => {
    async function* source(): AsyncGenerator<string> {
      await new Promise(() => undefined);
      yield "never";
    }
    const monitored = withIdleTimeout(source(), 5, () => true);
    const collected: unknown[] = [];
    for await (const chunk of monitored) collected.push(chunk);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ type: "error", payload: { idleTimeout: true } });
  });
});

describe("确认恢复墙的时间预算不变式", () => {
  it("恢复墙必须严格宽于前台命令自身预算,否则命令会在自己超时前被上层掐死", () => {
    expect(CONFIRM_RESUME_WALL_TIMEOUT_MS).toBeGreaterThan(SANDBOX_TIMEOUT_MS);
  });
});

describe("回合清理收走待确认卡时的如实归因", () => {
  it("带可操作说明的 confirmResolved,并把真实原因写进模型上下文", async () => {
    const state = createSession("confirm-abort-honesty");
    state.streamId = "stream-1";
    state._activeAgentMessageId = "agent-1";
    const pending = pendingConfirm("tool-1");
    state.pendingConfirms.set(pending.toolCallId, pending);
    state.chatHistory.push({
      id: "agent-1",
      role: { kind: "agent" },
      ts: new Date().toISOString(),
      parts: [{
        kind: "toolCall",
        data: {
          id: "tool-1",
          name: pending.toolName,
          render: { kind: "chatInline" },
          status: { kind: "running", data: { progressPct: null, etaSec: null } },
          body: { kind: "generic", data: { argsJson: "" } },
          result: null,
        },
      }],
      chips: null,
    });
    const service = new ConfirmService({
      appendAudit: async () => undefined,
      persist: async () => undefined,
    });

    const frames = [];
    for await (const frame of abortAndCleanupTurn(state, {
      reason: "preemptedByNewMessage",
      confirmService: service,
    })) {
      frames.push(frame);
    }

    const resolved = frames.find((frame) => frame.kind === "confirmResolved");
    expect(resolved).toBeDefined();
    expect(resolved).toMatchObject({
      data: { resolution: "aborted", toolCallId: "tool-1" },
    });
    const message = resolved?.kind === "confirmResolved" ? resolved.data.message ?? "" : "";
    expect(message).toContain("命令没有执行");
    expect(message).toContain("重新发起");

    const note = state.messages.at(-1);
    expect(note?.role).toBe("system");
    const noteText = typeof note?.content === "string" ? note.content : "";
    expect(noteText).toContain("不是用户拒绝");
    expect(noteText).toContain("没有及时点击确认");
  });
});

describe("被信号打死 ≠ 用户取消", () => {
  it("killed 结果落 killed 终态而不是 aborted,且说明不甩锅给用户", () => {
    const card = commandCardFromResult(
      { command: "npx -y pkg skill add demo" },
      {
        success: false,
        exitCode: 128,
        cancelled: false,
        timedOut: false,
        killed: true,
        output: `Exit code: 128\n${killedCommandNotice(128)}`,
      },
      false,
    );
    expect(card.terminalKind).toBe("killed");
    expect(card.phase).toBe("failed");
    expect(card.outputTail).toContain("这不是用户取消");
  });

  it("abortSignal 触发的取消仍落 aborted", () => {
    const card = commandCardFromResult(
      { command: "sleep 60" },
      { success: false, exitCode: -1, cancelled: true, timedOut: false, output: "命令已取消" },
      false,
    );
    expect(card.terminalKind).toBe("aborted");
  });

  it("超时优先于 killed", () => {
    const card = commandCardFromResult(
      { command: "sleep 600" },
      { success: false, exitCode: -1, cancelled: false, timedOut: true, killed: true, output: "命令执行超时" },
      false,
    );
    expect(card.terminalKind).toBe("timedOut");
  });
});

describe("沙箱写墙的放开面", () => {
  it("只放开技能目录与包缓存,HOME 其余部分仍不可写", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-confirm-writewall-"));
    roots.push(root);
    const home = join(root, "home");
    const dataDir = join(home, "app-data");
    const sessionDir = join(dataDir, "sessions", "current");
    const sandboxBinDir = join(dataDir, "bin");
    const builtinSkillsDir = join(home, "product", "skills");
    const userSkillsDir = join(home, ".qingagent", "skills");
    const agentsSkillsDir = join(home, ".agents", "skills");
    // 历史打包版落点:存量用户的技能就在这里,可写待遇必须与主技能目录一致。
    const legacyUserDataSkillsDir = join(home, "Library", "@qingagent", "desktop", "skills");
    const packageCacheDir = join(dataDir, "package-cache");
    const documentsDir = join(home, "Documents");
    await Promise.all([
      mkdir(sessionDir, { recursive: true }),
      mkdir(sandboxBinDir, { recursive: true }),
      mkdir(builtinSkillsDir, { recursive: true }),
      mkdir(userSkillsDir, { recursive: true }),
      mkdir(agentsSkillsDir, { recursive: true }),
      mkdir(legacyUserDataSkillsDir, { recursive: true }),
      mkdir(packageCacheDir, { recursive: true }),
      mkdir(documentsDir, { recursive: true }),
    ]);

    const policy = await resolveReadWallPolicy({
      platform: "darwin",
      env: { HOME: home },
      dataDir,
      sessionDir,
      sandboxBinDir,
      builtinSkillsDir,
      userSkillsDir,
      extraUserSkillsDirs: [agentsSkillsDir, legacyUserDataSkillsDir],
      packageCacheDir,
      extraReadOnlyPaths: [],
      effectiveUid: typeof process.geteuid === "function" ? process.geteuid() : -1,
      effectiveHome: home,
    });
    const profile = buildSeatbeltReadWallProfile(policy);

    // 每个技能来源都必须拿到与主技能目录一致的可写待遇:装技能可能落到其中任意一个,
    // 只读会重演"子进程被信号打死"。
    for (const writable of [
      userSkillsDir,
      agentsSkillsDir,
      legacyUserDataSkillsDir,
      packageCacheDir,
      sessionDir,
    ]) {
      expect(profile).toContain(`(allow file-write* (subpath ${JSON.stringify(writable)}))`);
    }
    for (const source of [userSkillsDir, agentsSkillsDir, legacyUserDataSkillsDir]) {
      expect(
        policy.allowPaths.find((path) => path.lexicalPath === source),
      ).toMatchObject({ kind: "user-skills", writable: true });
    }
    // HOME 其余部分、内置技能目录都不得出现写规则。
    expect(profile).not.toContain(`(allow file-write* (subpath ${JSON.stringify(home)}))`);
    expect(profile).not.toContain(`(allow file-write* (subpath ${JSON.stringify(documentsDir)}))`);
    expect(profile).not.toContain(`(allow file-write* (subpath ${JSON.stringify(builtinSkillsDir)}))`);
    // 凭证黑名单照旧只读 + deny。
    expect(profile).toContain(`(deny file-read* (subpath ${JSON.stringify(join(home, ".ssh"))}))`);
    expect(profile).not.toContain(`(allow file-write* (subpath ${JSON.stringify(join(home, ".ssh"))}))`);
  });
});

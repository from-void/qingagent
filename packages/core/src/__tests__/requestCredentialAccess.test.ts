import { describe, expect, it, vi, beforeEach } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import {
  buildCredentialAccessConfirmSpec,
  checkRequestedCredentialAccess,
  credentialAccessDigest,
  requestCredentialAccessInputSchema,
  REQUEST_CREDENTIAL_ACCESS_TOOL,
} from "../confirm/credentialAccessConfirmation.js";
import {
  credentialAccessIsCooling,
  markCredentialAccessRejected,
} from "../confirm/credentialAccessCooldown.js";
import { issueApprovalProof } from "../confirm/approvalProof.js";
import { createRequestCredentialAccessTool } from "../tools/requestCredentialAccess.js";
import { selectEffectiveCredentialPaths } from "../skills/credentialRequests.js";

const HOME = "/home/tester";
const invalidateSessionWorkspace = vi.hoisted(() => vi.fn());
const ensureCredentialPathExists = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../workspace/sessionWorkspace.js", () => ({ invalidateSessionWorkspace }));
vi.mock("../skills/credentialRequests.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skills/credentialRequests.js")>();
  return { ...actual, ensureCredentialPathExists };
});

function session(): { sessionId: string } {
  return { sessionId: "s1" };
}

describe("工具入参 schema 与路径校验", () => {
  it("接受 ~/ 路径 + 一句话理由", () => {
    const parsed = requestCredentialAccessInputSchema.safeParse({
      path: "~/.yuque",
      reason: "语雀命令行工具要读已有的登录",
    });
    expect(parsed.success).toBe(true);
  });

  it("拒绝缺字段、超长理由与多余字段", () => {
    expect(requestCredentialAccessInputSchema.safeParse({ path: "~/.yuque" }).success).toBe(false);
    expect(requestCredentialAccessInputSchema.safeParse({
      path: "~/.yuque",
      reason: "长".repeat(81),
    }).success).toBe(false);
    expect(requestCredentialAccessInputSchema.safeParse({
      path: "~/.yuque",
      reason: "ok",
      extra: 1,
    }).success).toBe(false);
  });

  it.each([
    ["~/../etc", "凭证路径不能包含 .. "],
    ["/etc/shadow", "凭证路径必须在用户目录下"],
    [".yuque", "凭证路径必须以 ~/ 开头"],
    ["~", "凭证路径不能是整个用户目录"],
    ["~/Library/Keychains", "浏览器数据和系统钥匙串不可共享"],
    ["~/.config/google-chrome", "浏览器数据和系统钥匙串不可共享"],
  ])("拒绝非法路径 %s", (path, message) => {
    expect(checkRequestedCredentialAccess({ path, reason: "r" }, HOME)).toEqual({ ok: false, message });
  });

  it("规范化为绝对路径并保留 ~/ 写法", () => {
    expect(checkRequestedCredentialAccess({ path: "~/.yuque", reason: " 理由 " }, HOME)).toEqual({
      ok: true,
      path: "/home/tester/.yuque",
      declared: "~/.yuque",
      reason: "理由",
    });
  });

  it("摘要绑定会话与完整参数", () => {
    const a = credentialAccessDigest("s1", { path: "~/.yuque", reason: "r" });
    expect(a).toEqual(credentialAccessDigest("s1", { path: "~/.yuque", reason: "r" }));
    expect(a).not.toEqual(credentialAccessDigest("s2", { path: "~/.yuque", reason: "r" }));
    expect(a).not.toEqual(credentialAccessDigest("s1", { path: "~/.yuque", reason: "r2" }));
  });
});

describe("确认卡文案", () => {
  it("套用模板、可记住,且不出现内部词", () => {
    const spec = buildCredentialAccessConfirmSpec(
      { declared: "~/.yuque", reason: "语雀命令行工具要读已有的登录。" },
      "confirm-1",
    );
    expect(spec.kind).toBe("connect");
    expect(spec.rememberCategory).toEqual({ kind: "connect", label: "连接账号" });
    expect(spec.say).toContain("命令行工具需要访问 ~/.yuque 来共享你已有的登录，允许吗？");
    expect(spec.say).toContain("语雀命令行工具要读已有的登录。");
    expect(spec.footHint).toContain("随时收回");
    const all = [spec.title, spec.say, spec.footHint, spec.sub].join(" ");
    for (const jargon of ["沙箱", "白名单", "黑名单", "读墙", "写墙"]) {
      expect(all).not.toContain(jargon);
    }
  });
});

describe("按需授权工具", () => {
  beforeEach(() => {
    invalidateSessionWorkspace.mockClear();
    ensureCredentialPathExists.mockClear();
  });

  function tool(state: ReturnType<typeof session>, createGrant = vi.fn(async () => undefined)) {
    return {
      createGrant,
      instance: createRequestCredentialAccessTool({
        sessionId: state.sessionId,
        state: state as never,
        store: { createGrant },
        home: HOME,
      }),
    };
  }

  it("合法申请要走确认卡(requireApproval=true)", async () => {
    const state = session();
    const predicate = tool(state).instance.requireApproval;
    if (typeof predicate !== "function") throw new Error("requireApproval missing");
    expect(await predicate({ path: "~/.yuque", reason: "r" } as never, {} as never)).toBe(true);
  });

  it("非法路径不弹卡,execute 直接给中文原因", async () => {
    const state = session();
    const { instance, createGrant } = tool(state);
    const predicate = instance.requireApproval;
    if (typeof predicate !== "function") throw new Error("requireApproval missing");
    expect(await predicate({ path: "~/Library/Keychains", reason: "r" } as never, {} as never)).toBe(false);
    const result = await instance.execute!({ path: "~/Library/Keychains", reason: "r" } as never, {} as never);
    expect(result).toEqual({
      granted: false,
      message: "不能共享这个位置:浏览器数据和系统钥匙串不可共享",
    });
    expect(createGrant).not.toHaveBeenCalled();
  });

  it("按真实 Mastra 上下文核销 proof、落授权并作废全部会话沙箱缓存", async () => {
    const state = session();
    const { instance, createGrant } = tool(state);
    const input = { path: "~/.yuque", reason: "语雀要读登录" };
    issueApprovalProof(state as never, {
      sessionId: "s1",
      runId: "r1",
      toolCallId: "call-1",
      commandDigest: credentialAccessDigest("s1", input),
    });
    const result = await instance.execute!(input as never, {
      requestContext: new RequestContext([["runId", "r1"]]),
      agent: { toolCallId: "call-1" },
    } as never);
    expect(result).toEqual({
      granted: true,
      message: "已可以读写 ~/.yuque，现在重试刚才被拒的命令。",
    });
    expect(ensureCredentialPathExists).toHaveBeenCalledWith("/home/tester/.yuque");
    expect(createGrant).toHaveBeenCalledWith({
      path: "/home/tester/.yuque",
      skillName: "",
      declared: "~/.yuque",
      source: "card",
    });
    expect(invalidateSessionWorkspace).toHaveBeenCalledWith();
  });

  it("没有对应批准凭证时不落授权", async () => {
    const state = session();
    const { instance, createGrant } = tool(state);
    const result = await instance.execute!(
      { path: "~/.yuque", reason: "r" } as never,
      {
        requestContext: new RequestContext([["runId", "r1"]]),
        agent: { toolCallId: "call-x" },
      } as never,
    );
    expect(result).toMatchObject({ granted: false });
    expect(createGrant).not.toHaveBeenCalled();
  });

  it.each([
    ["runId", { agent: { toolCallId: "call-1" } }],
    ["toolCallId", { requestContext: new RequestContext([["runId", "r1"]]) }],
  ])("存在 proof state 但 Mastra 上下文缺少 %s 时 fail-closed", async (_missing, context) => {
    const state = session();
    const { instance, createGrant } = tool(state);
    const input = { path: "~/.yuque", reason: "r" };
    issueApprovalProof(state as never, {
      sessionId: "s1",
      runId: "r1",
      toolCallId: "call-1",
      commandDigest: credentialAccessDigest("s1", input),
    });

    const result = await instance.execute!(input as never, context as never);

    expect(result).toMatchObject({ granted: false });
    expect(ensureCredentialPathExists).not.toHaveBeenCalled();
    expect(createGrant).not.toHaveBeenCalled();
    expect(invalidateSessionWorkspace).not.toHaveBeenCalled();
  });

  it("拒绝后同一位置进入冷却:不再弹卡,也不再落授权", async () => {
    const state = session();
    const { instance, createGrant } = tool(state);
    markCredentialAccessRejected(state as never, "~/.yuque");
    expect(credentialAccessIsCooling(state as never, "~/.yuque")).toBe(true);
    const predicate = instance.requireApproval;
    if (typeof predicate !== "function") throw new Error("requireApproval missing");
    expect(await predicate({ path: "~/.yuque", reason: "r" } as never, {} as never)).toBe(false);
    const result = await instance.execute!({ path: "~/.yuque", reason: "r" } as never, {} as never);
    expect(result).toMatchObject({ granted: false });
    expect((result as { message: string }).message).toContain("刚刚拒绝共享 ~/.yuque");
    expect(createGrant).not.toHaveBeenCalled();
    // 别的位置不受牵连
    expect(await predicate({ path: "~/.lark-cli", reason: "r" } as never, {} as never)).toBe(true);
  });
});

describe("两条通道共用同一张授权表", () => {
  const declared = [{ skillName: "feishu", skillLabel: "连飞书", declared: "~/.lark-cli", path: "/home/tester/.lark-cli" }];

  it("技能声明的授权要技能仍在声明才生效", () => {
    expect(selectEffectiveCredentialPaths(
      [{ path: "/home/tester/.lark-cli", skillName: "feishu" }],
      declared,
    )).toEqual(["/home/tester/.lark-cli"]);
    expect(selectEffectiveCredentialPaths(
      [{ path: "/home/tester/.lark-cli", skillName: "feishu" }],
      [],
    )).toEqual([]);
  });

  it("按需申请的授权不依赖任何技能", () => {
    expect(selectEffectiveCredentialPaths(
      [{ path: "/home/tester/.yuque", skillName: "" }],
      [],
    )).toEqual(["/home/tester/.yuque"]);
  });

  it("同一路径两条通道都授权时只放行一次", () => {
    expect(selectEffectiveCredentialPaths(
      [
        { path: "/home/tester/.lark-cli", skillName: "feishu" },
        { path: "/home/tester/.lark-cli", skillName: "" },
      ],
      declared,
    )).toEqual(["/home/tester/.lark-cli"]);
  });
});

describe("工具身份", () => {
  it("id 与确认流水线认的名字一致", () => {
    expect(createRequestCredentialAccessTool({
      sessionId: "s1",
      store: { createGrant: async () => undefined },
      home: HOME,
    }).id).toBe(REQUEST_CREDENTIAL_ACCESS_TOOL);
  });
});

// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SecurityPanel } from "./SecurityPanel";
import { buildCredentialShareSpec, parseCredentialShareItems } from "./credentialShare";

const toastApi = { show: vi.fn(), dismiss: vi.fn() };
vi.mock("../../system/ToastProvider", () => ({ useToast: () => toastApi }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const item = {
  skillName: "feishu",
  skillLabel: "连飞书",
  declared: "~/.lark-cli",
  granted: true,
  grantedAt: "2026-07-29T00:00:00.000Z",
};

describe("确认卡文案", () => {
  it("说人话:点名技能与位置,不出现内部词", () => {
    const spec = buildCredentialShareSpec([{ ...item, granted: false, grantedAt: null }]);
    expect(spec).not.toBeNull();
    expect(spec!.kind).toBe("connect");
    expect(spec!.rememberCategory).toEqual({ kind: "connect", label: "连接账号" });
    expect(spec!.title).toBe("让「连飞书」用上你已登录的账号");
    expect(spec!.say).toContain("~/.lark-cli");
    expect(spec!.say).toContain("同一个账号");
    expect(spec!.footHint).toContain("随时收回");
    expect(spec!.primaryLabel).toBe("允许共享");
    const all = [spec!.title, spec!.say, spec!.footHint, spec!.sub].join(" ");
    for (const jargon of ["沙箱", "白名单", "黑名单", "读墙", "写墙", "策略", "权限位"]) {
      expect(all).not.toContain(jargon);
    }
  });

  it("没有待授权条目时不出卡", () => {
    expect(buildCredentialShareSpec([])).toBeNull();
  });

  it("多条声明合并成一张卡", () => {
    const spec = buildCredentialShareSpec([
      { ...item, granted: false, grantedAt: null },
      { ...item, declared: "~/.yuque", granted: false, grantedAt: null },
    ]);
    expect(spec!.sub).toBe("~/.lark-cli、~/.yuque");
  });
});

describe("响应解析", () => {
  it("剔除结构不合法的条目", () => {
    expect(parseCredentialShareItems({ items: [item, { skillName: 1 }, null] })).toEqual([item]);
    expect(parseCredentialShareItems(null)).toEqual([]);
  });
});

describe("安全页的已共享列表", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) =>
      new Response(JSON.stringify(handler(String(url), init)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));
  }

  const connectCategory = {
    kind: "connect",
    label: "连接账号",
    grantMode: "ask",
    grantModes: ["ask", "always"],
    present: false,
    grantId: null,
    version: 0,
  };

  it("列出已共享条目,点收回后从列表消失", async () => {
    let granted = true;
    const calls: unknown[] = [];
    stubFetch((url, init) => {
      if (init?.method === "POST") {
        calls.push(JSON.parse(String(init.body)));
        granted = false;
        return { ...item, granted: false, grantedAt: null };
      }
      return {
        categories: [connectCategory],
        credentialShare: [{ ...item, granted, grantedAt: granted ? item.grantedAt : null }],
      };
    });

    await act(async () => {
      root.render(<SecurityPanel />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain("已共享的登录信息");
    expect(host.textContent).toContain("连飞书");
    expect(host.textContent).toContain("~/.lark-cli");

    const revoke = host.querySelector<HTMLButtonElement>(".security-revoke");
    expect(revoke).not.toBeNull();
    await act(async () => {
      revoke!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(calls).toEqual([{ skillName: "feishu", declared: "~/.lark-cli", granted: false }]);
    expect(host.querySelector('[data-wf="CredentialSharePanel"]')).toBeNull();
  });

  it("没有已共享条目时整段不显示", async () => {
    stubFetch(() => ({
      categories: [],
      credentialShare: [{ ...item, granted: false, grantedAt: null }],
    }));
    await act(async () => {
      root.render(<SecurityPanel />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelector('[data-wf="CredentialSharePanel"]')).toBeNull();
  });
});

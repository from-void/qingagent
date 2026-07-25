// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactNode, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import {
  ConfirmOverlay,
  ConfirmRecordBar,
  type ConfirmDecision,
  type ConfirmSpec,
} from "./ConfirmOverlay";
import { stripSecretFromDecision, useConfirmCard } from "../hooks/useConfirmCard";
import { magicMoveFromRect, magicMoveToRect } from "../data/barMorph";
import type { ServerStream } from "../data/serverStream";
import { ToastProvider } from "../../../system";
import { subscribeRememberGrantState } from "../../../system/confirmGrantState";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../data/barMorph", () => ({
  magicMoveFromRect: vi.fn(),
  magicMoveToRect: vi.fn(
    (
      _element: HTMLElement,
      _rect: DOMRect | null,
      options?: { onArrive?: () => void },
    ) => options?.onArrive?.(),
  ),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const installSpec: ConfirmSpec = {
  id: "confirm-install",
  kind: "install",
  title: "安装工具",
  sub: "ffmpeg · 音视频处理",
  say: "需要安装 ffmpeg,用来转换视频",
  footHint: "以后使用不再询问 · 可在设置里卸载",
  primaryLabel: "安装并继续",
  secondaryLabel: "先跳过",
};

const optionsSpec: ConfirmSpec = {
  id: "confirm-connect-options",
  kind: "connect",
  title: "连接语雀",
  say: "检测到这台电脑已登录语雀(jimmy-zhang)",
  widget: {
    type: "options",
    options: [
      {
        value: "signed-in",
        label: "使用已登录的账号",
        description: "jimmy-zhang · 当前设备",
        recommended: true,
      },
      {
        value: "token",
        label: "粘贴访问令牌",
        description: "改用另一个账号",
      },
    ],
  },
  footHint: "只读 · www.yuque.com · 设置中随时断开",
  primaryLabel: "连接",
  secondaryLabel: "暂不连接",
};

const secretSpec: ConfirmSpec = {
  id: "confirm-connect-secret",
  kind: "connect",
  title: "连接墨潴笔记",
  say: "粘贴墨潴笔记的访问令牌(在 App「设置 → 开发者」中获取)",
  widget: { type: "secretInput", placeholder: "粘贴访问令牌" },
  footHint: "只读 · api.mizhu.example.com · 令牌只发给该服务",
  primaryLabel: "连接",
  secondaryLabel: "暂不连接",
};

const sendSpec: ConfirmSpec = {
  id: "confirm-send",
  kind: "send",
  title: "发布到公众号",
  say: "将发送到公众号「深圳晚八点」草稿箱",
  footHint: "不会直接群发 · 每次外发都单独确认",
  primaryLabel: "确认发布",
  secondaryLabel: "再改改",
};

describe("ConfirmOverlay", () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.clearAllMocks();
    vi.restoreAllMocks();
    delete window.electron;
  });

  it.each([
    ["install", installSpec],
    ["connect", optionsSpec],
    ["send", sendSpec],
  ] as const)("渲染 %s 通用结构且 kind 只落在样式标记", async (kind, spec) => {
    await renderOverlay(spec);

    const overlay = host!.querySelector<HTMLElement>(".cf-overlay")!;
    expect(overlay.dataset.kind).toBe(kind);
    expect(overlay.querySelectorAll(".cf-say")).toHaveLength(1);
    expect(overlay.querySelectorAll(".cf-foot-hint")).toHaveLength(1);
    expect(overlay.textContent).toContain(spec.title);
    expect(overlay.textContent).toContain(spec.say);
    expect(overlay.textContent).toContain(spec.footHint!);
  });

  it("自动焦点落在主按钮，不落在关闭按钮", async () => {
    await renderOverlay(installSpec);

    expect(document.activeElement).toBe(findButton("安装并继续"));
    expect(document.activeElement).not.toBe(
      host!.querySelector<HTMLButtonElement>(".cf-close"),
    );
  });

  it("主按钮不可用时自动焦点退回 panel 容器", async () => {
    await renderOverlay(secretSpec);

    const panel = host!.querySelector<HTMLElement>(".cf-overlay")!;
    expect(panel.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(panel);
  });

  it("Escape 保持取消语义", async () => {
    const onDecision = vi.fn();
    await renderOverlay(sendSpec, onDecision);

    await act(async () => {
      host!.querySelector<HTMLElement>(".cf-overlay")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    expect(onDecision).toHaveBeenCalledWith({ id: sendSpec.id, accepted: false });
  });

  it("commandPreview 存在时才渲染独立命令块", async () => {
    const commandPreview = "npx skills add ffmpeg --registry https://registry.example.test";
    await renderOverlay({ ...installSpec, commandPreview });

    const preview = host!.querySelector<HTMLElement>(".cf-command-preview");
    expect(preview?.tagName).toBe("PRE");
    expect(preview?.textContent).toBe(commandPreview);
    expect(preview?.getAttribute("aria-label")).toBe("命令预览");

    await act(async () => {
      root?.render(<ConfirmOverlay sessionId="test-session" spec={installSpec} onDecision={vi.fn()} />);
    });
    expect(host!.querySelector(".cf-command-preview")).toBeNull();
  });

  it.each([
    ["安装并继续", true],
    ["先跳过", false],
  ] as const)("按钮「%s」回传 accepted=%s", async (label, accepted) => {
    const onDecision = vi.fn();
    await renderOverlay(installSpec, onDecision);

    await click(findButton(label));

    expect(onDecision).toHaveBeenCalledWith({
      id: installSpec.id,
      accepted,
    });
    expect(magicMoveToRect).toHaveBeenCalledOnce();
  });

  it("桌面能力存在时渲染通用 remember checkbox，缺失时隐藏", async () => {
    const rememberSpec: ConfirmSpec = {
      ...installSpec,
      rememberCategory: {
        kind: "install",
        label: "以后安装时不再询问",
        riskHint: "请确认安装内容和影响范围。",
      },
    };
    await renderOverlay(rememberSpec);
    expect(host!.querySelector<HTMLInputElement>('.cf-remember input[type="checkbox"]')).toBeNull();
    const unavailable = host!.querySelector<HTMLElement>(".cf-remember-unavailable")!;
    expect(unavailable.textContent).toContain(
      "开启记忆需要在桌面应用中完成确认。",
    );
    expect(unavailable.closest(".cf-actions")).toBeNull();

    window.electron = {
      platform: "win32",
      isDesktop: true,
      requestConfirmRememberGrant: vi.fn(async () => "trusted-nonce"),
    };
    await act(async () => {
      root?.render(
        <ConfirmOverlay
          sessionId="test-session"
          spec={rememberSpec}
          onDecision={vi.fn()}
        />,
      );
    });
    const checkbox = host!.querySelector<HTMLInputElement>('.cf-remember input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(host!.querySelector(".cf-remember")?.textContent).toContain(rememberSpec.rememberCategory?.label);
    expect(host!.querySelector(".cf-remember-risk")?.textContent).toBe("请确认安装内容和影响范围。");
    expect(host!.querySelector(".cf-body .cf-remember")).toBeNull();
    const rememberLabel = host!.querySelector<HTMLElement>(".cf-remember")!;
    const secondaryButton = findButton("先跳过");
    const primaryButton = findButton("安装并继续");
    const actions = host!.querySelector<HTMLElement>(".cf-actions")!;
    expect(rememberLabel.parentElement).toBe(actions);
    expect(secondaryButton.parentElement).toBe(actions);
    expect(primaryButton.parentElement).toBe(actions);
    expect(host!.querySelector(".cf-foot-copy .cf-remember")).toBeNull();
    expect(actions.querySelector(".cf-foot-hint")).toBeNull();
    expect(checkbox?.closest("label")?.classList.contains("cf-remember")).toBe(true);
    expect(checkbox?.tabIndex).toBe(0);
    const describedBy = checkbox?.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      "请确认安装内容和影响范围。",
    );
    expect(
      checkbox!.compareDocumentPosition(secondaryButton)
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("footer 常规卡片内几何同行，极窄屏允许记忆项回落到按钮上方", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/pages/workspace/components/confirm-overlay.css"),
      "utf8",
    );
    const rememberRule = css.match(
      /\.cf-actions \.cf-remember \{([^}]*)\}/s,
    )?.[1] ?? "";
    expect(css).toMatch(
      /\.cf-actions \{[^}]*display: flex;[^}]*flex-wrap: wrap;[^}]*align-items: center;/s,
    );
    expect(rememberRule).toMatch(/flex:\s*0 1 auto;/);
    expect(rememberRule).toMatch(/margin-right:\s*auto;/);
    expect(rememberRule).not.toMatch(/flex:\s*1(?:\s|;)/);
    expect(css).toMatch(
      /@media \(max-width: 360px\) \{[\s\S]*?\.cf-actions \.cf-remember \{[^}]*flex-basis: 100%;/,
    );
  });

  it("显式不安全开发标记允许纯 web 渲染，程序化 click 不取得 nonce", async () => {
    const onDecision = vi.fn();
    const rememberSpec: ConfirmSpec = {
      ...installSpec,
      rememberCategory: {
        kind: "install",
        label: "以后安装时不再询问",
        insecureWithoutDesktop: true,
      },
    };
    await renderOverlay(rememberSpec, onDecision);
    const checkbox = host!.querySelector<HTMLInputElement>('.cf-remember input[type="checkbox"]')!;
    await click(checkbox);
    await click(findButton("安装并继续"));
    expect(onDecision).toHaveBeenCalledWith({
      id: installSpec.id,
      accepted: true,
      remember: true,
    });
  });

  it("桌面原生确认同意后携带一次性 nonce 提交记忆", async () => {
    const onDecision = vi.fn();
    const requestGrant = vi.fn(async () => "trusted-nonce");
    window.electron = {
      platform: "win32",
      isDesktop: true,
      requestConfirmRememberGrant: requestGrant,
    };
    const rememberSpec: ConfirmSpec = {
      ...installSpec,
      rememberCategory: {
        kind: "install",
        label: "以后安装时不再询问",
      },
    };
    await renderOverlay(rememberSpec, onDecision);

    await click(host!.querySelector<HTMLInputElement>('.cf-remember input[type="checkbox"]')!);
    await click(findButton("安装并继续"));

    expect(requestGrant).toHaveBeenCalledWith({
      sessionId: "test-session",
      confirmId: rememberSpec.id,
      kind: "install",
      trustedGesture: false,
    });
    expect(onDecision).toHaveBeenCalledWith({
      id: rememberSpec.id,
      accepted: true,
      remember: true,
      uiGrantNonce: "trusted-nonce",
    });
  });

  it("桌面原生确认取消时取消勾选并降级为本次同意", async () => {
    const onDecision = vi.fn();
    window.electron = {
      platform: "win32",
      isDesktop: true,
      requestConfirmRememberGrant: vi.fn(async () => null),
    };
    const rememberSpec: ConfirmSpec = {
      ...installSpec,
      rememberCategory: {
        kind: "install",
        label: "以后安装时不再询问",
      },
    };
    await render(
      <ToastProvider>
        <ConfirmOverlay sessionId="test-session" spec={rememberSpec} onDecision={onDecision} />
      </ToastProvider>,
    );
    const checkbox = host!.querySelector<HTMLInputElement>('.cf-remember input[type="checkbox"]')!;

    await click(checkbox);
    expect(checkbox.checked).toBe(true);
    await click(findButton("安装并继续"));

    expect(checkbox.checked).toBe(false);
    expect(onDecision).toHaveBeenCalledWith({
      id: rememberSpec.id,
      accepted: true,
    });
    expect(host?.querySelector(".qa-toast")?.textContent).toContain(
      "本次操作会继续，但没有记住这次选择；下次同类操作仍会询问。",
    );
  });

  it("等待桌面 nonce 时组件卸载仍提交普通同意", async () => {
    const onDecision = vi.fn();
    let resolveGrant!: (nonce: string | null) => void;
    window.electron = {
      platform: "win32",
      isDesktop: true,
      requestConfirmRememberGrant: vi.fn(() => new Promise<string | null>((resolve) => {
        resolveGrant = resolve;
      })),
    };
    const rememberSpec: ConfirmSpec = {
      ...installSpec,
      rememberCategory: {
        kind: "install",
        label: "以后安装时不再询问",
      },
    };
    await renderOverlay(rememberSpec, onDecision);
    await click(host!.querySelector<HTMLInputElement>('.cf-remember input[type="checkbox"]')!);
    await click(findButton("安装并继续"));

    await act(async () => {
      root?.render(<div data-session="switched" />);
    });
    await act(async () => {
      resolveGrant(null);
      await Promise.resolve();
    });

    expect(onDecision).toHaveBeenCalledWith(
      {
        id: rememberSpec.id,
        accepted: true,
      },
      { componentMounted: false },
    );
  });

  it("日志脱敏同时剥掉 secret 与 UI grant nonce", () => {
    expect(stripSecretFromDecision({
      id: "confirm-sensitive",
      accepted: true,
      secretValue: "secret-sentinel",
      remember: true,
      uiGrantNonce: "nonce-sentinel",
    })).toEqual({ id: "confirm-sensitive", accepted: true, remember: true });
  });

  it("关闭按钮按拒绝语义回调", async () => {
    const onDecision = vi.fn();
    await renderOverlay(sendSpec, onDecision);

    await click(host!.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!);

    expect(onDecision).toHaveBeenCalledWith({
      id: sendSpec.id,
      accepted: false,
    });
  });

  it("options 默认选中推荐项，切换后主按钮带回 optionValue", async () => {
    const onDecision = vi.fn();
    await renderOverlay(optionsSpec, onDecision);
    const radios = host!.querySelectorAll<HTMLInputElement>('input[type="radio"]');

    expect(radios).toHaveLength(2);
    expect(radios[0]?.checked).toBe(true);
    expect(host?.querySelector(".cf-recommended")?.textContent).toBe("推荐");

    await click(radios[1]!);
    expect(radios[1]?.checked).toBe(true);
    await click(findButton("连接"));

    expect(onDecision).toHaveBeenCalledWith({
      id: optionsSpec.id,
      accepted: true,
      optionValue: "token",
    });
  });

  it("secretInput 只通过内存回调传值，不写入 DOM attribute", async () => {
    const onDecision = vi.fn();
    await renderOverlay(secretSpec, onDecision);
    const input = host!.querySelector<HTMLInputElement>(".cf-secret")!;
    const secret = "mizhu-secret-260716";

    await inputValue(input, secret);

    expect(input.type).toBe("password");
    expect(input.value).toBe(secret);
    expect(input.getAttribute("value")).toBeNull();
    expect(input.outerHTML).not.toContain(secret);
    await click(findButton("连接"));

    expect(onDecision).toHaveBeenCalledWith({
      id: secretSpec.id,
      accepted: true,
      secretValue: secret,
    });
  });

  it("dev 快捷键仅在 debugMode 生效并循环 demo", async () => {
    await render(<ConfirmHarness debugMode={false} />);
    await pressConfirmShortcut();
    expect(host?.querySelector(".cf-overlay")).toBeNull();

    await act(async () => {
      root?.render(<ConfirmHarness debugMode />);
    });
    await pressConfirmShortcut();
    expect(host?.querySelector(".cf-title")?.textContent).toBe("安装工具");
    await pressConfirmShortcut();
    expect(host?.querySelector(".cf-title")?.textContent).toBe("连接语雀");
    await pressConfirmShortcut();
    expect(host?.querySelector(".cf-title")?.textContent).toBe("连接墨潴笔记");
    await pressConfirmShortcut();
    expect(host?.querySelector(".cf-title")?.textContent).toBe("发布到公众号");
    await pressConfirmShortcut();
    expect(host?.querySelector(".cf-title")?.textContent).toBe("安装工具");
    expect(magicMoveFromRect).toHaveBeenCalled();
  });

  it("本地消费确认后显示记录条，console.debug 会剥掉 secretValue", async () => {
    const observedDecision = vi.fn();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    await render(<ConfirmHarness debugMode onDecision={observedDecision} />);
    await pressConfirmShortcut();
    await pressConfirmShortcut();
    await pressConfirmShortcut();
    const input = host!.querySelector<HTMLInputElement>(".cf-secret")!;
    const secret = "never-log-this-token";

    await inputValue(input, secret);
    await click(findButton("连接"));

    expect(observedDecision).toHaveBeenCalledWith({
      id: "confirm-demo-connect-mizhu",
      accepted: true,
      secretValue: secret,
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain(secret);
    expect(debug).toHaveBeenCalledWith("[confirm-card] decision", {
      id: "confirm-demo-connect-mizhu",
      accepted: true,
    });
    expect(host?.querySelector('[data-wf="ConfirmRecordBar"]')?.textContent).toContain(
      "已连接",
    );
    expect(host?.textContent).not.toContain(secret);
  });

  it("点执行后立即禁用全部动作并在原生确认与提交阶段保留标题和 loading", async () => {
    let resolveGrant!: (nonce: string | null) => void;
    const onDecision = vi.fn();
    window.electron = {
      platform: "win32",
      isDesktop: true,
      requestConfirmRememberGrant: vi.fn(() => new Promise<string | null>((resolve) => {
        resolveGrant = resolve;
      })),
    };
    const rememberSpec: ConfirmSpec = {
      ...installSpec,
      commandPreview: "npm install ffmpeg",
      rememberCategory: { kind: "install", label: "以后安装时不再询问" },
    };
    await render(
      <ConfirmOverlay
        sessionId="test-session"
        spec={rememberSpec}
        onDecision={onDecision}
        waitForResolution
      />,
    );

    await click(host!.querySelector<HTMLInputElement>('.cf-remember input[type="checkbox"]')!);
    await click(findButton("安装并继续"));

    expect(host?.querySelector(".cf-title")?.textContent).toBe("安装工具");
    expect(host?.querySelector(".cf-progress")?.textContent).toContain("正在确认…");
    expect(host?.querySelector(".cf-button-spinner")).not.toBeNull();
    expect(Array.from(host!.querySelectorAll<HTMLButtonElement>("button"))
      .every((button) => button.disabled)).toBe(true);
    expect(host!.querySelector<HTMLInputElement>('.cf-remember input[type="checkbox"]')?.disabled)
      .toBe(true);
    expect(onDecision).not.toHaveBeenCalled();

    await act(async () => {
      resolveGrant("trusted-nonce");
      await Promise.resolve();
    });

    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({
      id: rememberSpec.id,
      accepted: true,
      remember: true,
      uiGrantNonce: "trusted-nonce",
    }));
    expect(host?.querySelector(".cf-progress")?.textContent).toContain("正在执行…");
    expect(host?.querySelector(".cf-overlay")).not.toBeNull();
  });

  it("确认提交失败原卡显示原因并恢复按钮，不再换 key 静默重挂", async () => {
    let listener: ((frame: BridgeFrame) => void) | null = null;
    const resolveConfirm = vi.fn(async () => {
      throw new Error("确认没有提交成功，命令尚未确定是否执行。请先查看命令卡，不要连续重复点击。");
    });
    const stream = {
      subscribe: vi.fn((next: (frame: BridgeFrame) => void) => {
        listener = next;
        return () => { listener = null; };
      }),
      resolveConfirm,
    } as unknown as ServerStream;
    await render(<LiveConfirmHarness stream={stream} />);
    await act(async () => {
      listener?.({
        kind: "confirmRequested",
        data: {
          toolCallId: "tool-failed-post",
          spec: { ...installSpec, id: "confirm-failed-post" },
          requestedAt: "2026-07-22T10:00:00.000Z",
          expiresAt: "2026-07-22T10:10:00.000Z",
        },
      });
    });

    const overlayBefore = host!.querySelector(".cf-overlay");
    await click(findButton("安装并继续"));
    await act(async () => { await Promise.resolve(); });

    expect(host!.querySelector(".cf-overlay")).toBe(overlayBefore);
    expect(host?.querySelector('[role="alert"]')?.textContent)
      .toContain("确认没有提交成功，命令尚未确定是否执行。请先查看命令卡，不要连续重复点击。");
    expect(findButton("安装并继续").disabled).toBe(false);
  });

  it("仅首次成功创建记忆显示一次安全设置 toast，并消费 resolved message", async () => {
    let listener: ((frame: BridgeFrame) => void) | null = null;
    const grantEvents = vi.fn();
    const unsubscribe = subscribeRememberGrantState(grantEvents);
    const resolveConfirm = vi.fn(async () => ({
      accepted: true as const,
      remembered: true,
      grantState: { present: true, grantId: "grant-from-card", version: 4 },
    }));
    const stream = {
      subscribe: vi.fn((next: (frame: BridgeFrame) => void) => {
        listener = next;
        return () => { listener = null; };
      }),
      resolveConfirm,
    } as unknown as ServerStream;
    await render(<LiveConfirmHarness stream={stream} />);
    const rememberSpec: ConfirmSpec = {
      ...installSpec,
      id: "confirm-remember-toast",
      rememberCategory: {
        kind: "install",
        label: "以后安装时不再询问",
        insecureWithoutDesktop: true,
      },
    };
    await act(async () => {
      listener?.({
        kind: "confirmRequested",
        data: {
          toolCallId: "tool-remember-toast",
          spec: rememberSpec,
          requestedAt: "2026-07-22T10:00:00.000Z",
          expiresAt: "2026-07-22T10:10:00.000Z",
        },
      });
    });
    await click(host!.querySelector<HTMLInputElement>('.cf-remember input[type="checkbox"]')!);
    await click(findButton("安装并继续"));
    await act(async () => { await Promise.resolve(); });

    expect(host!.querySelectorAll(".qa-toast")).toHaveLength(1);
    expect(host?.querySelector(".qa-toast")?.textContent).toContain(
      "已记住：以后安装时不再询问。可在 设置 → 安全 中恢复每次询问。",
    );
    expect(grantEvents).toHaveBeenCalledWith({
      kind: "install",
      present: true,
      grantId: "grant-from-card",
      version: 4,
    });

    await act(async () => {
      listener?.({
        kind: "confirmResolved",
        data: {
          id: rememberSpec.id,
          toolCallId: "tool-remember-toast",
          resolution: "accepted",
          message: "本次操作已经开始执行。",
        },
      });
    });
    expect(host!.querySelectorAll(".qa-toast")).toHaveLength(2);
    expect(host?.textContent).toContain("本次操作已经开始执行。");
    unsubscribe();
  });

  it("服务端未保存记忆时解释本次继续与下次仍询问", async () => {
    let listener: ((frame: BridgeFrame) => void) | null = null;
    const stream = {
      subscribe: vi.fn((next: (frame: BridgeFrame) => void) => {
        listener = next;
        return () => { listener = null; };
      }),
      resolveConfirm: vi.fn(async () => ({
        accepted: true as const,
        remembered: false,
        rememberFailure: "settings-changed" as const,
        grantState: { present: false, grantId: null, version: 5 },
      })),
    } as unknown as ServerStream;
    await render(<LiveConfirmHarness stream={stream} />);
    const rememberSpec: ConfirmSpec = {
      ...installSpec,
      id: "confirm-remember-stale",
      rememberCategory: {
        kind: "install",
        label: "以后安装时不再询问",
        insecureWithoutDesktop: true,
      },
    };
    await act(async () => {
      listener?.({
        kind: "confirmRequested",
        data: {
          toolCallId: "tool-remember-stale",
          spec: rememberSpec,
          requestedAt: "2026-07-22T10:00:00.000Z",
          expiresAt: "2026-07-22T10:10:00.000Z",
        },
      });
    });

    await click(host!.querySelector<HTMLInputElement>('.cf-remember input[type="checkbox"]')!);
    await click(findButton("安装并继续"));
    await act(async () => { await Promise.resolve(); });

    expect(host?.querySelector(".qa-toast")?.textContent).toContain(
      "本次操作会继续，但设置刚刚发生变化，没有记住这次选择；下次同类操作仍会询问。",
    );
  });

  it("撤销竞态提示渲染在确认卡正文中", async () => {
    await renderOverlay({
      ...installSpec,
      notice: "设置刚刚发生变化，这次操作需要重新确认。",
    });

    expect(host?.querySelector(".cf-notice")?.textContent).toBe(
      "设置刚刚发生变化，这次操作需要重新确认。",
    );
  });

  it("确认过期 toast 提供重新确认入口", async () => {
    let listener: ((frame: BridgeFrame) => void) | null = null;
    const stream = {
      subscribe: vi.fn((next: (frame: BridgeFrame) => void) => {
        listener = next;
        return () => { listener = null; };
      }),
      resolveConfirm: vi.fn(),
    } as unknown as ServerStream;
    await render(<LiveConfirmHarness stream={stream} />);

    await act(async () => {
      listener?.({
        kind: "confirmResolved",
        data: {
          id: "confirm-expired-visible",
          toolCallId: "tool-expired-visible",
          resolution: "expired",
          message: "这张确认卡已过期，命令没有执行。请重新确认。",
        },
      });
    });

    expect(host?.querySelector(".qa-toast")?.textContent).toContain(
      "这张确认卡已过期，命令没有执行。请重新确认。",
    );
    expect(findButton("重新确认")).not.toBeNull();
  });

  it("命令确认未提供脚注时不渲染脚注且保留按钮区", async () => {
    const rememberSpec: ConfirmSpec = {
      ...installSpec,
      commandPreview: "npm install ffmpeg",
      rememberCategory: { kind: "install", label: "以后安装时不再询问" },
      footHint: undefined,
    };
    await renderOverlay(rememberSpec);
    expect(host?.querySelector(".cf-foot-hint")).toBeNull();
    expect(host?.querySelector(".cf-foot .cf-actions")).not.toBeNull();

    window.electron = {
      platform: "win32",
      isDesktop: true,
      requestConfirmRememberGrant: vi.fn(async () => "trusted-nonce"),
    };
    await act(async () => {
      root?.render(
        <ConfirmOverlay
          sessionId="test-session"
          spec={rememberSpec}
          onDecision={vi.fn()}
        />,
      );
    });
    expect(host?.querySelector(".cf-foot-hint")).toBeNull();
    expect(host?.querySelector(".cf-foot .cf-actions")).not.toBeNull();
  });

  it("真实 SSE 确认按 FIFO 展示，决策走专用上行且仅由 resolved 关闭", async () => {
    let listener: ((frame: BridgeFrame) => void) | null = null;
    const resolveConfirm = vi.fn(async () => ({ accepted: true as const, remembered: false }));
    const stream = {
      subscribe: vi.fn((next: (frame: BridgeFrame) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      }),
      resolveConfirm,
    } as unknown as ServerStream;
    await render(<LiveConfirmHarness stream={stream} />);
    const later = {
      ...installSpec,
      id: "confirm-live-later",
      title: "后到确认",
    };
    const firstRequested: BridgeFrame = {
      kind: "confirmRequested",
      data: {
        toolCallId: "tool-live-first",
        spec: { ...installSpec, id: "confirm-live-first", title: "先到确认" },
        requestedAt: "2026-07-16T10:00:00.000Z",
        expiresAt: "2026-07-16T10:10:00.000Z",
      },
    };
    const laterRequested: BridgeFrame = {
      kind: "confirmRequested",
      data: {
        toolCallId: "tool-live-later",
        spec: later,
        requestedAt: "2026-07-16T10:00:01.000Z",
        expiresAt: "2026-07-16T10:10:01.000Z",
      },
    };

    await act(async () => {
      listener?.(laterRequested);
      listener?.(firstRequested);
    });
    expect(host?.querySelector(".cf-title")?.textContent).toBe("先到确认");

    await click(findButton("安装并继续"));
    expect(resolveConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "live-session",
        toolCallId: "tool-live-first",
        decisionId: expect.any(String),
        decision: { id: "confirm-live-first", accepted: true },
      }),
      { activateSession: true },
    );
    expect(host?.querySelector(".cf-overlay")).not.toBeNull();

    await act(async () => {
      listener?.({
        kind: "confirmResolved",
        data: {
          id: "confirm-live-first",
          toolCallId: "tool-live-first",
          resolution: "accepted",
        },
      });
    });
    expect(host?.querySelector(".cf-title")?.textContent).toBe("后到确认");
  });

  it("等待原生 nonce 时切会话仍提交旧决策，但不把共享 SSE 拉回旧会话", async () => {
    let listener: ((frame: BridgeFrame) => void) | null = null;
    let resolveGrant!: (nonce: string | null) => void;
    const resolveConfirm = vi.fn(async () => ({ accepted: true as const, remembered: false }));
    const stream = {
      subscribe: vi.fn((next: (frame: BridgeFrame) => void) => {
        listener = next;
        return () => { listener = null; };
      }),
      resolveConfirm,
    } as unknown as ServerStream;
    window.electron = {
      platform: "win32",
      isDesktop: true,
      requestConfirmRememberGrant: vi.fn(() => new Promise<string | null>((resolve) => {
        resolveGrant = resolve;
      })),
    };
    const rememberSpec: ConfirmSpec = {
      ...installSpec,
      id: "confirm-old-session",
      rememberCategory: { kind: "install", label: "以后安装时不再询问" },
    };

    await render(<SwitchableLiveConfirmHarness sessionId="old-session" stream={stream} />);
    await act(async () => {
      listener?.({
        kind: "confirmRequested",
        data: {
          toolCallId: "tool-old-session",
          spec: rememberSpec,
          requestedAt: "2026-07-22T10:00:00.000Z",
          expiresAt: "2026-07-22T10:10:00.000Z",
        },
      });
    });
    await click(host!.querySelector<HTMLInputElement>('.cf-remember input[type="checkbox"]')!);
    await click(findButton("安装并继续"));

    await act(async () => {
      root?.render(<SwitchableLiveConfirmHarness sessionId="new-session" stream={stream} />);
    });
    await act(async () => {
      resolveGrant("nonce-for-old-session");
      await Promise.resolve();
    });

    expect(resolveConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "old-session",
        toolCallId: "tool-old-session",
        decision: expect.objectContaining({
          id: "confirm-old-session",
          accepted: true,
          uiGrantNonce: "nonce-for-old-session",
        }),
      }),
      { activateSession: false },
    );
  });
});

function ConfirmHarness({
  debugMode,
  onDecision,
}: {
  debugMode: boolean;
  onDecision?: (decision: ConfirmDecision) => void;
}) {
  const inputBoxRef = useRef<HTMLDivElement>(null);
  const { confirmRecord, handleConfirmDecision, inlineConfirm } = useConfirmCard({
    debugMode,
    sessionId: "test-session",
  });
  return (
    <section id="view-workspace">
      <div ref={inputBoxRef} className="ws-input-morph">
        <div className="wf-input" />
      </div>
      {confirmRecord && <ConfirmRecordBar record={confirmRecord} />}
      {inlineConfirm && (
        <ConfirmOverlay
          key={inlineConfirm.id}
          sessionId="test-session"
          spec={inlineConfirm}
          inputBoxRef={inputBoxRef}
          onDecision={(decision) => {
            onDecision?.(decision);
            handleConfirmDecision(decision);
          }}
        />
      )}
    </section>
  );
}

function LiveConfirmHarness({ stream }: { stream: ServerStream }) {
  return (
    <ToastProvider>
      <LiveConfirmContent stream={stream} />
    </ToastProvider>
  );
}

function LiveConfirmContent({ stream }: { stream: ServerStream }) {
  const {
    handleConfirmDecision,
    inlineConfirm,
    decisionError,
    isLiveConfirm,
  } = useConfirmCard({
    debugMode: false,
    sessionId: "live-session",
    stream,
  });
  return inlineConfirm
    ? (
      <ConfirmOverlay
        sessionId="live-session"
        spec={inlineConfirm}
        onDecision={handleConfirmDecision}
        submissionError={decisionError}
        waitForResolution={isLiveConfirm}
      />
    )
    : null;
}

function SwitchableLiveConfirmHarness({
  sessionId,
  stream,
}: {
  sessionId: string;
  stream: ServerStream;
}) {
  const {
    handleConfirmDecision,
    inlineConfirm,
    decisionError,
    isLiveConfirm,
  } = useConfirmCard({
    debugMode: false,
    sessionId,
    stream,
  });
  return inlineConfirm
    ? (
      <ConfirmOverlay
        sessionId={sessionId}
        spec={inlineConfirm}
        onDecision={handleConfirmDecision}
        submissionError={decisionError}
        waitForResolution={isLiveConfirm}
      />
    )
    : null;
}

async function renderOverlay(
  spec: ConfirmSpec,
  onDecision: (decision: ConfirmDecision) => void = vi.fn(),
): Promise<void> {
  await render(<ConfirmOverlay sessionId="test-session" spec={spec} onDecision={onDecision} />);
}

async function render(element: ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

async function inputValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressConfirmShortcut(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "U",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(
    host?.querySelectorAll<HTMLButtonElement>("button") ?? [],
  ).find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error(`按钮不存在:${label}`);
  return button;
}

// @vitest-environment jsdom

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
import { useConfirmCard } from "../hooks/useConfirmCard";
import { magicMoveFromRect, magicMoveToRect } from "../data/barMorph";
import type { ServerStream } from "../data/serverStream";

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
    expect(overlay.textContent).toContain(spec.footHint);
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
      root?.render(<ConfirmOverlay spec={installSpec} onDecision={vi.fn()} />);
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

  it("真实 SSE 确认按 FIFO 展示，决策走专用上行且仅由 resolved 关闭", async () => {
    let listener: ((frame: BridgeFrame) => void) | null = null;
    const resolveConfirm = vi.fn(async () => undefined);
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
    expect(resolveConfirm).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "live-session",
      toolCallId: "tool-live-first",
      decisionId: expect.any(String),
      decision: { id: "confirm-live-first", accepted: true },
    }));
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
  const { handleConfirmDecision, inlineConfirm } = useConfirmCard({
    debugMode: false,
    sessionId: "live-session",
    stream,
  });
  return inlineConfirm
    ? <ConfirmOverlay spec={inlineConfirm} onDecision={handleConfirmDecision} />
    : null;
}

async function renderOverlay(
  spec: ConfirmSpec,
  onDecision: (decision: ConfirmDecision) => void = vi.fn(),
): Promise<void> {
  await render(<ConfirmOverlay spec={spec} onDecision={onDecision} />);
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

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingSettingsProvider } from "../../../system/onboarding/OnboardingSettingsContext";
import type { WorkspacePageController } from "../hooks/useWorkspacePageController";
import { WorkspaceChatPane } from "./WorkspaceChatPane";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./ChatInput", async () => {
  const React = await import("react");
  return {
    ChatInput: React.forwardRef<HTMLDivElement, {
      suppressModelKeyTip?: boolean;
      placeholder?: string;
      showStop?: boolean;
      disabled?: boolean;
    }>(
      function MockChatInput(props, ref) {
        return (
          <div
            ref={ref}
            data-chat-input
            data-suppress-model-key-tip={String(props.suppressModelKeyTip)}
            data-placeholder={props.placeholder}
            data-show-stop={String(props.showStop)}
            data-disabled={String(props.disabled)}
          />
        );
      },
    ),
  };
});
vi.mock("./ChatMessageList", () => ({
  ChatMessageList: () => null,
  shouldShowPreTokenLoading: () => false,
}));
vi.mock("./AskUserOverlay", () => ({ AskUserOverlay: () => null }));
vi.mock("./ConfirmOverlay", () => ({
  ConfirmOverlay: () => null,
  ConfirmRecordBar: () => null,
}));
vi.mock("./RightPane", () => ({ extractAskUser: () => null }));
vi.mock("./ScrollToBottomButton", () => ({ ScrollToBottomButton: () => null }));
vi.mock("./TaskPill", () => ({ TaskPill: () => null }));
vi.mock("../hooks/useConfirmCard", () => ({
  useConfirmCard: () => ({
    confirmRecord: null,
    handleConfirmDecision: vi.fn(),
    inlineConfirm: null,
    decisionError: null,
    isLiveConfirm: false,
  }),
}));

let host: HTMLDivElement;
let root: Root;

describe("WorkspaceChatPane coach 与模型 key 提示接棒", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.querySelectorAll("[data-coach-mark]").forEach((node) => node.remove());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("editor-input coach 未读时优先展示，并抑制相邻的缺 key 提示", async () => {
    await renderPane([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(document.querySelector('[data-coach-mark="editor-input"]')).not.toBeNull();
    expect(host.querySelector<HTMLElement>("[data-chat-input]")?.dataset.suppressModelKeyTip).toBe("true");
  });

  it("editor-input coach 已读后解除抑制，让缺 key 提示接棒", async () => {
    await renderPane(["editor-input"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(host.querySelector<HTMLElement>("[data-chat-input]")?.dataset.suppressModelKeyTip).toBe("false");
    expect(document.querySelector('[data-coach-mark="editor-input"]')).toBeNull();
  });

  it("外部编辑时显示插件提示且不呈现停止按钮", async () => {
    await renderPane(["editor-input"], true);

    const input = host.querySelector<HTMLElement>("[data-chat-input]");
    expect(input?.dataset.placeholder).toBe("青简插件正在编辑");
    expect(input?.dataset.disabled).toBe("true");
    expect(input?.dataset.showStop).toBe("false");
  });
});

async function renderPane(coachSeen: string[], externalEditing = false): Promise<void> {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({
    state: { status: "done", completedAt: "2026-08-18T00:00:00.000Z" },
    coachSeen,
  })));

  await act(async () => {
    root.render(
      <OnboardingSettingsProvider>
        <WorkspaceChatPane controller={createController(externalEditing)} />
      </OnboardingSettingsProvider>,
    );
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

function createController(externalEditing = false): WorkspacePageController {
  const emptyRef = createRef<HTMLDivElement>();
  return {
    state: {
      sessionId: "session-coach-test",
      messages: [],
      streamActive: false,
      externalEditing,
      todos: [],
    },
    effectivePatchRevealing: false,
    reviewUiState: { livePatchCount: 0 },
    liveHunkKey: null,
    wholeDocReview: null,
    wholeDocReviewKeysRef: { current: [] },
    chatScrollRef: emptyRef,
    debugMode: false,
    inputHandedOff: false,
    inputMorphRef: emptyRef,
    chatInputEditorDisabled: externalEditing,
    inputContentOut: false,
    chatInputRef: { current: null },
    chatInputPlaceholder: externalEditing ? "青简插件正在编辑" : "告诉青简写什么",
    agentActive: externalEditing,
    chatInputSendEnabledWhenDisabled: false,
    handleSubmitChat: vi.fn(),
    handleCancelActiveStream: vi.fn(),
    setPreviewSource: vi.fn(),
    handleRemoveMaterial: vi.fn(),
    showToast: vi.fn(),
    folderSource: null,
    folderCapability: { status: "unsupported" },
    handleAttachFolder: vi.fn(async () => undefined),
    handleDetachFolder: vi.fn(async () => undefined),
    materialParseRows: [],
    handleRetryMaterialParse: vi.fn(),
    materialPanelOpenSignal: 0,
    hasModelKey: false,
    modelKeyGate: {
      status: "unconfigured",
      provider: "deepseek",
      fallbackProvider: null,
    },
    handleBackHome: vi.fn(),
    inlineAsk: null,
    handleCancelAskUser: vi.fn(),
    handleSubmitAskUserAnswers: vi.fn(),
    streamRef: { current: null },
    hydration: { phase: "ready" },
  } as unknown as WorkspacePageController;
}

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../system/ToastProvider";
import { HomeSettingsSheet } from "./HomeSettingsSheet";

vi.mock("./settingsInkVariants", () => ({
  SettingsInkBackdrop: () => <div data-testid="ink-backdrop" />,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("HomeSettingsSheet 安全页", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("安全 Tab 接入真实开关面板，撤销默认同意不要求 nonce", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        categories: [
          { kind: "install", label: "安装指令", needConfirmation: true, mutable: true, present: false, grantId: null, version: 0 },
          { kind: "command", label: "此类命令", needConfirmation: false, mutable: true, present: true, grantId: "grant-command", version: 1 },
          { kind: "send", label: "外发指令", needConfirmation: true, mutable: false, present: false, grantId: null, version: 0 },
          { kind: "connect", label: "连接账号", needConfirmation: true, mutable: false, present: false, grantId: null, version: 0 },
        ],
        insecureRememberAllowed: true,
      }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({
        kind: "command",
        needConfirmation: true,
        present: false,
        grantId: null,
        version: 2,
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ToastProvider>
          <HomeSettingsSheet
            initialTab="security"
            inkVariant="paper"
            themeMode="paper"
            themeModeOptions={[{ id: "paper", label: "宣纸" }]}
            anim="none"
            animOptions={[{ id: "none", label: "无" }]}
            reduceMotion={false}
            primaryFont="song"
            secondaryFont="song"
            fontOptions={[{ id: "song", label: "宋体" }]}
            onThemeModeChange={vi.fn()}
            onAnimChange={vi.fn()}
            onReduceMotionToggle={vi.fn()}
            onPrimaryFontChange={vi.fn()}
            onSecondaryFontChange={vi.fn()}
            onClose={vi.fn()}
          />
        </ToastProvider>,
      );
    });

    const securityTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent === "安全");
    expect(securityTab?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[data-wf="SecurityPanel"]')).not.toBeNull();

    const command = host.querySelector<HTMLButtonElement>('[aria-label="此类命令需要确认"]')!;
    await act(async () => {
      command.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/settings/security/command",
      expect.objectContaining({ body: JSON.stringify({ needConfirmation: true }) }),
    );
  });
});

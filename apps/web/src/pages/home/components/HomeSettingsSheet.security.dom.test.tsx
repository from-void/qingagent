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

  it("安全 Tab 接入真实授权下拉，恢复每次询问调用设置端点", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          operationId: string;
          baseVersion: number;
        };
        return new Response(JSON.stringify({
          kind: "command",
          grantMode: "ask",
          present: false,
          grantId: null,
          version: 2,
          operationId: body.operationId,
          baseVersion: body.baseVersion,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        categories: [
          { kind: "install", label: "安装", grantMode: "ask", grantModes: ["ask", "always"], present: false, grantId: null, version: 0 },
          { kind: "command", label: "同类操作", grantMode: "always", grantModes: ["ask", "always"], present: true, grantId: "grant-command", version: 1 },
          { kind: "send", label: "向外发送内容", grantMode: "ask", grantModes: ["ask"], present: false, grantId: null, version: 0 },
          { kind: "connect", label: "连接账号", grantMode: "ask", grantModes: ["ask"], present: false, grantId: null, version: 0 },
        ],
      }), { status: 200 });
    });
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

    const command = host.querySelector<HTMLButtonElement>('button[aria-label="同类操作的确认方式"]')!;
    await act(async () => {
      command.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const askOption = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((button) => button.textContent?.includes("每次询问"));
    expect(askOption).toBeDefined();
    await act(async () => {
      askOption!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/settings/security/command",
      expect.objectContaining({ body: expect.any(String) }),
    );
    const [, request] = fetchMock.mock.calls.at(-1)!;
    expect(JSON.parse(String(request?.body))).toMatchObject({
      grantMode: "ask",
      operationId: expect.any(String),
      baseVersion: 1,
    });
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecurityPanel } from "./SecurityPanel";

const toast = vi.fn();
const toastApi = { show: toast, dismiss: vi.fn() };
vi.mock("../../system/ToastProvider", () => ({
  useToast: () => toastApi,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const categories = [
  { kind: "install", label: "安装指令", needConfirmation: true, mutable: true },
  { kind: "command", label: "此类命令", needConfirmation: false, mutable: true },
  { kind: "send", label: "外发指令", needConfirmation: true, mutable: false },
  { kind: "connect", label: "连接账号", needConfirmation: true, mutable: false },
];

async function renderPanel(insecureRememberAllowed = false) {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(response({ categories, insecureRememberAllowed }))
    .mockResolvedValue(response({}));
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<SecurityPanel />);
  });
  return fetchMock;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("SecurityPanel", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    delete window.electron;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("列出四类开关，send/connect 显示始终确认且不可切换", async () => {
    await renderPanel();
    const buttons = [...host!.querySelectorAll<HTMLButtonElement>(".security-toggle")];
    expect(buttons).toHaveLength(4);
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual([
      "true", "false", "true", "true",
    ]);
    expect(buttons[2]?.disabled).toBe(true);
    expect(buttons[3]?.disabled).toBe(true);
    expect(buttons[2]?.textContent).toContain("始终确认");
  });

  it("恢复 command 确认无需可信 UI nonce，并更新开关", async () => {
    const fetchMock = await renderPanel();
    const command = host!.querySelector<HTMLButtonElement>('[aria-label="此类命令需要确认"]')!;
    await click(command);

    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/settings/security/command",
      expect.objectContaining({ body: JSON.stringify({ needConfirmation: true }) }),
    );
    expect(command.getAttribute("aria-pressed")).toBe("true");
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" }));
  });

  it("纯 web 安全模式下拒绝关闭确认，不发设置写请求", async () => {
    const fetchMock = await renderPanel();
    const install = host!.querySelector<HTMLButtonElement>('[aria-label="安装指令需要确认"]')!;
    await click(install);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "warn" }));
  });

  it("显式不安全开发模式允许预配置默认同意", async () => {
    const fetchMock = await renderPanel(true);
    const install = host!.querySelector<HTMLButtonElement>('[aria-label="安装指令需要确认"]')!;
    await click(install);

    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/settings/security/install",
      expect.objectContaining({ body: JSON.stringify({ needConfirmation: false }) }),
    );
    expect(install.getAttribute("aria-pressed")).toBe("false");
  });
});

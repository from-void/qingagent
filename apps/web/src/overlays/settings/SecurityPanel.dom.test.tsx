// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecurityPanel } from "./SecurityPanel";
import { publishRememberGrantState } from "../../system/confirmGrantState";

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
  { kind: "install", label: "安装", needConfirmation: true, mutable: true, present: false, grantId: null, version: 0 },
  { kind: "command", label: "同类操作", needConfirmation: false, mutable: true, present: true, grantId: "grant-command", version: 1 },
  { kind: "send", label: "向外发送内容", needConfirmation: true, mutable: false, present: false, grantId: null, version: 0 },
  { kind: "connect", label: "连接账号", needConfirmation: true, mutable: false, present: false, grantId: null, version: 0 },
];

async function renderPanel(insecureRememberAllowed = false) {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(response({ categories, insecureRememberAllowed }))
    .mockImplementation(async (input, init) => {
      if (!init?.method || init.method === "GET") {
        return response({ categories, insecureRememberAllowed });
      }
      const kind = String(input).split("/").at(-1) as "install" | "command";
      const body = JSON.parse(String(init?.body)) as { needConfirmation: boolean };
      return response({
        kind,
        needConfirmation: body.needConfirmation,
        present: !body.needConfirmation,
        grantId: body.needConfirmation ? null : `grant-${kind}`,
        version: kind === "command" ? 2 : 1,
      });
    });
  await renderWithFetch(fetchMock);
  return fetchMock;
}

async function renderWithFetch(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) {
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<SecurityPanel />);
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function installToggle(): HTMLButtonElement {
  return host!.querySelector<HTMLButtonElement>('button[aria-label^="安装："]')!;
}

function commandToggle(): HTMLButtonElement {
  return host!.querySelector<HTMLButtonElement>('button[aria-label^="同类操作："]')!;
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

  it("统一安全文案与类别范围，send/connect 用可解释固定状态而非灰态按钮", async () => {
    await renderPanel();
    const buttons = [...host!.querySelectorAll<HTMLButtonElement>(".security-toggle")];
    expect(buttons).toHaveLength(2);
    expect(host!.querySelector(".security-head h2")?.textContent).toBe("操作确认");
    expect(host!.querySelector(".security-scope-note")?.textContent).toBe(
      "按操作类别分别生效，改一类不影响其他。",
    );
    expect(host!.querySelector("#security-command-scope")?.textContent).toBe(
      "仅影响会删除、移动或产生多种影响的操作，普通命令不受影响。",
    );
    expect(installToggle().getAttribute("aria-label")).toBe(
      "安装：每次询问，点击后改为之后不再询问",
    );
    expect(commandToggle().getAttribute("aria-label")).toBe(
      "同类操作：之后不再询问，点击后恢复每次询问",
    );
    expect(commandToggle().getAttribute("aria-describedby")).toContain("security-command-scope");

    const fixedStates = [...host!.querySelectorAll<HTMLElement>(".security-fixed-state")];
    expect(fixedStates).toHaveLength(2);
    expect(fixedStates.every((item) => item.tagName === "SPAN")).toBe(true);
    expect(fixedStates.map((item) => item.textContent?.trim())).toEqual(["每次询问", "每次询问"]);
    expect(fixedStates[0]?.getAttribute("aria-describedby")).toBe("security-send-reason");
    expect(fixedStates[1]?.getAttribute("aria-describedby")).toBe("security-connect-reason");
    expect(host!.querySelector("#security-send-reason")?.textContent).toBe(
      "发出后不能撤回，所以每次都会询问。",
    );
    expect(host!.querySelector("#security-connect-reason")?.textContent).toBe(
      "连接会改变可访问的内容，所以每次连接前都会询问。",
    );
  });

  it("恢复 command 确认无需可信 UI nonce，并更新开关", async () => {
    window.electron = {
      platform: "win32",
      isDesktop: true,
      requestSettingsRememberGrant: vi.fn(async () => "unused-for-revoke"),
    };
    const fetchMock = await renderPanel();
    const command = commandToggle();
    await click(command);

    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/settings/security/command",
      expect.objectContaining({ body: JSON.stringify({ needConfirmation: true }) }),
    );
    expect(command.getAttribute("aria-pressed")).toBe("true");
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      tone: "success",
      message: "同类操作已恢复每次询问。已在执行的不受影响。",
    }));
  });

  it("纯 web 生产把记忆设置收敛为只读并解释桌面条件", async () => {
    const fetchMock = await renderPanel();
    const install = installToggle();
    await click(install);

    expect(install.disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host?.querySelector("#security-desktop-note")?.textContent).toContain(
      "开启记忆需要在桌面应用中完成确认。",
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it("显式不安全开发模式允许设为之后不再询问", async () => {
    const fetchMock = await renderPanel(true);
    const install = installToggle();
    expect(host?.textContent).not.toContain("不安全");
    await click(install);

    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/settings/security/install",
      expect.objectContaining({ body: JSON.stringify({ needConfirmation: false }) }),
    );
    expect(install.getAttribute("aria-pressed")).toBe("false");
    expect(toast).toHaveBeenCalledWith({
      message: "安装之后不再询问。",
      tone: "success",
    });
  });

  it("桌面自绘确认取消时保留每次询问并给出提示", async () => {
    const requestGrant = vi.fn(async () => null);
    window.electron = {
      platform: "win32",
      isDesktop: true,
      requestSettingsRememberGrant: requestGrant,
    };
    const fetchMock = await renderPanel();
    const install = installToggle();

    await click(install);

    expect(requestGrant).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(install.getAttribute("aria-pressed")).toBe("true");
    expect(toast).toHaveBeenCalledWith({
      message: "没有完成确认，设置未更改。",
      tone: "warn",
    });
  });

  it("桌面原生确认调用失败时使用非术语化提示", async () => {
    window.electron = {
      platform: "win32",
      isDesktop: true,
      requestSettingsRememberGrant: vi.fn(async () => {
        throw new Error("desktop unavailable");
      }),
    };
    const fetchMock = await renderPanel();
    const install = installToggle();

    await click(install);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith({
      message: "没有完成确认，设置未更改。",
      tone: "warn",
    });
  });

  it("桌面能力与 insecure 同时存在时仍优先请求一次性 nonce", async () => {
    const requestGrant = vi.fn(async () => "desktop-first-nonce");
    window.electron = {
      platform: "win32",
      isDesktop: true,
      requestSettingsRememberGrant: requestGrant,
    };
    const fetchMock = await renderPanel(true);
    const install = installToggle();

    await click(install);

    expect(requestGrant).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/settings/security/install",
      expect.objectContaining({
        body: JSON.stringify({
          needConfirmation: false,
          uiGrantNonce: "desktop-first-nonce",
        }),
      }),
    );
  });

  it("卡侧记忆状态事件让已打开设置页按版本立即更新", async () => {
    await renderPanel();
    const install = installToggle();
    expect(install.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      publishRememberGrantState({
        kind: "install",
        present: true,
        grantId: "grant-from-card",
        version: 3,
      });
    });

    expect(install.getAttribute("aria-pressed")).toBe("false");
  });

  it("窗口重获焦点时 GET 重读并采用更新的 canonical 状态", async () => {
    const focusedCategories = categories.map((item) => item.kind === "install"
      ? { ...item, needConfirmation: false, present: true, grantId: "grant-focus", version: 4 }
      : item);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ categories, insecureRememberAllowed: false }))
      .mockResolvedValueOnce(response({ categories: focusedCategories, insecureRememberAllowed: false }));
    await renderWithFetch(fetchMock);
    const install = installToggle();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(install.getAttribute("aria-pressed")).toBe("false");
  });

  it("设置加载失败使用统一提示", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    await renderWithFetch(fetchMock);
    await act(async () => { await Promise.resolve(); });

    expect(toast).toHaveBeenCalledWith({
      message: "设置加载失败，请稍后再试",
      tone: "error",
    });
  });

  it("POST 失败后 GET 重校准，且旧 callback 不能覆盖较新版本", async () => {
    const canonicalAfterFailure = categories.map((item) => item.kind === "install"
      ? { ...item, needConfirmation: false, present: true, grantId: "grant-server", version: 5 }
      : item);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ categories, insecureRememberAllowed: true }))
      .mockResolvedValueOnce(response({ error: "timeout" }, 504))
      .mockResolvedValueOnce(response({ categories: canonicalAfterFailure, insecureRememberAllowed: true }));
    await renderWithFetch(fetchMock);
    const install = installToggle();

    await click(install);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(toast).toHaveBeenCalledWith({
      message: "设置保存失败，请再试一次",
      tone: "error",
    });
    expect(install.closest(".security-row")?.getAttribute("data-update-state")).toBe("settled");
    expect(install.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      publishRememberGrantState({
        kind: "install",
        present: false,
        grantId: null,
        version: 7,
      });
      publishRememberGrantState({
        kind: "install",
        present: true,
        grantId: "stale-callback",
        version: 6,
      });
    });
    expect(install.getAttribute("aria-pressed")).toBe("true");
  });
});

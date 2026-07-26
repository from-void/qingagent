// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishRememberGrantState } from "../../system/confirmGrantState";
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
  { kind: "install", label: "安装", grantMode: "ask", grantModes: ["ask", "always"], present: false, grantId: null, version: 0 },
  { kind: "command", label: "同类操作", grantMode: "always", grantModes: ["ask", "always"], present: true, grantId: "grant-command", version: 1 },
  { kind: "send", label: "向外发送内容", grantMode: "ask", grantModes: ["ask"], present: false, grantId: null, version: 0 },
  { kind: "connect", label: "连接账号", grantMode: "ask", grantModes: ["ask"], present: false, grantId: null, version: 0 },
];

async function renderPanel() {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(response({ categories }))
    .mockImplementation(async (input, init) => {
      if (!init?.method || init.method === "GET") return response({ categories });
      const kind = String(input).split("/").at(-1) as "install" | "command";
      const body = JSON.parse(String(init.body)) as { grantMode: "ask" | "always" };
      return response({
        kind,
        grantMode: body.grantMode,
        present: body.grantMode === "always",
        grantId: body.grantMode === "always" ? `grant-${kind}` : null,
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

async function choose(select: HTMLButtonElement, value: "ask" | "always") {
  await act(async () => {
    select.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const label = value === "always" ? "总是允许" : "每次询问";
  const option = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((node) => node.textContent?.includes(label));
  expect(option).toBeDefined();
  await act(async () => {
    option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function categorySelect(label: string): HTMLButtonElement {
  return host!.querySelector<HTMLButtonElement>(`button[aria-label="${label}的确认方式"]`)!;
}

describe("SecurityPanel", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("每类一行使用暗墨自定义下拉，说明无重复状态且采用暗底说明色", async () => {
    await renderPanel();

    const selects = [...host!.querySelectorAll<HTMLElement>(".security-select")];
    expect(selects).toHaveLength(4);
    expect(selects.every((select) => select.classList.contains("skin-select--ink"))).toBe(true);
    expect(categorySelect("安装").textContent).toContain("每次询问");
    expect(categorySelect("同类操作").textContent).toContain("总是允许");
    expect(categorySelect("向外发送内容").disabled).toBe(true);
    expect(categorySelect("连接账号").disabled).toBe(true);
    expect(host!.querySelector("select")).toBeNull();

    const copies = [...host!.querySelectorAll<HTMLElement>(".security-copy")];
    expect(copies.every((copy) => !copy.textContent?.includes("每次询问"))).toBe(true);
    expect(host!.querySelector("#security-command-description")?.textContent).toContain(
      "普通命令不受影响",
    );
    expect(host!.querySelector("#security-command-effect")?.textContent).toContain(
      "之后同类操作直接执行",
    );

    const css = readFileSync(
      resolve(process.cwd(), "src/overlays/settings/settings.css"),
      "utf8",
    );
    expect(css).toMatch(/\.security-description\{[^}]*color:var\(--ink-desc\)/);
    expect(css).toMatch(/\.security-description\{[^}]*font-size:13px/);
  });

  it("改回每次询问调用 revoke 语义并给出轻提示", async () => {
    const fetchMock = await renderPanel();
    const command = categorySelect("同类操作");
    await choose(command, "ask");

    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/settings/security/command",
      expect.objectContaining({ body: JSON.stringify({ grantMode: "ask" }) }),
    );
    expect(command.textContent).toContain("每次询问");
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      tone: "success",
      message: "同类操作已恢复每次询问。已在执行的不受影响。",
    }));
  });

  it("未走过确认卡也能直接选总是允许并显示生效语义", async () => {
    const fetchMock = await renderPanel();
    const install = categorySelect("安装");
    await choose(install, "always");

    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/settings/security/install",
      expect.objectContaining({ body: JSON.stringify({ grantMode: "always" }) }),
    );
    expect(install.textContent).toContain("总是允许");
    expect(host!.querySelector("#security-install-effect")?.textContent).toContain(
      "已记住，之后同类操作直接执行；可随时改回。",
    );
    expect(toast).toHaveBeenCalledWith({
      message: "安装已设为总是允许。",
      tone: "success",
    });
  });

  it("卡侧状态事件按版本立即更新已打开的下拉", async () => {
    await renderPanel();
    const install = categorySelect("安装");
    expect(install.textContent).toContain("每次询问");

    await act(async () => {
      publishRememberGrantState({
        kind: "install",
        present: true,
        grantId: "grant-from-card",
        version: 3,
      });
    });
    expect(install.textContent).toContain("总是允许");
  });

  it("窗口重获焦点时重读 canonical 状态", async () => {
    const focusedCategories = categories.map((item) => item.kind === "install"
      ? { ...item, grantMode: "always", present: true, grantId: "grant-focus", version: 4 }
      : item);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ categories }))
      .mockResolvedValueOnce(response({ categories: focusedCategories }));
    await renderWithFetch(fetchMock);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(categorySelect("安装").textContent).toContain("总是允许");
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

  it("POST 失败后 GET 重校准，旧事件不能覆盖较新版本", async () => {
    const canonicalAfterFailure = categories.map((item) => item.kind === "install"
      ? { ...item, grantMode: "always", present: true, grantId: "grant-server", version: 5 }
      : item);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ categories }))
      .mockResolvedValueOnce(response({ error: "timeout" }, 504))
      .mockResolvedValueOnce(response({ categories: canonicalAfterFailure }));
    await renderWithFetch(fetchMock);
    await choose(categorySelect("安装"), "always");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(toast).toHaveBeenCalledWith({
      message: "设置保存失败，请再试一次",
      tone: "error",
    });
    expect(categorySelect("安装").textContent).toContain("总是允许");

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
    expect(categorySelect("安装").textContent).toContain("每次询问");
  });
});

// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../system/ToastProvider";
import { AboutPanel } from "./AboutPanel";
import { DshPanel } from "./DshPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const INSTALL_COMMAND = "npx @deepseek-ai/dsh plugin --profile web add dsh-qingagent@latest";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("DSH 插件设置页", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    Object.defineProperty(window, "electron", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    vi.restoreAllMocks();
  });

  it("按这是什么、安装、青简引擎、怎么用、插件仓库五段顺序渲染", async () => {
    await render(<DshPanel />);

    expect(host?.querySelector('[data-wf="DshPanel"]')).not.toBeNull();
    expect(Array.from(host?.querySelectorAll(".dsh-section-title") ?? []).map(
      (title) => title.textContent,
    )).toEqual(["这是什么", "安装", "青简引擎", "怎么用", "插件仓库"]);
    expect(host?.textContent).toContain("DSH(DeepSeek Harness)是 DeepSeek 官方的终端 Agent 环境");
    expect(host?.textContent).toContain("启动 DSH");
    expect(host?.textContent).toContain("把《XX 方案》第三节改得更紧凑,给我审");
    expect(host?.textContent).toContain("起草一份面向投资人的产品 PRD,写完让我逐条过");

    const repo = host?.querySelector<HTMLAnchorElement>('[data-wf="DshRepository"]');
    expect(repo?.getAttribute("href")).toBe("https://github.com/void2anything/dsh-qingagent");
    expect(repo?.getAttribute("target")).toBe("_blank");
    expect(host?.querySelector('[data-wf="DshStarInvite"]')?.textContent).toContain("给个 Star");
  });

  it("复制按钮把完整安装命令写入剪贴板并走全局 toast", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await render(<DshPanel />);

    await click(getButton("DshCopyCommand"));

    expect(writeText).toHaveBeenCalledWith(INSTALL_COMMAND);
    expect(host?.querySelector('[data-wf="GlobalToast"]')?.textContent).toContain("安装命令已复制");
  });

  it("桌面端未检测到 DSH 时保持原三步安装引导", async () => {
    installDshElectron(async () => ({
      detected: false,
      profiles: [],
      defaultProfile: null,
      npxAvailable: false,
    }));
    await render(<DshPanel />);
    await settle();

    expect(host?.textContent).toContain("启动 DSH");
    expect(host?.textContent).toContain("保持青简客户端运行");
    expect(host?.textContent).not.toContain("一键安装插件");
  });

  it("检测到 DSH 但未装插件时默认 web profile，并显示一键安装", async () => {
    installDshElectron(async () => ({
      detected: true,
      profiles: [
        { name: "writer", bundles: ["dsh-writer"], pluginVersion: null },
        { name: "web", bundles: ["dsh-web-app"], pluginVersion: null },
      ],
      defaultProfile: "web",
      npxAvailable: true,
    }));
    await render(<DshPanel />);
    await settle();

    expect(host?.textContent).toContain("已检测到 DSH");
    expect(getButton("DshInstallPlugin").textContent).toContain("一键安装插件");
    const profile = host?.querySelector<HTMLSelectElement>('[data-wf="DshProfileSelect"]');
    expect(profile?.value).toBe("web");
    expect(host?.querySelector('[data-wf="DshInstallCommand"]')?.textContent).toContain(INSTALL_COMMAND);
  });

  it("已安装插件时展示版本与更新按钮", async () => {
    installDshElectron(async () => ({
      detected: true,
      profiles: [{ name: "web", bundles: ["dsh-web-app"], pluginVersion: "0.1.21" }],
      defaultProfile: "web",
      npxAvailable: true,
    }));
    await render(<DshPanel />);
    await settle();

    expect(host?.textContent).toContain("✓ 插件已安装 · v0.1.21");
    const updateButton = getButton("DshInstallPlugin");
    expect(updateButton.textContent).toContain("更新到最新");
    expect(updateButton.classList.contains("dsh-install-button--secondary")).toBe(false);
  });

  it("执行安装时禁用按钮，结束后展示输出摘要", async () => {
    let finishInstall: ((value: unknown) => void) | null = null;
    const install = vi.fn(() => new Promise((resolve) => {
      finishInstall = resolve;
    }));
    installDshElectron(
      async () => ({
        detected: true,
        profiles: [{ name: "web", bundles: ["dsh-web-app"], pluginVersion: null }],
        defaultProfile: "web",
        npxAvailable: true,
      }),
      install,
    );
    await render(<DshPanel />);
    await settle();

    const button = getButton("DshInstallPlugin");
    await click(button);
    await settle();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("正在安装");
    expect(install).toHaveBeenCalledWith("web");

    await act(async () => {
      finishInstall?.({
        ok: true,
        profile: "web",
        command: INSTALL_COMMAND,
        output: "added dsh-qingagent@0.1.22",
      });
      await Promise.resolve();
    });
    expect(host?.querySelector('[data-wf="DshInstallOutput"]')?.textContent)
      .toContain("added dsh-qingagent@0.1.22");
    const operation = host?.querySelector('[data-wf="DshInstallOperation"]');
    expect(operation?.querySelector('[data-wf="DshInstallPlugin"]')).not.toBeNull();
    expect(operation?.querySelector('[data-wf="DshInstallOutput"]')).not.toBeNull();
  });

  it("安装失败展示 stderr 摘要与复制命令兜底", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    installDshElectron(
      async () => ({
        detected: true,
        profiles: [{ name: "web", bundles: ["dsh-web-app"], pluginVersion: null }],
        defaultProfile: "web",
        npxAvailable: true,
      }),
      async () => ({
        ok: false,
        profile: "web",
        command: INSTALL_COMMAND,
        reason: "exit-failed",
        stderr: "npm ERR! code EAI_AGAIN\nnpm ERR! request to registry.npmjs.org failed",
        output: "",
      }),
    );
    await render(<DshPanel />);
    await settle();

    await click(getButton("DshInstallPlugin"));
    expect(host?.textContent).toContain("未能完成安装");
    expect(host?.querySelector('[data-wf="DshInstallOutput"]')?.textContent)
      .toContain("npm registry 连接失败");
    expect(host?.querySelector('[data-wf="DshInstallOutput"]')?.textContent)
      .not.toContain("npm ERR!");
    await click(getButton("DshCopyManualCommand"));
    expect(writeText).toHaveBeenCalledWith(INSTALL_COMMAND);
  });

  it("未找到 Node/npx 时禁用一键安装并保留复制命令兜底", async () => {
    installDshElectron(async () => ({
      detected: true,
      profiles: [{ name: "web", bundles: ["dsh-web-app"], pluginVersion: null }],
      defaultProfile: "web",
      npxAvailable: false,
    }));
    await render(<DshPanel />);
    await settle();

    expect(getButton("DshInstallPlugin").disabled).toBe(true);
    expect(host?.querySelector('[data-wf="DshNpxMissing"]')?.textContent)
      .toContain("未找到 Node/npx,请先安装 Node.js 20+");
    expect(host?.querySelector('[data-wf="DshCopyCommand"]')).not.toBeNull();
  });

  it("同一次失败的同步双击只执行一次并只保留一条去重 toast", async () => {
    const install = vi.fn(async () => ({
      ok: false,
      profile: "web",
      command: INSTALL_COMMAND,
      reason: "exit-failed",
      stderr: "network failed",
      output: "",
    }));
    installDshElectron(
      async () => ({
        detected: true,
        profiles: [{ name: "web", bundles: ["dsh-web-app"], pluginVersion: null }],
        defaultProfile: "web",
        npxAvailable: true,
      }),
      install,
    );
    await render(<DshPanel />);
    await settle();

    const button = getButton("DshInstallPlugin");
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(install).toHaveBeenCalledTimes(1);
    expect(host?.querySelectorAll('[data-toast-key="dsh-plugin-install-failed"]')).toHaveLength(1);
  });

  it("Web 端不渲染一键安装，只显示命令与复制", async () => {
    await render(<DshPanel />);

    expect(host?.querySelector('[data-wf="DshInstallPlugin"]')).toBeNull();
    expect(host?.querySelector('[data-wf="DshInstallCommand"]')?.textContent).toContain(INSTALL_COMMAND);
    expect(host?.querySelector('[data-wf="DshCopyCommand"]')).not.toBeNull();
  });

  it("embedded 模式先显示引擎就绪,连接事件带端口后实时补上端口", async () => {
    const publishBackend = installElectron({ mode: "embedded", status: "attached" });
    await render(<DshPanel />);

    expect(getEngineSection()?.textContent).toContain("本机引擎:");
    expect(getEngineStatus().textContent).toBe("✓ 青简引擎已就绪");
    await act(async () => {
      publishBackend({ mode: "embedded", status: "attached", port: 43123 });
    });
    expect(getEngineStatus().textContent).toContain("✓ 青简引擎已就绪 · 端口 43123");
  });

  it("attach 模式也只显示青简引擎已就绪，不暴露连接实现", async () => {
    installElectron({ mode: "attach", status: "attached" });
    await render(<DshPanel />);

    expect(getEngineSection()?.querySelector(".dsh-section-title")?.textContent).toBe("青简引擎");
    expect(getEngineSection()?.textContent).toContain("本机引擎:");
    expect(getEngineStatus().textContent).toBe("✓ 青简引擎已就绪");
  });

  it("web 端或连接快照读取失败时退化为静态说明", async () => {
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {
        platform: "linux",
        isDesktop: false,
        getBackendConnection: () => {
          throw new Error("bridge unavailable");
        },
      },
    });
    await render(<DshPanel />);

    expect(getEngineStatus().textContent).toContain("插件依赖本机青简引擎");
  });

  it("关于页链接块也复用同款 Star 引导", async () => {
    await render(<AboutPanel />);

    const invite = host?.querySelector('[data-wf="AboutStarInvite"]');
    expect(invite?.textContent).toContain("青简是开源的");
    expect(invite?.textContent).toContain("觉得顺手的话,去 GitHub 点颗 Star 是最好的鼓励");
    const link = invite?.querySelector<HTMLAnchorElement>("a");
    expect(link?.getAttribute("href")).toBe("https://github.com/void2anything/qingagent");
    expect(link?.querySelector("svg")).not.toBeNull();
  });
});

type BackendSnapshotInput = {
  mode: "embedded" | "attach";
  status: ElectronBackendConnectionSnapshot["status"];
  port?: number;
};

function makeBackendSnapshot(snapshot: BackendSnapshotInput): ElectronBackendConnectionSnapshot {
  return {
    generation: 0,
    libraryId: null,
    instanceId: null,
    effectiveCapabilities: {},
    errorCode: null,
    conflictKind: null,
    ...snapshot,
  };
}

function installElectron(
  snapshot: BackendSnapshotInput,
): (next: BackendSnapshotInput) => void {
  let current = makeBackendSnapshot(snapshot);
  let listener: ((next: ElectronBackendConnectionSnapshot) => void) | null = null;
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: {
      platform: "linux",
      isDesktop: true,
      getBackendConnection: () => current,
      onBackendConnectionChanged: (callback: (next: ElectronBackendConnectionSnapshot) => void) => {
        listener = callback;
        return () => {
          if (listener === callback) listener = null;
        };
      },
    },
  });
  return (next) => {
    current = makeBackendSnapshot(next);
    listener?.(current);
  };
}

function installDshElectron(
  detectDshPlugin: () => Promise<unknown>,
  installDshPlugin: (profile: string) => Promise<unknown> = async (profile) => ({
    ok: true,
    profile,
    command: INSTALL_COMMAND,
    output: "installed",
  }),
): void {
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: {
      platform: "linux",
      isDesktop: true,
      getBackendConnection: () => null,
      detectDshPlugin,
      installDshPlugin,
    },
  });
}

async function render(element: ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<ToastProvider>{element}</ToastProvider>);
  });
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function getButton(wf: string): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>(`[data-wf="${wf}"]`);
  if (!button) throw new Error(`未找到按钮:${wf}`);
  return button;
}

function getEngineStatus(): HTMLElement {
  const status = host?.querySelector<HTMLElement>('[data-wf="DshEngineStatus"]');
  if (!status) throw new Error("未找到 DSH 引擎状态");
  return status;
}

function getEngineSection(): HTMLElement | null {
  return getEngineStatus().closest<HTMLElement>(".dsh-section");
}

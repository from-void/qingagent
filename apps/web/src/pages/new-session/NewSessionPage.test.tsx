// @vitest-environment jsdom
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_COMMAND_STRING_LENGTH } from "@qingagent/contract-ts/schemas";
import {
  NewSessionPage,
  newSessionCommandLengthError,
  partitionNewSessionAttachmentFiles,
} from "./NewSessionPage";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("NewSessionPage 文件夹弹框键盘行为", () => {
  beforeEach(() => {
    installBrowserPolyfills();
    window.localStorage.clear();
    window.location.hash = "#/new";
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("引导弹框打开时按 Escape 只关闭弹框，不触发新建页返回", async () => {
    await render(<NewSessionPage />);

    const folderButton = getButton("[data-wf='NewSessionFolderBtn']");
    await waitFor(() => !folderButton.disabled);

    click(folderButton);
    expect(query("[data-wf='NewSessionFolderIntroOverlay']")).not.toBeNull();

    await keyDown("Escape");
    await wait(520);

    expect(query("[data-wf='NewSessionFolderIntroOverlay']")).toBeNull();
    expect(window.location.hash).toBe("#/new");
  });

  it("工具栏技能菜单打开时按 Escape 只关闭菜单，不触发新建页返回", async () => {
    await render(<NewSessionPage />);

    const skillButton = Array.from(host?.querySelectorAll<HTMLButtonElement>(".ccx-toolbar button") ?? [])
      .find((button) => button.textContent?.includes("技能"));
    if (!skillButton) throw new Error("skill button not found");

    click(skillButton);
    expect(query("[data-wf='NsSkillMenu']")).not.toBeNull();

    const event = await keyDown("Escape");
    await wait(520);

    expect(event.defaultPrevented).toBe(true);
    expect(query("[data-wf='NsSkillMenu']")).toBeNull();
    expect(window.location.hash).toBe("#/new");
  });

  it("提交动画期间离开新建页后不会被旧回调拉回工作区", async () => {
    await render(<NewSessionPage />);
    const editor = query(".starter-edit");
    if (!editor) throw new Error("editor not found");
    await act(async () => {
      editor.textContent = "保留当前导航";
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      await Promise.resolve();
    });

    click(getButton("[data-wf='StartSession']"));
    await waitFor(() => query("[data-wf='NewSessionPage']")?.classList.contains("is-leaving") === true);
    window.location.hash = "#/";
    await wait(1300);

    expect(window.location.hash).toBe("#/");
    const { clearPendingSubmission } = await import("../../system");
    await clearPendingSubmission();
  });
});

describe("NewSessionPage 附件校验", () => {
  it("超过 50 MB 的受支持文件不会进入待提交附件", () => {
    const atLimit = new File([""], "limit.pdf", { type: "application/pdf" });
    const oversized = new File([""], "oversized.pdf", { type: "application/pdf" });
    Object.defineProperty(atLimit, "size", { value: 50 * 1024 * 1024 });
    Object.defineProperty(oversized, "size", { value: 50 * 1024 * 1024 + 1 });

    const result = partitionNewSessionAttachmentFiles([atLimit, oversized]);

    expect(result.accepted).toEqual([atLimit]);
    expect(result.sizeErrorMessage).toBe("文件过大（上限 50 MB）");
  });
});

describe("NewSessionPage 正文校验", () => {
  it("正文或富文本超过命令上限时会在持久化前拦截", () => {
    const atLimit = "字".repeat(MAX_COMMAND_STRING_LENGTH);
    const oversized = `${atLimit}字`;

    expect(newSessionCommandLengthError(atLimit, atLimit)).toBeNull();
    expect(newSessionCommandLengthError(oversized, null)).toBe("内容过长，请缩短后再发送");
    expect(newSessionCommandLengthError("", oversized)).toBe("内容过长，请缩短后再发送");
  });
});

async function render(element: ReactElement): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
    await Promise.resolve();
  });
}

function query(selector: string): HTMLElement | null {
  return host?.querySelector<HTMLElement>(selector) ?? null;
}

function getButton(selector: string): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`button not found: ${selector}`);
  return button;
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function keyDown(key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => {
    document.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await act(async () => {
      await wait(10);
    });
  }
}

function installBrowserPolyfills(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({
      folderSources: {
        desktopLocal: { enabled: false },
        browserFsAccess: { enabled: true },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })),
  );
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(navigator, "maxTouchPoints", {
    configurable: true,
    value: 0,
  });
  Object.defineProperty(window, "showDirectoryPicker", {
    configurable: true,
    value: vi.fn(async () => ({
      kind: "directory",
      name: "浏览器资料库",
      queryPermission: vi.fn(async () => "granted"),
      requestPermission: vi.fn(async () => "granted"),
    })),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value(type: string) {
      if (type !== "2d") return null;
      // 全 no-op 的 2d 上下文 stub:HanziMatrix 泼墨画布在测试卸载后仍可能有一帧
      // RAF(被 polyfill 成 setTimeout)触发 drawHanziCanvas,任何画布方法/属性都不能抛。
      const noop = () => undefined;
      const imageData = (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(Math.max(0, width) * Math.max(0, height) * 4),
        colorSpace: "srgb" as const,
      });
      return new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === "createImageData" || prop === "getImageData") return imageData;
            if (prop === "createLinearGradient" || prop === "createRadialGradient" || prop === "createPattern") {
              return () => ({ addColorStop: noop });
            }
            if (prop === "measureText") return () => ({ width: 0 });
            return noop;
          },
          set() {
            return true;
          },
        },
      ) as unknown as CanvasRenderingContext2D;
    },
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    value() {
      return "data:image/png;base64,";
    },
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value(callback: FrameRequestCallback) {
      return window.setTimeout(() => callback(performance.now()), 0);
    },
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value(id: number) {
      window.clearTimeout(id);
    },
  });
  Object.defineProperty(window, "requestIdleCallback", {
    configurable: true,
    value(callback: IdleRequestCallback) {
      return window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 0);
    },
  });
  Object.defineProperty(window, "cancelIdleCallback", {
    configurable: true,
    value(id: number) {
      window.clearTimeout(id);
    },
  });
}

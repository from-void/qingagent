// @vitest-environment jsdom
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_COMMAND_STRING_LENGTH } from "@qingagent/contract-ts/schemas";
import { NewSessionPage } from "./NewSessionPage";

const createPendingSubmissionMock = vi.hoisted(() => vi.fn());
vi.mock("../../system", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../system")>();
  return {
    ...actual,
    createPendingSubmission: createPendingSubmissionMock,
  };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  createPendingSubmissionMock.mockReset();
  createPendingSubmissionMock.mockResolvedValue({ durable: true });
});

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

  it("技能菜单与文件夹引导层同时打开时，Escape 每次只关闭最前景一层", async () => {
    await render(<NewSessionPage />);
    const skillButton = Array.from(host?.querySelectorAll<HTMLButtonElement>(".ccx-toolbar button") ?? [])
      .find((button) => button.textContent?.includes("技能"));
    if (!skillButton) throw new Error("skill button not found");
    const folderButton = getButton("[data-wf='NewSessionFolderBtn']");
    await waitFor(() => !folderButton.disabled);

    click(skillButton);
    click(folderButton);
    expect(query("[data-wf='NsSkillMenu']")).not.toBeNull();
    expect(query("[data-wf='NewSessionFolderIntroOverlay']")).not.toBeNull();

    await keyDown("Escape");
    expect(query("[data-wf='NewSessionFolderIntroOverlay']")).toBeNull();
    expect(query("[data-wf='NsSkillMenu']")).not.toBeNull();
    expect(window.location.hash).toBe("#/new");

    await keyDown("Escape");
    await wait(520);
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

  it("文件选择入口拒绝超限文件，不插 chip 或进入待提交态", async () => {
    await render(<NewSessionPage />);
    const file = oversizedFile("oversized.pdf", "application/pdf");
    const input = host!.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });

    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(query(".src-chip")).toBeNull();
    expect(getButton("[data-wf='StartSession']").getAttribute("aria-disabled")).toBe("true");
  });

  it("拖拽入口拒绝超限文件，不插 chip 或进入待提交态", async () => {
    await render(<NewSessionPage />);
    const file = oversizedFile("oversized.pdf", "application/pdf");
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { types: ["Files"], files: [file] },
    });

    await act(async () => {
      window.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(true);
    expect(query(".src-chip")).toBeNull();
    expect(getButton("[data-wf='StartSession']").getAttribute("aria-disabled")).toBe("true");
  });

  it("粘贴入口拒绝超限图片，不插 chip 或进入待提交态", async () => {
    await render(<NewSessionPage />);
    const file = oversizedFile("oversized.png", "image/png", true);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [file],
        getData: () => "",
      },
    });

    await act(async () => {
      query("[data-wf='StarterInput']")!.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(true);
    expect(query(".src-chip")).toBeNull();
    expect(getButton("[data-wf='StartSession']").getAttribute("aria-disabled")).toBe("true");
  });
});

describe("NewSessionPage 正文校验", () => {
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

  it("astral Unicode 正文超过 65536 code units 时真实提交被拦截并保留编辑态", async () => {
    await render(<NewSessionPage />);
    const editor = query("[data-wf='StarterInput']")!;
    const oversized = "😀".repeat(MAX_COMMAND_STRING_LENGTH / 2 + 1);
    setStarterText(editor, oversized);

    click(getButton("[data-wf='StartSession']"));
    await act(async () => { await Promise.resolve(); });

    expect(createPendingSubmissionMock).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#/new");
    expect(editor.textContent).toBe(oversized);
    expect(query(".ccx-toast")?.textContent).toContain("内容过长");
  });

  it("astral Unicode 正文恰好 65536 code units 时通过真实提交入口", async () => {
    await render(<NewSessionPage />);
    const editor = query("[data-wf='StarterInput']")!;
    const atLimit = "😀".repeat(MAX_COMMAND_STRING_LENGTH / 2);
    expect(atLimit.length).toBe(MAX_COMMAND_STRING_LENGTH);
    setStarterText(editor, atLimit);

    click(getButton("[data-wf='StartSession']"));
    await waitFor(() => createPendingSubmissionMock.mock.calls.length === 1);

    expect(createPendingSubmissionMock.mock.calls[0]?.[0]).toMatchObject({
      text: atLimit,
      richText: null,
    });
  });

  it("可见正文在边界但富文本因真实 chip 超限时不持久化、不离页且保留内容", async () => {
    await render(<NewSessionPage />);
    const editor = query("[data-wf='StarterInput']")!;
    const atLimit = "😀".repeat(MAX_COMMAND_STRING_LENGTH / 2);
    setStarterText(editor, atLimit);
    const fileInput = host!.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["pdf"], "资料.pdf", { type: "application/pdf" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    const chip = editor.querySelector<HTMLElement>(".src-chip")!;
    if (chip.nextSibling?.nodeType === Node.TEXT_NODE) chip.nextSibling.remove();
    await act(async () => {
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContent" }));
      await Promise.resolve();
    });

    click(getButton("[data-wf='StartSession']"));
    await act(async () => { await Promise.resolve(); });

    expect(createPendingSubmissionMock).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#/new");
    expect(editorTextWithoutChips(editor)).toBe(atLimit);
    expect(editor.querySelectorAll(".src-chip")).toHaveLength(1);
    expect(query(".ccx-toast")?.textContent).toContain("内容过长");
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

function setStarterText(editor: HTMLElement, text: string): void {
  act(() => {
    editor.textContent = text;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
}

function editorTextWithoutChips(editor: HTMLElement): string {
  const clone = editor.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".src-chip").forEach((chip) => chip.remove());
  return clone.textContent ?? "";
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

function oversizedFile(name: string, type: string, useRealBytes = false): File {
  const file = new File(
    useRealBytes ? [new Uint8Array(50 * 1024 * 1024 + 1)] : [""],
    name,
    { type },
  );
  if (!useRealBytes) {
    Object.defineProperty(file, "size", { value: 50 * 1024 * 1024 + 1 });
  }
  return file;
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

// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FOLDER_INTRO_STORAGE_KEY,
  FolderSourceControl,
  type FolderSourceControlSource,
} from "./FolderSourceControl";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("FolderSourceControl", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("首次点击显示引导框，确认后写入不再提示并触发连接", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    await render(
      <FolderSourceControl
        {...baseProps({ onAttachFolder })}
      />,
    );

    click(getButton());
    expect(host?.querySelector('[data-wf="TestFolderIntroOverlay"]')).not.toBeNull();
    expect(onAttachFolder).not.toHaveBeenCalled();

    click(getCheckbox());
    await clickAsync(getPrimaryButton());

    expect(window.localStorage.getItem(FOLDER_INTRO_STORAGE_KEY)).toBe("1");
    expect(onAttachFolder).toHaveBeenCalledTimes(1);
    expect(host?.querySelector('[data-wf="TestFolderIntroOverlay"]')).toBeNull();
  });

  it("新建页连接态点击文件夹会重选，不打开断开确认", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    const onDetachFolder = vi.fn(async () => undefined);
    window.localStorage.setItem(FOLDER_INTRO_STORAGE_KEY, "1");
    await render(
      <FolderSourceControl
        {...baseProps({
          folderSource: mockSource,
          connectedBehavior: "attach",
          onAttachFolder,
          onDetachFolder,
        })}
      />,
    );

    expect(host?.querySelector('[data-wf="TestFolderDot"]')).not.toBeNull();
    await clickAsync(getButton());

    expect(onAttachFolder).toHaveBeenCalledTimes(1);
    expect(onDetachFolder).not.toHaveBeenCalled();
    expect(host?.querySelector('[data-wf="TestFolderDisconnectOverlay"]')).toBeNull();
  });

  it("连接成功后临时隐藏 popover,避免 focus-within 覆盖输入区", async () => {
    window.localStorage.setItem(FOLDER_INTRO_STORAGE_KEY, "1");
    const onAttachFolder = vi.fn(async () => undefined);
    function Harness() {
      const [source, setSource] = useState<FolderSourceControlSource | null>(null);
      return (
        <FolderSourceControl
          {...baseProps({
            folderSource: source,
            onAttachFolder: async () => {
              await onAttachFolder();
              setSource(mockSource);
            },
          })}
        />
      );
    }
    await render(<Harness />);

    const button = getButton();
    button.focus();
    await clickAsync(button);

    expect(onAttachFolder).toHaveBeenCalledTimes(1);
    expect(getRoot().classList.contains("is-popover-suppressed")).toBe(true);
    expect(host?.querySelector('[data-wf="TestFolderPopover"]')).not.toBeNull();
    expect(document.activeElement).not.toBe(button);

    act(() => {
      getRoot().dispatchEvent(new MouseEvent("mouseout", { bubbles: true, cancelable: true, relatedTarget: document.body }));
    });
    expect(getRoot().classList.contains("is-popover-suppressed")).toBe(false);
  });

  it("browser permission_required 点击时直接重新授权，不弹首次引导", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    await render(
      <FolderSourceControl
        {...baseProps({
          folderSource: {
            ...mockSource,
            provider: "browser-fs-access",
            status: "permission_required",
            error: "需要重新授权浏览器读取这个文件夹",
          },
          onAttachFolder,
        })}
      />,
    );

    await clickAsync(getButton());

    expect(onAttachFolder).toHaveBeenCalledTimes(1);
    expect(host?.querySelector('[data-wf="TestFolderIntroOverlay"]')).toBeNull();
    expect(host?.querySelector('[data-wf="TestFolderDisconnectOverlay"]')).toBeNull();
  });

  it("引导弹框打开时隔离背景焦点、Tab 留在弹框内，关闭后焦点回到按钮", async () => {
    await render(
      <>
        <button type="button" data-wf="OutsideButton">外部按钮</button>
        <FolderSourceControl {...baseProps()} />
      </>,
    );

    click(getButton());
    const dialog = host?.querySelector<HTMLElement>('[data-wf="TestFolderIntroOverlay"]');
    const outside = host?.querySelector<HTMLElement>('[data-wf="OutsideButton"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("aria-labelledby")).toBe("test-folder-intro-title");
    expect(document.activeElement).toBe(getPrimaryButton());
    expect(Boolean(outside?.closest("[inert]")) || outside?.getAttribute("aria-hidden") === "true").toBe(true);

    getCancelButton().focus();
    await keyDown("Tab");
    expect(document.activeElement).toBe(getCheckbox());

    await keyDown("Escape");
    expect(host?.querySelector('[data-wf="TestFolderIntroOverlay"]')).toBeNull();
    expect(document.activeElement).toBe(getButton());
  });

  it("capability disabled 时按钮灰态并展示原因", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    await render(
      <FolderSourceControl
        {...baseProps({
          folderCapability: { enabled: false, reason: "当前浏览器不支持本地文件夹访问" },
          onAttachFolder,
        })}
      />,
    );

    const button = getButton();
    expect(button.disabled).toBe(true);
    expect(host?.textContent).toContain("当前浏览器不支持本地文件夹访问");
    click(button);
    expect(onAttachFolder).not.toHaveBeenCalled();
  });
});

const mockSource: FolderSourceControlSource = {
  id: "pending-folder",
  provider: "desktop-local",
  name: "客户资料",
  pathLabel: "~/Documents/客户资料",
  mountPath: "/sources/customer",
  fileCount: 14,
  fileCountCapped: false,
  status: "connected",
  error: null,
};

function baseProps(overrides: Partial<Parameters<typeof FolderSourceControl>[0]> = {}): Parameters<typeof FolderSourceControl>[0] {
  return {
    rootClassName: "ccx-tool ccx-folder-wrap",
    buttonClassName: ({ active, selecting }) =>
      `ccx-folder-btn${active ? " is-active" : ""}${selecting ? " is-selecting" : ""}`,
    folderSource: null,
    folderCapability: { enabled: true, reason: null },
    onAttachFolder: vi.fn(async () => undefined),
    disabled: false,
    dataWfPrefix: "Test",
    tooltipId: "test-folder-tooltip",
    introTitleId: "test-folder-intro-title",
    disconnectTitleId: "test-folder-disconnect-title",
    ...overrides,
  };
}

async function render(element: ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
  });
}

function getButton(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>('[data-wf="TestFolderBtn"]');
  if (!button) throw new Error("folder button not found");
  return button;
}

function getRoot(): HTMLElement {
  const root = host?.querySelector<HTMLElement>(".ccx-folder-wrap");
  if (!root) throw new Error("folder root not found");
  return root;
}

function getCheckbox(): HTMLInputElement {
  const checkbox = host?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!checkbox) throw new Error("checkbox not found");
  return checkbox;
}

function getPrimaryButton(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>(".ws-folder-modal-primary");
  if (!button) throw new Error("primary button not found");
  return button;
}

function getCancelButton(): HTMLButtonElement {
  const buttons = host?.querySelectorAll<HTMLButtonElement>(".ws-folder-modal-secondary");
  const button = buttons?.[buttons.length - 1];
  if (!button) throw new Error("cancel button not found");
  return button;
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function clickAsync(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function keyDown(key: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

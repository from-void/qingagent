// @vitest-environment jsdom
import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderSource, Resource } from "@qingagent/contract-ts";
import { SKILLS_CHANGED_EVENT } from "../../../overlays/settings/useSkills";
import { resources } from "../../../system/resources";
import type { MaterialParseRow } from "../data/useMaterialParseTracker";
import { ChatInput, type ChatInputHandle, type ChatInputProps } from "./ChatInput";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const FOLDER_INTRO_STORAGE_KEY = "qingagent:folder-source-intro-dismissed";

type FolderInputProps = Pick<
  ChatInputProps,
  "folderSource" | "folderCapability" | "onAttachFolder" | "onDetachFolder"
>;

describe("ChatInput", () => {
  beforeEach(() => {
    resources.reset();
    window.localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    resources.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("IME 合成期不触发 onChange, compositionend 后只上报最终文本", async () => {
    const onChange = vi.fn();
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onChange={onChange}
        onSubmit={() => undefined}
      />,
    );
    const edit = getEditor();
    bindInnerText(edit);

    act(() => {
      edit.dispatchEvent(compositionEvent("compositionstart"));
    });
    act(() => {
      edit.innerText = "n";
      edit.dispatchEvent(inputEvent(true));
    });
    act(() => {
      edit.innerText = "ni";
      edit.dispatchEvent(inputEvent(true));
    });

    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      edit.innerText = "你";
      edit.dispatchEvent(compositionEvent("compositionend"));
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("你", 0);
  });

  it("普通输入仍立即触发 onChange", async () => {
    const onChange = vi.fn();
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onChange={onChange}
        onSubmit={() => undefined}
      />,
    );
    const edit = getEditor();
    bindInnerText(edit);

    act(() => {
      edit.innerText = "hello";
      edit.dispatchEvent(inputEvent(false));
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("hello", 0);
  });

  it("同名重复选择复用现有 attach chip,不新增幽灵 chip", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    await selectFile(new File(["a"], "report.md", { type: "text/markdown" }));
    await selectFile(new File(["b"], "report.md", { type: "text/markdown" }));

    expect(ref.current?.snapshot().files.map((file) => file.name)).toEqual(["report.md"]);
    expect(attachChipLabels()).toEqual(["report.md"]);
  });

  it("点击 attach chip 删除按钮时同步删除同名 File 和残留同名 chip", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    await selectFile(new File(["a"], "report.md", { type: "text/markdown" }));
    const edit = getEditor();
    const chip = edit.querySelector<HTMLElement>(".chat-chip");
    if (!chip) throw new Error("attach chip not found");
    edit.appendChild(chip.cloneNode(true));
    expect(attachChipLabels()).toEqual(["report.md", "report.md"]);

    const removeButton = edit.querySelector<HTMLElement>(".chat-chip .c-x");
    if (!removeButton) throw new Error("chip remove button not found");
    clickElement(removeButton);

    expect(ref.current?.snapshot().files).toEqual([]);
    expect(attachChipLabels()).toEqual([]);
  });

  it("选择文件未发送时只插 attach chip，不渲染已关联文件条", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    await selectFile(new File(["a"], "draft.md", { type: "text/markdown" }));

    expect(ref.current?.snapshot().files.map((file) => file.name)).toEqual(["draft.md"]);
    expect(attachChipLabels()).toEqual(["draft.md"]);
    expect(host?.querySelector('[data-wf="LinkedFilesBar"]')).toBeNull();
    expect(host?.querySelector('[data-wf="LinkedFilesPanel"]')).toBeNull();
  });

  it("工具栏只保留 技能 / 文件 两个动作入口", async () => {
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    const buttons = Array.from(
      host?.querySelectorAll<HTMLButtonElement>('[data-wf="WsFileBtn"], [data-wf="WsSkillBtn"]') ?? [],
    );
    expect(buttons.map((button) => button.dataset.wf)).toEqual(["WsSkillBtn", "WsFileBtn"]);
    expect(host?.querySelector('[data-wf="WsFolderBtn"]')).toBeNull();
  });

  it("selection chip 序列化/还原保留多行 selectionRefs", async () => {
    const ref = createRef<ChatInputHandle>();
    await render(
      <ChatInput
        {...baseFolderProps()}
        ref={ref}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    act(() => {
      ref.current?.insertChip({
        kind: "sel",
        label: "第一行\n第二行",
        suffix: "批注",
        from: 10,
        to: 20,
        blockId: "item-1",
        selectionRefs: ["item-1", "item-2"],
      });
    });

    const chip = getEditor().querySelector<HTMLElement>('.chat-chip[data-kind="sel"]');
    expect(chip?.dataset.selectionRefs).toBe(JSON.stringify(["item-1", "item-2"]));
    const snapshot = ref.current?.snapshot();
    expect(snapshot?.chips[0]).toMatchObject({
      kind: "sel",
      blockId: "item-1",
      selectionRefs: ["item-1", "item-2"],
    });

    act(() => {
      ref.current?.clear();
      ref.current?.restore(snapshot!);
    });

    expect(ref.current?.snapshot().chips[0]).toMatchObject({
      kind: "sel",
      blockId: "item-1",
      selectionRefs: ["item-1", "item-2"],
    });
  });

  it("文件菜单连接本地文件夹：首次显示引导框，勾选后下次跳过", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    await render(
      <ChatInput
        {...baseFolderProps({ onAttachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    clickElement(getAttachFolderRow());
    const checkbox = getFolderIntroCheckbox();
    expect(checkbox.checked).toBe(false);
    expect(onAttachFolder).not.toHaveBeenCalled();

    await setCheckbox(checkbox, true);
    await clickElementAsync(getFolderIntroContinueButton());

    expect(window.localStorage.getItem(FOLDER_INTRO_STORAGE_KEY)).toBe("1");
    expect(onAttachFolder).toHaveBeenCalledTimes(1);
    expect(host?.querySelector('[data-wf="WsFolderIntroOverlay"]')).toBeNull();

    openFileMenu();
    await clickElementAsync(getAttachFolderRow());

    expect(onAttachFolder).toHaveBeenCalledTimes(2);
    expect(host?.querySelector('[data-wf="WsFolderIntroOverlay"]')).toBeNull();
  });

  it("文件夹引导框支持取消、Escape 和遮罩关闭且不触发连接", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    await render(
      <ChatInput
        {...baseFolderProps({ onAttachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    clickElement(getAttachFolderRow());
    clickElement(getFolderIntroCancelButton());
    expect(onAttachFolder).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(FOLDER_INTRO_STORAGE_KEY)).toBeNull();
    expect(host?.querySelector('[data-wf="WsFolderIntroOverlay"]')).toBeNull();

    openFileMenu();
    clickElement(getAttachFolderRow());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host?.querySelector('[data-wf="WsFolderIntroOverlay"]')).toBeNull();

    openFileMenu();
    clickElement(getAttachFolderRow());
    clickElement(getFolderIntroOverlay());
    expect(host?.querySelector('[data-wf="WsFolderIntroOverlay"]')).toBeNull();
    expect(onAttachFolder).not.toHaveBeenCalled();
  });

  it("已连接时文件菜单第二行展示文件夹名、呼吸绿点和断开入口", async () => {
    await render(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSource })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    const row = getFolderStatusRow();
    expect(row.textContent).toContain("客户资料");
    expect(row.textContent).toContain("已连接 · 点击查看与管理");
    expect(row.querySelector(".qa-file-folder-dot")).not.toBeNull();
    expect(getMenuDisconnectButton()).not.toBeNull();
    expect(host?.querySelector('[data-wf="WsFolderPopover"]')).toBeNull();
  });

  it("点已连接状态行本体会展开已关联文件树并收起菜单", async () => {
    await render(
      <ChatInput
        {...baseFolderProps({
          folderSource: mockFolderSource,
        })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    clickElement(getFolderStatusRow());

    expect(host?.querySelector('[data-wf="WsFileMenu"]')).toBeNull();
    expect(host?.querySelector('[data-wf="LinkedFilesPanel"]')).not.toBeNull();
    expect(host?.querySelector('[data-wf="LinkedFolderRootRow"]')?.textContent).toContain("客户资料");
  });

  it("已关联素材行点击会透传 onPreviewMaterial", async () => {
    const onPreviewMaterial = vi.fn();
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={() => undefined}
        materialParseRows={[readyMaterialRow("res-preview", "preview.pdf")]}
        onPreviewMaterial={onPreviewMaterial}
      />,
    );

    clickElement(getLinkedFilesBar());
    clickElement(rowByText("preview.pdf"));

    expect(onPreviewMaterial).toHaveBeenCalledTimes(1);
    expect(onPreviewMaterial).toHaveBeenCalledWith(expect.objectContaining({
      id: "res-preview",
      name: "preview.pdf",
      fileId: "file-res-preview",
    }));
  });

  it("菜单断开按钮打开断开确认，不调选择器", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    const onDetachFolder = vi.fn(async () => undefined);
    await render(
      <ChatInput
        {...baseFolderProps({ folderSource: mockFolderSource, onAttachFolder, onDetachFolder })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    clickElement(getMenuDisconnectButton());

    expect(onAttachFolder).not.toHaveBeenCalled();
    expect(host?.textContent).toContain("断开「客户资料」连接？");
    expect(host?.textContent).toContain("文件不会被删除");

    await clickElementAsync(getDisconnectConfirmButton());

    expect(onDetachFolder).toHaveBeenCalledWith("fld_test");
  });

  it("capability 不支持时仅置灰连接文件夹行，选择文件不受影响", async () => {
    const onAttachFolder = vi.fn(async () => undefined);
    let inputClicked = 0;
    await render(
      <ChatInput
        {...baseFolderProps({
          folderCapability: { enabled: false, reason: "网页版暂未开放" },
          onAttachFolder,
        })}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    const input = getFileInput();
    vi.spyOn(input, "click").mockImplementation(() => {
      inputClicked += 1;
    });

    openFileMenu();
    const row = getAttachFolderRow();
    expect(row.disabled).toBe(true);
    expect(row.classList.contains("is-disabled")).toBe(true);
    expect(row.textContent).toContain("网页版暂未开放");
    clickElement(row);
    expect(onAttachFolder).not.toHaveBeenCalled();
    clickElement(getChooseFileRow());
    expect(inputClicked).toBe(1);
  });

  it("文件按钮只开关菜单并用 is-active 高亮，不显示文件计数", async () => {
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    const button = getFileButton();
    expect(button.textContent?.trim()).toBe("文件");
    expect(button.classList.contains("is-active")).toBe(false);

    clickElement(button);
    expect(button.classList.contains("is-active")).toBe(true);
    expect(getFileMenu()).not.toBeNull();

    clickElement(button);
    expect(button.classList.contains("is-active")).toBe(false);
    expect(host?.querySelector('[data-wf="WsFileMenu"]')).toBeNull();
  });

  it("文件菜单支持 Esc 和点外部关闭", async () => {
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host?.querySelector('[data-wf="WsFileMenu"]')).toBeNull();

    openFileMenu();
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(host?.querySelector('[data-wf="WsFileMenu"]')).toBeNull();
  });

  it("文件菜单与技能菜单互斥", async () => {
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );

    openFileMenu();
    expect(getFileMenu()).not.toBeNull();
    clickElement(getSkillButton());
    expect(host?.querySelector('[data-wf="WsFileMenu"]')).toBeNull();
    expect(host?.querySelector('[data-wf="SkillMenu"]')).not.toBeNull();

    openFileMenu();
    expect(host?.querySelector('[data-wf="SkillMenu"]')).toBeNull();
    expect(getFileMenu()).not.toBeNull();
  });

  it("技能菜单由 API 自动准入：只显示已启用且 userInvocable 的技能", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/api/v1/skills")) {
          return new Response(
            JSON.stringify({
              skills: [
                {
                  name: "web-search",
                  description: "联网调研",
                  label: "联网搜",
                  summary: "搜资料、核事实、找出处",
                  icon: "search",
                  source: "builtin",
                  userInvocable: true,
                  placeholder: "搜索主题",
                  tools: ["webSearch"],
                  enabled: true,
                },
                {
                  name: "doc-calc",
                  description: "精确计算",
                  label: "算数据",
                  summary: "表格统计与精确计算",
                  icon: "calc",
                  source: "builtin",
                  userInvocable: true,
                  tools: ["run_js"],
                  enabled: false,
                },
                {
                  name: "materials",
                  description: "素材",
                  label: "读资料",
                  summary: "读取上传文件与资料库并引用",
                  icon: "materials",
                  source: "builtin",
                  userInvocable: false,
                  tools: ["readDocument", "searchDocuments"],
                  enabled: true,
                },
                {
                  name: "custom-research",
                  description: "自装研究技能",
                  label: "研资料",
                  summary: "整理用户资料",
                  icon: "star",
                  source: "installed",
                  userInvocable: true,
                  placeholder: "说明资料",
                  tools: [],
                  enabled: true,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    clickElement(getSkillButton());
    const menu = host?.querySelector<HTMLElement>('[data-wf="SkillMenu"]');
    expect(menu?.textContent).toContain("联网搜");
    expect(menu?.textContent).toContain("搜资料、核事实、找出处");
    expect(menu?.textContent).toContain("研资料");
    expect(menu?.textContent).not.toContain("算数据");
    expect(menu?.textContent).not.toContain("读资料");
  });

  it("技能变更事件会刷新已挂载输入框菜单", async () => {
    let skillsPayload = [
      skillPayload({
        name: "web-search",
        label: "联网搜",
        summary: "搜资料、核事实、找出处",
        icon: "search",
        userInvocable: true,
        enabled: true,
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/api/v1/skills")) {
          return new Response(JSON.stringify({ skills: skillsPayload }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    await render(
      <ChatInput
        {...baseFolderProps()}
        placeholder="输入"
        onSubmit={() => undefined}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    clickElement(getSkillButton());
    expect(host?.querySelector('[data-wf="SkillMenu"]')?.textContent).toContain("联网搜");
    expect(host?.querySelector('[data-wf="SkillMenu"]')?.textContent).not.toContain("研资料");

    skillsPayload = [
      skillPayload({
        name: "web-search",
        label: "联网搜",
        summary: "搜资料、核事实、找出处",
        icon: "search",
        userInvocable: true,
        enabled: false,
      }),
      skillPayload({
        name: "custom-research",
        label: "研资料",
        summary: "整理用户资料",
        icon: "star",
        userInvocable: true,
        enabled: true,
        source: "installed",
      }),
    ];
    await act(async () => {
      window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT));
      await new Promise((r) => setTimeout(r, 0));
    });

    const menu = host?.querySelector<HTMLElement>('[data-wf="SkillMenu"]');
    expect(menu?.textContent).toContain("研资料");
    expect(menu?.textContent).not.toContain("联网搜");
  });
});

const mockFolderSource: FolderSource = {
  id: "fld_test",
  sessionId: "s1",
  provider: "desktop-local",
  name: "客户资料",
  pathLabel: "~/Documents/客户资料",
  mountName: "source_test",
  mountPath: "/sources/source_test",
  readOnly: true,
  fileCount: 14,
  fileCountCapped: false,
  status: "connected",
  error: null,
  createdAt: "2026-06-18T00:00:00.000Z",
  updatedAt: "2026-06-18T00:00:00.000Z",
};

function baseFolderProps(overrides: Partial<FolderInputProps> = {}): FolderInputProps {
  return {
    folderSource: null,
    folderCapability: { enabled: true, reason: null },
    onAttachFolder: vi.fn(async () => undefined),
    onDetachFolder: vi.fn(async () => undefined),
    ...overrides,
  };
}

function skillPayload(overrides: Partial<{
  name: string;
  description: string;
  label: string;
  summary: string;
  icon: string;
  source: "builtin" | "installed";
  userInvocable: boolean;
  placeholder?: string;
  tools: string[];
  enabled: boolean;
}> = {}) {
  const name = overrides.name ?? "web-search";
  const summary = overrides.summary ?? "技能简介";
  return {
    name,
    description: overrides.description ?? summary,
    label: overrides.label ?? name.slice(0, 6),
    summary,
    icon: overrides.icon ?? "star",
    source: overrides.source ?? "builtin",
    userInvocable: overrides.userInvocable ?? false,
    placeholder: overrides.placeholder,
    tools: overrides.tools ?? [],
    enabled: overrides.enabled ?? true,
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

function getEditor(): HTMLDivElement {
  const edit = host?.querySelector<HTMLDivElement>('[data-wf="ChatInput"]');
  if (!edit) throw new Error("ChatInput editor not found");
  return edit;
}

function getFileInput(): HTMLInputElement {
  const input = host?.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("file input not found");
  return input;
}

function getFileButton(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>('[data-wf="WsFileBtn"]');
  if (!button) throw new Error("file button not found");
  return button;
}

function getSkillButton(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>('[data-wf="WsSkillBtn"]');
  if (!button) throw new Error("skill button not found");
  return button;
}

function getFileMenu(): HTMLElement {
  const menu = host?.querySelector<HTMLElement>('[data-wf="WsFileMenu"]');
  if (!menu) throw new Error("file menu not found");
  return menu;
}

function getLinkedFilesBar(): HTMLElement {
  const bar = host?.querySelector<HTMLElement>('[data-wf="LinkedFilesBar"]');
  if (!bar) throw new Error("linked files bar not found");
  return bar;
}

function rowByText(text: string): HTMLElement {
  const row = Array.from(host?.querySelectorAll<HTMLElement>(".lf-row") ?? []).find((item) =>
    item.textContent?.includes(text),
  );
  if (!row) throw new Error(`row not found: ${text}`);
  return row;
}

function getChooseFileRow(): HTMLButtonElement {
  const row = host?.querySelector<HTMLButtonElement>('[data-wf="WsFileMenuChooseFile"]');
  if (!row) throw new Error("choose file row not found");
  return row;
}

function getAttachFolderRow(): HTMLButtonElement {
  const row = host?.querySelector<HTMLButtonElement>('[data-wf="WsFileMenuAttachFolder"]');
  if (!row) throw new Error("attach folder row not found");
  return row;
}

function getFolderStatusRow(): HTMLElement {
  const row = host?.querySelector<HTMLElement>('[data-wf="WsFileMenuFolderStatus"]');
  if (!row) throw new Error("folder status row not found");
  return row;
}

function getMenuDisconnectButton(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>('[data-wf="WsFileMenuDisconnect"]');
  if (!button) throw new Error("menu disconnect button not found");
  return button;
}

function getFolderIntroCheckbox(): HTMLInputElement {
  const checkbox = host?.querySelector<HTMLInputElement>('[data-wf="WsFolderIntroOverlay"] input[type="checkbox"]');
  if (!checkbox) throw new Error("folder intro checkbox not found");
  return checkbox;
}

function getFolderIntroOverlay(): HTMLElement {
  const overlay = host?.querySelector<HTMLElement>('[data-wf="WsFolderIntroOverlay"]');
  if (!overlay) throw new Error("folder intro overlay not found");
  return overlay;
}

function openFileMenu(): void {
  clickElement(getFileButton());
}

function getFolderIntroContinueButton(): HTMLButtonElement {
  const button = Array.from(host?.querySelectorAll<HTMLButtonElement>(".ws-folder-modal-primary") ?? []).find(
    (node) => node.textContent?.includes("我知道了，选择文件夹"),
  );
  if (!button) throw new Error("folder intro continue button not found");
  return button;
}

function getFolderIntroCancelButton(): HTMLButtonElement {
  const button = Array.from(host?.querySelectorAll<HTMLButtonElement>(".ws-folder-modal-secondary") ?? []).find(
    (node) => node.textContent?.includes("取消"),
  );
  if (!button) throw new Error("folder intro cancel button not found");
  return button;
}

function getDisconnectConfirmButton(): HTMLButtonElement {
  const button = Array.from(host?.querySelectorAll<HTMLButtonElement>(".ws-folder-modal-danger") ?? []).find(
    (node) => node.textContent?.includes("断开连接"),
  );
  if (!button) throw new Error("disconnect confirm button not found");
  return button;
}

function attachChipLabels(): string[] {
  return Array.from(getEditor().querySelectorAll<HTMLElement>('.chat-chip[data-kind="attach"]')).map(
    (chip) => chip.dataset.label ?? "",
  );
}

async function selectFile(file: File): Promise<void> {
  const input = getFileInput();
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [file],
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function clickElement(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function clickElementAsync(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function setCheckbox(element: HTMLInputElement, checked: boolean): Promise<void> {
  await act(async () => {
    if (element.checked !== checked) {
      element.click();
    }
  });
}

function bindInnerText(element: HTMLElement): void {
  Object.defineProperty(element, "innerText", {
    configurable: true,
    get: () => element.textContent ?? "",
    set: (value: string) => {
      element.textContent = value;
    },
  });
}

function compositionEvent(type: "compositionstart" | "compositionend"): Event {
  if (typeof CompositionEvent === "function") {
    return new CompositionEvent(type, { bubbles: true, cancelable: true });
  }
  return new Event(type, { bubbles: true, cancelable: true });
}

function inputEvent(isComposing: boolean): Event {
  if (typeof InputEvent === "function") {
    return new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      isComposing,
    } as InputEventInit);
  }
  const event = new Event("input", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "isComposing", {
    configurable: true,
    value: isComposing,
  });
  return event;
}

function readyMaterialRow(id: string, filename: string): MaterialParseRow {
  const resource = resourceFor(id, filename, { fileId: `file-${id}` });
  return {
    id,
    fileId: `file-${id}`,
    filename,
    mime: "application/pdf",
    state: "ready",
    parseError: null,
    resource,
    source: "resource",
  };
}

function resourceFor(id: string, displayName: string, metadata: unknown): Resource {
  return {
    resourceRef: { id, domain: { kind: "file" } },
    displayName,
    summary: "",
    mime: "application/pdf",
    byteLen: 8200,
    createdAt: "2026-07-04T00:00:00.000Z",
    metadata,
  };
}

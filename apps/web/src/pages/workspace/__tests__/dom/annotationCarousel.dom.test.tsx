import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import type { AnnotationGroup } from "@qingagent/contract-ts";
import { AnnotationCarousel, buildAnnotationInstruction, buildAnnotationSeveritySummary } from "../../components/AnnotationCarousel";
import { installAnnotationGroupDecorations } from "../../data/annotationDecorations";
import { initialWorkspaceState, workspaceReducer } from "../../data/workspaceState";

const groups: AnnotationGroup[] = [
  { id: "g1", summary: "事实有误", note: "时间与资料不一致", origin: "source-check", suggestion: "改为四月发布", status: "reviewing", anchors: [{ blockId: "p", pmFrom: 1, pmTo: 3, quote: "甲组原句", textHash: "h1" }] },
  { id: "g2", summary: "表述重复", note: "与上一段语义重复", origin: "consistency", suggestion: "删去重复句", status: "reviewing", anchors: [{ blockId: "p", pmFrom: 3, pmTo: 5, quote: "乙组原句", textHash: "h2" }] },
];

describe("AnnotationCarousel hover card", () => {
  let editor: Editor | null = null;
  let editorHost: HTMLDivElement | null = null;
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
  afterAll(() => { delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    editor?.destroy();
    editorHost?.remove();
    host?.remove();
    root = null;
    editor = null;
    editorHost = null;
    host = null;
    vi.useRealTimers();
  });

  it("一次画出 reviewing 与 accepted 锚点，忽略组不渲染", () => {
    createEditor();
    const uninstall = installAnnotationGroupDecorations(editor!, [
      groups[0]!,
      { ...groups[1]!, status: "accepted" },
      { ...groups[1]!, id: "g3", status: "ignored" },
    ]);
    expect(editorHost!.querySelectorAll(".annotation-anchor-active")).toHaveLength(1);
    expect(editorHost!.querySelectorAll(".annotation-anchor-accepted")).toHaveLength(1);
    expect(editorHost!.querySelector('[data-annotation-group="g3"]')).toBeNull();
    uninstall();
  });

  it("预览帧渐显波浪且不可 hover，reduced-motion 标类，groupsReady 由正式组接管", () => {
    createEditor();
    let reducedMotion = false;
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" && reducedMotion,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    }));
    try {
      const previewFrame = {
        kind: "annotationPreview" as const,
        data: {
          previewId: "preview-1",
          summary: "流式发现",
          anchors: [{ blockId: "p", pmFrom: 1, pmTo: 3, quote: "甲组", textHash: "preview-hash" }],
        },
      };
      let state = workspaceReducer(initialWorkspaceState, previewFrame);
      let uninstall = installAnnotationGroupDecorations(editor!, state.annotationGroups, undefined, state.previewGroups);
      const animated = editorHost!.querySelector<HTMLElement>('[data-annotation-group="preview-1"]')!;
      expect(animated.classList.contains("annotation-anchor-preview")).toBe(true);
      expect(animated.classList.contains("annotation-anchor-active")).toBe(false);
      expect(animated.getAttribute("data-annotation-preview")).toBe("true");
      uninstall();

      reducedMotion = true;
      uninstall = installAnnotationGroupDecorations(editor!, state.annotationGroups, undefined, state.previewGroups);
      expect(editorHost!.querySelector('[data-annotation-group="preview-1"]')?.classList.contains("is-reduced-motion")).toBe(true);
      uninstall();

      state = workspaceReducer(state, {
        kind: "annotationGroupsReady",
        data: {
          groups: [{
            id: "formal-1",
            summary: "流式发现",
            note: "正式校验已通过",
            origin: "source-check",
            status: "reviewing",
            anchors: [{ blockId: "p", pmFrom: 1, pmTo: 3, quote: "甲组", textHash: "formal-hash" }],
          }],
          replacedOrigins: ["source-check"],
        },
      });
      expect(state.previewGroups).toEqual([]);
      uninstall = installAnnotationGroupDecorations(editor!, state.annotationGroups, undefined, state.previewGroups);
      expect(editorHost!.querySelector('[data-annotation-group="preview-1"]')).toBeNull();
      expect(editorHost!.querySelector('[data-annotation-group="formal-1"]')?.classList.contains("annotation-anchor-active")).toBe(true);
      uninstall();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("锚内漂移一字时多锚组保留未受影响的存活锚点", async () => {
    createEditor();
    const onGroupsChange = vi.fn();
    const multiAnchorGroup: AnnotationGroup = {
      ...groups[0]!,
      anchors: [
        { ...groups[0]!.anchors[0]!, quote: "甲组" },
        { ...groups[1]!.anchors[0]!, quote: "乙组" },
      ],
    };
    const uninstall = installAnnotationGroupDecorations(editor!, [multiAnchorGroup], onGroupsChange);

    await act(async () => {
      editor!.commands.insertContentAt(2, "新");
      await Promise.resolve();
    });

    expect(onGroupsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: "g1",
        anchors: [expect.objectContaining({ quote: "乙组", pmFrom: 4, pmTo: 6 })],
      }),
    ], 0);
    expect(editorHost!.querySelector('[data-annotation-group="g1"]')?.textContent).toBe("乙组");
    uninstall();
  });

  it("锚内删字使整组静默消失", async () => {
    createEditor();
    const onGroupsChange = vi.fn();
    const exactGroup: AnnotationGroup = {
      ...groups[0]!,
      anchors: [{ ...groups[0]!.anchors[0]!, quote: "甲组" }],
    };
    const uninstall = installAnnotationGroupDecorations(editor!, [exactGroup], onGroupsChange);

    await act(async () => {
      editor!.commands.deleteRange({ from: 1, to: 2 });
      await Promise.resolve();
    });

    expect(onGroupsChange).toHaveBeenLastCalledWith([], 1);
    uninstall();
  });

  it("只改格式 mark 不判锚点失效", async () => {
    createEditor();
    const onGroupsChange = vi.fn();
    const exactGroup: AnnotationGroup = {
      ...groups[0]!,
      anchors: [{ ...groups[0]!.anchors[0]!, quote: "甲组" }],
    };
    const uninstall = installAnnotationGroupDecorations(editor!, [exactGroup], onGroupsChange);

    await act(async () => {
      editor!.chain().setTextSelection({ from: 1, to: 3 }).toggleBold().run();
      await Promise.resolve();
    });

    expect(onGroupsChange).not.toHaveBeenCalled();
    expect(editorHost!.querySelector('[data-annotation-group="g1"]')?.textContent).toBe("甲组");
    uninstall();
  });

  it("锚外编辑只平移装饰且组继续存活", async () => {
    createEditor();
    const onGroupsChange = vi.fn();
    const exactGroup: AnnotationGroup = {
      ...groups[0]!,
      anchors: [{ ...groups[0]!.anchors[0]!, quote: "甲组" }],
    };
    const uninstall = installAnnotationGroupDecorations(editor!, [exactGroup], onGroupsChange);

    await act(async () => {
      editor!.commands.insertContentAt(1, "外");
      await Promise.resolve();
    });

    expect(onGroupsChange).toHaveBeenCalledTimes(1);
    expect(onGroupsChange.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        id: "g1",
        anchors: [expect.objectContaining({ pmFrom: 2, pmTo: 4, quote: "甲组" })],
      }),
    ]);
    expect(editorHost!.querySelector('[data-annotation-group="g1"]')?.textContent).toBe("甲组");
    uninstall();
  });

  it("hover 延迟出宽卡且可桥接，切组后编辑意见并请求生成修改，忽略立即移除", async () => {
    vi.useFakeTimers();
    createEditor();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    function Harness() {
      const [currentGroups, setCurrentGroups] = useState(groups);
      const [input, setInput] = useState("已有草稿");
      useEffect(() => installAnnotationGroupDecorations(editor!, currentGroups), [currentGroups]);
      return <>
        <div data-testid="chat-input">{input}</div>
        <AnnotationCarousel
          groups={currentGroups}
          editorDom={editor!.view.dom}
          onAccept={(group, suggestion) => {
            setInput((value) => `${value}\n${buildAnnotationInstruction(group, suggestion)}`);
            return true;
          }}
          onIgnore={(group) => setCurrentGroups((value) => value.map((item) => item.id === group.id ? { ...item, status: "ignored" } : item))}
        />
      </>;
    }

    await act(async () => root!.render(<Harness />));
    const firstAnchor = editorHost!.querySelector<HTMLElement>('[data-annotation-group="g1"]')!;
    await act(async () => {
      firstAnchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(79);
    });
    expect(host.querySelector(".annotation-hover-card")).toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    const card = host!.querySelector<HTMLElement>(".annotation-hover-card")!;
    const body = card.querySelector<HTMLElement>(":scope > .ahc-body")!;
    expect(body.querySelector(":scope > .ahc-head")).not.toBeNull();
    expect(body.querySelector(":scope > .ahc-reason")).not.toBeNull();
    expect(body.querySelector(":scope > .ahc-suggestion")).not.toBeNull();
    expect(card.querySelector(":scope > footer")).not.toBeNull();
    expect(card.textContent).toContain("事实有误");
    expect(card.textContent).toContain("第 1 / 共 2 处");
    expect(card.textContent).toContain("时间与资料不一致");
    expect(card.textContent).toContain("改为四月发布");
    expect(host.querySelector<HTMLTextAreaElement>(".ahc-suggestion textarea")?.value).toBe("改为四月发布");
    expect(Array.from(card.querySelectorAll("footer button"), (button) => button.textContent)).toEqual(["忽略", "下次不再提示", "生成修改"]);
    expect(card.textContent).toContain("将追加到输入框，由你确认发送");
    expect(card.querySelectorAll(".ahc-nav button")).toHaveLength(2);
    expect(host.textContent).not.toContain("全部提交");

    const secondAnchor = editorHost!.querySelector<HTMLElement>('[data-annotation-group="g2"]')!;
    Object.defineProperty(firstAnchor, "scrollIntoView", {
      configurable: true,
      value: () => window.setTimeout(() => document.dispatchEvent(new Event("scroll")), 50),
    });
    Object.defineProperty(secondAnchor, "scrollIntoView", {
      configurable: true,
      value: () => window.setTimeout(() => document.dispatchEvent(new Event("scroll")), 50),
    });
    await act(async () => card.querySelector<HTMLButtonElement>('[aria-label="下一处批注"]')!.click());
    expect(host.querySelector<HTMLElement>(".annotation-hover-card")?.dataset.groupId).toBe("g2");
    expect(host.textContent).toContain("第 2 / 共 2 处");
    expect(host.textContent).toContain("表述重复");
    await act(async () => vi.advanceTimersByTime(50));
    expect(host.querySelector<HTMLElement>(".annotation-hover-card")?.dataset.groupId).toBe("g2");
    await act(async () => vi.advanceTimersByTime(200));
    await act(async () => host!.querySelector<HTMLButtonElement>('[aria-label="上一处批注"]')!.click());
    expect(host.querySelector<HTMLElement>(".annotation-hover-card")?.dataset.groupId).toBe("g1");
    expect(host.textContent).toContain("事实有误");

    await act(async () => {
      firstAnchor.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
      vi.advanceTimersByTime(100);
      card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: firstAnchor }));
      vi.advanceTimersByTime(100);
    });
    expect(host.querySelector(".annotation-hover-card")).not.toBeNull();

    await act(async () => vi.advanceTimersByTime(200));

    const suggestion = host.querySelector<HTMLTextAreaElement>(".ahc-suggestion textarea")!;
    await act(async () => suggestion.dispatchEvent(new Event("scroll")));
    expect(host.querySelector(".annotation-hover-card")).not.toBeNull();

    await act(async () => document.dispatchEvent(new Event("scroll")));
    expect(host.querySelector(".annotation-hover-card")).toBeNull();
    await act(async () => {
      firstAnchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(80);
    });

    const reopenedSuggestion = host.querySelector<HTMLTextAreaElement>(".ahc-suggestion textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(reopenedSuggestion, "改成五月发布");
      reopenedSuggestion.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host!.querySelector<HTMLButtonElement>(".ahc-accept")!.click());
    expect(host.querySelector('[data-testid="chat-input"]')?.textContent).toBe("已有草稿\n按批注修改：「甲组原句」——改成五月发布（批注：事实有误；原因：时间与资料不一致；定位：块 p，PM 1-3）");
    expect(editorHost!.querySelector('[data-annotation-group="g1"]')?.classList.contains("annotation-anchor-active")).toBe(true);
    expect(host.querySelector(".annotation-hover-card")).toBeNull();

    await act(async () => {
      secondAnchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(80);
    });
    await act(async () => host!.querySelector<HTMLButtonElement>(".ahc-ignore")!.click());
    expect(editorHost!.querySelector('[data-annotation-group="g2"]')).toBeNull();
  });

  it("翻页卡暂隐时 mouseout 与 mouseleave 推满关闭延时仍被导航 pin 保住", async () => {
    vi.useFakeTimers();
    createEditor();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    function Harness() {
      useEffect(() => installAnnotationGroupDecorations(editor!, groups), []);
      return <AnnotationCarousel
        groups={groups}
        editorDom={editor!.view.dom}
        onAccept={() => true}
        onIgnore={() => undefined}
      />;
    }

    await act(async () => root!.render(<Harness />));
    const firstAnchor = editorHost!.querySelector<HTMLElement>('[data-annotation-group="g1"]')!;
    const secondAnchor = editorHost!.querySelector<HTMLElement>('[data-annotation-group="g2"]')!;
    Object.defineProperty(secondAnchor, "scrollIntoView", {
      configurable: true,
      value: () => undefined,
    });
    await act(async () => {
      firstAnchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(80);
    });

    const card = host!.querySelector<HTMLElement>(".annotation-hover-card")!;
    await act(async () => card.querySelector<HTMLButtonElement>('[aria-label="下一处批注"]')!.click());
    expect(card.dataset.groupId).toBe("g2");
    expect(card.style.visibility).toBe("hidden");

    await act(async () => {
      firstAnchor.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
      card.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
      card.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: document.body }));
      firstAnchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
      vi.advanceTimersByTime(150);
    });

    expect(host!.querySelector<HTMLElement>(".annotation-hover-card")?.dataset.groupId).toBe("g2");
    expect(card.style.visibility).toBe("visible");

    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(host!.querySelector<HTMLElement>(".annotation-hover-card")?.dataset.groupId).toBe("g2");

    await act(async () => {
      card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
      vi.advanceTimersByTime(1_000);
    });
    expect(host!.querySelector<HTMLElement>(".annotation-hover-card")?.dataset.groupId).toBe("g2");
  });

  it("自定义与预置审查共用 active 锚点，hover 均可开卡且自定义意见可回填", async () => {
    vi.useFakeTimers();
    createEditor();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const reviewGroups: AnnotationGroup[] = [
      {
        id: "custom-publish",
        summary: "对外发布风险",
        note: "内部项目代号不宜直接公开。",
        origin: "自定义审查:对外发布",
        suggestion: "改为某内部项目",
        status: "reviewing",
        anchors: [{ blockId: "p", pmFrom: 1, pmTo: 3, quote: "甲组", textHash: "custom-hash" }],
      },
      {
        ...groups[1]!,
        id: "preset-consistency",
        anchors: [{ blockId: "p", pmFrom: 3, pmTo: 5, quote: "乙组", textHash: "preset-hash" }],
      },
    ];

    function Harness() {
      const [input, setInput] = useState("");
      useEffect(() => installAnnotationGroupDecorations(editor!, reviewGroups), []);
      return <>
        <div data-testid="chat-input">{input}</div>
        <AnnotationCarousel
          groups={reviewGroups}
          editorDom={editor!.view.dom}
          onAccept={(group, suggestion) => {
            setInput(buildAnnotationInstruction(group, suggestion));
            return true;
          }}
          onIgnore={() => undefined}
        />
      </>;
    }

    await act(async () => root!.render(<Harness />));
    const customAnchor = editorHost!.querySelector<HTMLElement>(
      '.annotation-anchor-active[data-annotation-group="custom-publish"]',
    );
    const presetAnchor = editorHost!.querySelector<HTMLElement>(
      '.annotation-anchor-active[data-annotation-group="preset-consistency"]',
    );
    expect(customAnchor).not.toBeNull();
    expect(presetAnchor).not.toBeNull();

    await act(async () => {
      customAnchor!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(80);
    });
    expect(host!.querySelector<HTMLElement>(".annotation-hover-card")?.dataset.groupId)
      .toBe("custom-publish");
    expect(host!.textContent).toContain("对外发布风险");
    expect(host!.querySelector<HTMLTextAreaElement>(".ahc-suggestion textarea")?.value)
      .toBe("改为某内部项目");
    await act(async () => host!.querySelector<HTMLButtonElement>(".ahc-accept")!.click());
    expect(host!.querySelector('[data-testid="chat-input"]')?.textContent)
      .toContain("按批注修改：「甲组」——改为某内部项目");

    await act(async () => {
      presetAnchor!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(80);
    });
    expect(host!.querySelector<HTMLElement>(".annotation-hover-card")?.dataset.groupId)
      .toBe("preset-consistency");
    expect(host!.textContent).toContain("表述重复");
  });

  it("回填文案以简短来源标记开头，原句按 30 字截断", () => {
    const longQuote = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一";
    expect(buildAnnotationInstruction({ ...groups[0]!, anchors: [{ ...groups[0]!.anchors[0]!, quote: longQuote }] }))
      .toBe("按批注修改：「一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十…」——改为四月发布（批注：事实有误；原因：时间与资料不一致；定位：块 p，PM 1-3）");
  });

  it("空修改意见回退为批注原因自身，不生成静默空指令", () => {
    expect(buildAnnotationInstruction({ ...groups[0]!, suggestion: undefined }, "   "))
      .toBe("按批注修改：「甲组原句」——时间与资料不一致（批注：事实有误；原因：时间与资料不一致；定位：块 p，PM 1-3）");
  });

  it("隐私批注进入前端状态和生成修改指令时保持打码，并携带结构锚点", () => {
    const rawGroup: AnnotationGroup = {
      id: "privacy-raw",
      summary: "手机号 13912345678 未脱敏",
      note: "「13912345678」是手机号。",
      origin: "privacy",
      suggestion: "改为 139****5678。",
      status: "reviewing",
      anchors: [{
        blockId: "contact-table",
        pmFrom: 42,
        pmTo: 53,
        quote: "13912345678",
        textHash: "ba6c167e885ea4be8252fb01",
      }],
    };
    const state = workspaceReducer(initialWorkspaceState, {
      kind: "annotationGroupsReady",
      data: { groups: [rawGroup], replacedOrigins: ["privacy"] },
    });
    const saved = state.annotationGroups[0]!;
    const instruction = buildAnnotationInstruction(saved);

    expect(saved).toMatchObject({
      summary: "手机号 139****5678 未脱敏",
      note: "「139****5678」是手机号。",
      anchors: [{
        quote: "139****5678",
        blockId: "contact-table",
        pmFrom: 42,
        pmTo: 53,
        textHash: "span:contact-table:42:53",
      }],
    });
    expect(instruction).toContain("定位：块 contact-table，PM 42-53");
    expect(instruction).toContain("139****5678");
    expect(instruction).not.toContain("13912345678");
  });

  it("严重度计数只在模板输出分级后显示，缺省项按建议档计数", () => {
    expect(buildAnnotationSeveritySummary(groups)).toBeNull();
    expect(buildAnnotationSeveritySummary([
      { ...groups[0]!, severity: "error" },
      { ...groups[1]!, severity: "warn" },
      { ...groups[1]!, id: "g3", severity: "info" },
      { ...groups[1]!, id: "g4" },
    ])).toBe("1 严重 · 2 建议 · 1 提示");
  });

  it("装饰节点透传三档严重度，未分级按 warn 保持现状", () => {
    createEditor();
    const uninstall = installAnnotationGroupDecorations(editor!, [
      { ...groups[0]!, severity: "error", anchors: [{ ...groups[0]!.anchors[0]!, quote: "甲组" }] },
      { ...groups[1]!, severity: "info", anchors: [{ ...groups[1]!.anchors[0]!, quote: "乙组" }] },
    ]);
    expect(editorHost!.querySelector('[data-annotation-group="g1"]')?.getAttribute("data-annotation-severity")).toBe("error");
    expect(editorHost!.querySelector('[data-annotation-group="g2"]')?.getAttribute("data-annotation-severity")).toBe("info");
    uninstall();

    const fallback = installAnnotationGroupDecorations(editor!, [{
      ...groups[0]!,
      anchors: [{ ...groups[0]!.anchors[0]!, quote: "甲组" }],
    }]);
    expect(editorHost!.querySelector('[data-annotation-group="g1"]')?.getAttribute("data-annotation-severity")).toBe("warn");
    fallback();
  });

  it("交叠区 hover 显示此处多条并可逐条切换", async () => {
    vi.useFakeTimers();
    createEditor();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const overlapping = [
      { ...groups[0]!, anchors: [{ ...groups[0]!.anchors[0]!, quote: "甲组" }] },
      { ...groups[1]!, anchors: [{ ...groups[1]!.anchors[0]!, pmFrom: 1, pmTo: 3, quote: "甲组" }] },
    ];

    function Harness() {
      useEffect(() => installAnnotationGroupDecorations(editor!, overlapping), []);
      return <AnnotationCarousel groups={overlapping} editorDom={editor!.view.dom} onAccept={() => true} onIgnore={() => undefined} />;
    }

    await act(async () => root!.render(<Harness />));
    const anchors = editorHost!.querySelectorAll<HTMLElement>(".annotation-anchor-active");
    expect(anchors.length).toBeGreaterThan(0);
    const deepest = Array.from(anchors).find((anchor) => anchor.dataset.annotationOverlap === "true") ?? anchors[0]!;
    expect(deepest.dataset.annotationGroups?.split(",").sort()).toEqual(["g1", "g2"]);
    await act(async () => {
      deepest.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(80);
    });

    expect(host!.textContent).toContain("此处 2 条 · 第 1 / 共 2 条");
    const firstId = host!.querySelector<HTMLElement>(".annotation-hover-card")?.dataset.groupId;
    await act(async () => host!.querySelector<HTMLButtonElement>('[aria-label="下一处批注"]')!.click());
    expect(host!.querySelector<HTMLElement>(".annotation-hover-card")?.dataset.groupId).not.toBe(firstId);
    expect(host!.textContent).toContain("此处 2 条 · 第 2 / 共 2 条");
  });

  function createEditor() {
    editorHost = document.createElement("div");
    document.body.appendChild(editorHost);
    editor = new Editor({ element: editorHost, extensions: createQingagentExtensions(), content: "<p>甲组乙组</p>" });
  }
});

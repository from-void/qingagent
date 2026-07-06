// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, DocSuggestion, ToolCallSpec } from "../data/protocol";
import {
  buildWholeDocReviewKey,
  buildEmptyHintTypewriterPlan,
  ChatMessageList,
  EMPTY_HINT_TEXT,
  splitStreamingInlineRuns,
} from "./ChatMessageList";

const inkBubbleRenderSpy = vi.hoisted(() => vi.fn());

vi.mock("../../../system", async (importOriginal) => {
  const React = await import("react");
  const actual = await importOriginal<typeof import("../../../system")>();

  return {
    ...actual,
    InkBubble: ({
      animate,
      children,
      className,
    }: {
      animate?: boolean;
      children?: unknown;
      className?: string;
    }) => {
      inkBubbleRenderSpy({ animate, className });
      return React.createElement(
        "div",
        { className, "data-wf": "InkBubbleMock", "data-animate": String(animate) },
        children as ReactNode,
      );
    },
  };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let restoreMatchMedia: (() => void) | null = null;

describe("ChatMessageList", () => {
  afterEach(() => {
    restoreMatchMedia?.();
    restoreMatchMedia = null;
    inkBubbleRenderSpy.mockClear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
  });

  it("skill/skill_read 工具卡技能名使用 skills API label", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/api/v1/skills")) {
          return new Response(
            JSON.stringify({
              skills: [
                {
                  name: "materials",
                  description: "读取资料",
                  label: "读资料",
                  summary: "读取上传文件与资料库并引用",
                  icon: "materials",
                  source: "builtin",
                  userInvocable: false,
                  tools: ["readDocument", "searchDocuments"],
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
    const skillRead: ToolCallSpec = {
      id: "tc-skill-read",
      name: "skill_read",
      render: { kind: "chatInline" },
      status: { kind: "done" },
      body: { kind: "generic", data: { argsJson: "{\"id\":\"materials\"}" } },
      result: null,
    };
    const messages: ChatMessage[] = [
      {
        id: "m-skill-read",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "toolCall", data: skillRead }],
        chips: null,
      },
    ];

    await render(<ChatMessageList messages={messages} streamActive={false} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host?.textContent).toContain("读取技能");
    expect(host?.textContent).toContain("读资料");
    expect(host?.textContent).not.toContain("materials");
  });

  it("streamActive 再久也不再出现『正在等待模型响应』兜底文案(已改为输入框发光)", async () => {
    vi.useFakeTimers();
    await render(
      <ChatMessageList
        messages={[]}
        streamActive
      />,
    );

    expect(host?.querySelector('[data-wf="LongTaskNotice"]')).toBeNull();
    // 即便长时间挂着流,也不再弹出文案——请求在途改由输入框环境辉光表示。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(host?.querySelector('[data-wf="LongTaskNotice"]')).toBeNull();
    expect(host?.textContent ?? "").not.toContain("正在等待模型响应");
  });

  it("空态开场白打字机计划保持轻量节奏并最终到全文", () => {
    expect(EMPTY_HINT_TEXT).toBe(
      "你好,我是青简。想写点什么,可以直接在右侧动笔、挑个模板起头,也可以告诉我——比如「写一份面向投资人的产品 PRD」,我来帮你查资料、搭结构、写成稿。",
    );
    const plan = buildEmptyHintTypewriterPlan(EMPTY_HINT_TEXT);
    const textLength = Array.from(EMPTY_HINT_TEXT).length;
    let previousLength = 0;
    const chunks = plan.map((step) => {
      const chunk = step.nextLength - previousLength;
      previousLength = step.nextLength;
      return chunk;
    });

    expect(plan.at(-1)?.nextLength).toBe(textLength);
    expect(chunks.every((chunk) => chunk >= 2 && chunk <= 3)).toBe(true);
    expect(plan.every((step) => step.delayMs >= 30 && step.delayMs <= 50)).toBe(true);
    expect(plan.reduce((sum, step) => sum + step.delayMs, 0)).toBeLessThanOrEqual(2_000);
  });

  it("空态开场白复用 StreamingChars 柔焦渐显,同一挂载 rerender 不重打", async () => {
    vi.useFakeTimers();
    mockReducedMotion(false);

    await render(<ChatMessageList messages={[]} streamActive={false} />);

    const hint = host?.querySelector('[data-wf="ChatEmptyHint"]');
    expect(hint).not.toBeNull();
    expect(hint?.textContent ?? "").toBe("");
    expect(hint?.querySelector(".sfx-seg")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    const partial = hint?.textContent ?? "";
    expect(partial.length).toBeGreaterThan(0);
    expect(EMPTY_HINT_TEXT.startsWith(partial)).toBe(true);
    expect(partial).not.toBe(EMPTY_HINT_TEXT);
    const animatedSegs = hint?.querySelectorAll(".sfx-seg.sfx-blur") ?? [];
    expect(animatedSegs.length).toBe(Array.from(partial).length);

    await act(async () => {
      root?.render(<ChatMessageList messages={[]} streamActive />);
    });
    expect(host?.querySelector('[data-wf="ChatEmptyHint"]')?.textContent ?? "").toBe(partial);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(host?.querySelector('[data-wf="ChatEmptyHint"]')?.textContent ?? "").toBe(EMPTY_HINT_TEXT);
  });

  it("prefers-reduced-motion 时空态开场白立即显示全文", async () => {
    vi.useFakeTimers();
    mockReducedMotion(true);

    await render(<ChatMessageList messages={[]} streamActive={false} />);

    const hint = host?.querySelector('[data-wf="ChatEmptyHint"]');
    expect(hint?.textContent ?? "").toBe(EMPTY_HINT_TEXT);
    expect(hint?.querySelector(".sfx-seg")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(hint?.textContent ?? "").toBe(EMPTY_HINT_TEXT);
    expect(hint?.querySelector(".sfx-seg")).toBeNull();
  });

  it("does not render submitted questionnaire summary for empty non-answer askUser", async () => {
    const emptyAskUser: ToolCallSpec = {
      id: "tc-empty",
      name: "askUser",
      render: { kind: "rightForm" },
      status: { kind: "done" },
      body: {
        kind: "askUser",
        data: {
          id: "ask-empty",
          mode: { kind: "fullpage" },
          purpose: null,
          source: null,
          rationale: null,
          questions: [],
        },
      },
      result: { kind: "genericText", data: "已提交" },
    };
    const messages: ChatMessage[] = [
      {
        id: "m1",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "toolCall", data: emptyAskUser }],
        chips: null,
      },
    ];

    await render(
      <ChatMessageList
        messages={messages}
        streamActive={false}
      />,
    );

    expect(host?.textContent ?? "").not.toContain("已提交问卷");
    expect(host?.querySelector(".askuser-card")).toBeNull();
  });

  it("默认不渲染 system 消息和 agent 内部 marker 文本", async () => {
    const messages: ChatMessage[] = [
      {
        id: "m-system",
        role: { kind: "system" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", data: { body: "SYSTEM SECRET: do not show" } }],
        chips: null,
      },
      {
        id: "m-internal",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:01.000Z",
        parts: [
          {
            kind: "text",
            data: {
              body: '```json\n{"blocks":[{"id":"block-a","numericValue":3}]}\n```',
            },
          },
          { kind: "text", data: { body: "[tool-result] raw args/result" } },
          { kind: "text", data: { body: "这是可见回复" } },
        ],
        chips: null,
      },
    ];

    await render(
      <ChatMessageList
        messages={messages}
        streamActive={false}
      />,
    );

    const text = host?.textContent ?? "";
    expect(text).not.toContain("SYSTEM SECRET");
    expect(text).not.toContain("block-a");
    expect(text).not.toContain("numericValue");
    expect(text).not.toContain("[tool-result]");
    expect(text).toContain("这是可见回复");
    expect(host?.querySelector('[data-wf="ChatMsg-system"]')).toBeNull();
  });

  it("用户气泡里的 skill chip 仍复用 mention 展示样式", async () => {
    const messages: ChatMessage[] = [
      {
        id: "m-user-skill-chip",
        role: { kind: "user" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", data: { body: "用{{chip:0}}写摘要" } }],
        chips: [
          {
            kind: { kind: "skill" },
            resourceRef: null,
            skillId: "feishu",
            prefix: null,
            label: "连飞书",
            suffix: null,
            text: null,
          },
        ],
      },
    ];

    await render(<ChatMessageList messages={messages} streamActive={false} />);

    const chip = host?.querySelector<HTMLElement>(".chat-chip");
    expect(chip?.dataset.kind).toBe("mention");
    expect(host?.textContent ?? "").toContain("用连飞书写摘要");
  });

  it("用户回流的审核反馈卡不套用户气泡", async () => {
    const messages: ChatMessage[] = [
      {
        id: "m-review-outcome",
        role: { kind: "user" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [
          {
            kind: "reviewOutcome",
            data: {
              acceptedCount: 1,
              rejectedCount: 1,
              hunks: [
                { verdict: "accepted", blockSummary: "第一处", beforeText: "旧", afterText: "新" },
                { verdict: "rejected", blockSummary: "第二处", beforeText: "保留", afterText: "改写" },
              ],
            },
          },
        ],
        chips: null,
      },
    ];

    await render(<ChatMessageList messages={messages} streamActive={false} />);

    const card = host?.querySelector<HTMLElement>('[data-wf="ReviewOutcomeCard"]');
    expect(card).not.toBeNull();
    expect(card?.closest(".wf-msg.user")).toBeNull();
    expect(host?.querySelector('[data-wf="InkBubbleMock"]')).toBeNull();
    expect(host?.textContent ?? "").toContain("采纳 1 处 · 拒绝 1 处");
  });

  it("用户回流的问卷答案卡复用 BigPlanPanel 样式类且不套用户气泡", async () => {
    const messages: ChatMessage[] = [
      {
        id: "m-ask-answer",
        role: { kind: "user" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [
          {
            kind: "askUserAnswerCard",
            data: {
              toolCallId: "ask-1",
              title: "已提交写作方向问卷",
              items: [
                {
                  questionId: "q-tone",
                  questionLabel: "希望怎么改？",
                  answerText: "更克制",
                  selectedOptionLabels: ["更克制"],
                  freeText: null,
                  numericText: null,
                },
              ],
            },
          },
        ],
        chips: null,
      },
    ];

    await render(<ChatMessageList messages={messages} streamActive={false} />);

    const card = host?.querySelector<HTMLElement>('[data-wf="AskUserAnswerCard"]');
    expect(card?.classList.contains("bigplan-panel")).toBe(true);
    expect(card?.querySelector(".bp-head h2")?.textContent).toBe("已提交写作方向问卷");
    expect(card?.querySelector(".bp-q")).not.toBeNull();
    expect(card?.querySelector(".bp-opt.on")?.textContent).toContain("更克制");
    expect(card?.closest(".wf-msg.user")).toBeNull();
    expect(host?.querySelector('[data-wf="InkBubbleMock"]')).toBeNull();
  });

  it("当前 reveal 进行中时历史 patchSummary 不误显示 loading", async () => {
    const messages: ChatMessage[] = [
      {
        id: "m-history",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "patchSummary", data: { count: 2, hunkIds: ["old-a", "old-b"] } }],
        chips: null,
      },
    ];

    await render(
      <ChatMessageList
        messages={messages}
        streamActive={false}
        patchRevealing
        livePatchCount={1}
        liveHunkKey="new-a"
      />,
    );

    expect(host?.textContent ?? "").toContain("已修改 2 处");
    expect(host?.textContent ?? "").not.toContain("正在应用修改");
  });

  it("已放弃的历史 patchSummary 不再显示已修改计数", async () => {
    type PatchSummaryPart = Extract<ChatMessage["parts"][number], { kind: "patchSummary" }>;
    const messages: ChatMessage[] = [
      {
        id: "m-abandoned",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [
          {
            kind: "patchSummary",
            data: {
              count: 2,
              hunkIds: ["h1", "h2"],
              reviewOutcome: "abandoned",
            } as PatchSummaryPart["data"] & { reviewOutcome: "abandoned" },
          },
        ],
        chips: null,
      },
    ];

    await render(
      <ChatMessageList
        messages={messages}
        streamActive={false}
      />,
    );

    const text = host?.textContent ?? "";
    expect(text).toContain("本轮候选已放弃");
    expect(text).not.toContain("已修改 2 处");
  });

  it("整篇审历史记忆必须同时匹配 session 和 hunkKey", async () => {
    const messages: ChatMessage[] = [
      {
        id: "m-review",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "patchSummary", data: { count: 1, hunkIds: ["same-hunk"] } }],
        chips: null,
      },
    ];
    const sameHunkOldSession = buildWholeDocReviewKey("s-old", "same-hunk");
    const sameHunkCurrentSession = buildWholeDocReviewKey("s-new", "same-hunk");

    await render(
      <ChatMessageList
        messages={messages}
        streamActive={false}
        sessionId="s-new"
        wholeDocReviewKeys={new Set([sameHunkOldSession!])}
      />,
    );

    expect(host?.textContent ?? "").toContain("已修改 1 处");
    expect(host?.textContent ?? "").not.toContain("整篇改写");

    await act(async () => {
      root?.render(
        <ChatMessageList
          messages={messages}
          streamActive={false}
          sessionId="s-new"
          wholeDocReviewKeys={new Set([sameHunkCurrentSession!])}
        />,
      );
    });

    expect(host?.textContent ?? "").toContain("整篇改写");
  });

  it("同一 messages 下无关 prop 变化不会重渲旧消息行", async () => {
    const messages: ChatMessage[] = [
      {
        id: "m-user",
        role: { kind: "user" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", data: { body: "帮我润色这一段" } }],
        chips: null,
      },
    ];

    await render(
      <ChatMessageList
        messages={messages}
        streamActive={false}
        showLoading={false}
      />,
    );

    expect(inkBubbleRenderSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      root?.render(
        <ChatMessageList
          messages={messages}
          streamActive={false}
          showLoading
        />,
      );
    });

    expect(host?.textContent ?? "").toContain("帮我润色这一段");
    expect(host?.textContent ?? "").toContain("正在生成内容");
    expect(inkBubbleRenderSpy).toHaveBeenCalledTimes(1);
  });

  it("memo 后最后一条流式助手消息仍会刷新", async () => {
    const messages: ChatMessage[] = [
      {
        id: "m-agent",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "thinking", data: { id: "think-1", steps: ["正在分析结构"] } }],
        chips: null,
      },
    ];

    await render(
      <ChatMessageList
        messages={messages}
        streamActive={false}
        debugMode
      />,
    );

    expect(host?.textContent ?? "").toContain("已思考");

    await act(async () => {
      root?.render(
        <ChatMessageList
          messages={messages}
          streamActive
          debugMode
        />,
      );
    });

    expect(host?.textContent ?? "").toContain("思考中");
  });

  it("docSuggestion 工具帧渲染为局部修改状态行", async () => {
    const suggestion: DocSuggestion = {
      id: "patch-1",
      docId: "doc-1",
      baseVersion: 1,
      baseSchemaVersion: 1,
      status: "reviewing",
      anchor: {
        blockId: "block-1",
        pmFrom: 0,
        pmTo: 4,
        quote: "三月阳光",
        textHash: "hash-1",
      },
      patch: { kind: "prosemirror_steps", steps: [] },
      preview: { deleteText: "三月阳光", insertText: "四月暖阳" },
      summary: "将三月阳光改为四月暖阳",
    };
    const spec: ToolCallSpec = {
      id: suggestion.id,
      name: "docSuggestion",
      render: { kind: "docInlinePatch" },
      status: { kind: "reviewing" },
      body: { kind: "docSuggestion", data: { kind: "suggestion", data: suggestion } },
      result: null,
    };
    const messages: ChatMessage[] = [
      {
        id: "m-suggestion",
        role: { kind: "agent" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "toolCall", data: spec }],
        chips: null,
      },
    ];

    await render(<ChatMessageList messages={messages} streamActive={false} />);

    expect(host?.querySelector('[data-wf="ToolCall"]')).not.toBeNull();
    expect(host?.textContent ?? "").toContain('修改"三月阳光" · 待审阅');
  });

  // —— 轮级过程折叠(出最终回复就折) ——
  const genTool = (id: string, name: string): ToolCallSpec => ({
    id,
    name,
    render: { kind: "chatInline" },
    status: { kind: "done" },
    body: { kind: "generic", data: { argsJson: "{}" } },
    result: null,
  });
  const turn = (parts: ChatMessage["parts"]): ChatMessage => ({
    id: "m-turn",
    role: { kind: "agent" },
    ts: "2026-01-01T00:00:00.000Z",
    parts,
    chips: null,
  });

  it("完成轮(工具+最终正文)折成「过程·N步」,最终回复可见、过程默认隐藏、点开展开", async () => {
    const messages: ChatMessage[] = [
      turn([
        { kind: "toolCall", data: genTool("t1", "webSearch") },
        { kind: "toolCall", data: genTool("t2", "readDraft") },
        { kind: "text", data: { body: "这是最终回复" } },
      ]),
    ];
    await render(<ChatMessageList messages={messages} streamActive={false} />);
    const fold = host?.querySelector<HTMLButtonElement>(".u-procdiv");
    expect(fold).not.toBeNull();
    expect(host?.textContent ?? "").toContain("过程 · 2 步");
    expect(host?.textContent ?? "").toContain("这是最终回复");
    // 默认折叠:过程里的工具(联网搜索/读取草稿)不显示
    expect(host?.querySelector(".u-bar")).toBeNull();
    expect(fold?.getAttribute("aria-expanded")).toBe("false");
    // 点开 → 过程工具出现
    await act(async () => {
      fold?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(fold?.getAttribute("aria-expanded")).toBe("true");
    expect(host?.querySelectorAll(".u-bar").length).toBe(2);
  });

  it("进行中的轮(streamActive)不折叠,过程平铺", async () => {
    const messages: ChatMessage[] = [
      turn([
        { kind: "toolCall", data: genTool("t1", "webSearch") },
        { kind: "text", data: { body: "正在回复…" } },
      ]),
    ];
    await render(<ChatMessageList messages={messages} streamActive />);
    expect(host?.querySelector(".u-procdiv")).toBeNull();
    expect(host?.querySelector(".u-bar")).not.toBeNull();
  });

  it("出问卷(askUser)的轮不折叠——那不算最终回复,要保持可交互", async () => {
    const askUser: ToolCallSpec = {
      id: "ask",
      name: "askUser",
      render: { kind: "rightForm" },
      status: { kind: "pending" },
      body: { kind: "askUser", data: { mode: { kind: "overlay" }, questions: [], source: null } } as unknown as ToolCallSpec["body"],
      result: null,
    };
    const messages: ChatMessage[] = [
      turn([
        { kind: "toolCall", data: genTool("t1", "webSearch") },
        { kind: "text", data: { body: "请确认方向" } },
        { kind: "toolCall", data: askUser },
      ]),
    ];
    await render(<ChatMessageList messages={messages} streamActive={false} />);
    expect(host?.querySelector(".u-procdiv")).toBeNull();
  });

  it("审批已结清(非 live)的修改轮:过程折叠,「已修改 N 处」作为最终结果留在折叠条外", async () => {
    const messages: ChatMessage[] = [
      turn([
        { kind: "toolCall", data: genTool("t1", "editDraft") },
        { kind: "text", data: { body: "已生成修改" } },
        { kind: "patchSummary", data: { count: 2, hunkIds: ["h1", "h2"] } },
      ]),
    ];
    await render(<ChatMessageList messages={messages} streamActive={false} />);
    expect(host?.querySelector(".u-procdiv")).not.toBeNull();
    expect(host?.textContent ?? "").toContain("过程 · 1 步");
    expect(host?.textContent ?? "").toContain("已修改 2 处");
  });

  it("审批进行中(live · 待确认)的修改轮不折叠——接受/放弃后才折", async () => {
    const messages: ChatMessage[] = [
      turn([
        { kind: "toolCall", data: genTool("t1", "editDraft") },
        { kind: "text", data: { body: "已生成修改" } },
        { kind: "patchSummary", data: { count: 2, hunkIds: ["h1", "h2"] } },
      ]),
    ];
    // liveHunkKey 命中本轮 patch(getPatchSummaryKey(["h1","h2"])="h1,h2")→ 待审批 → 不折
    await render(
      <ChatMessageList
        messages={messages}
        streamActive={false}
        liveHunkKey="h1,h2"
        livePatchCount={2}
      />,
    );
    expect(host?.querySelector(".u-procdiv")).toBeNull();
  });

  it("最终文案后还跟着工具调用(未输出完)时不折叠", async () => {
    const messages: ChatMessage[] = [
      turn([
        { kind: "toolCall", data: genTool("t1", "webSearch") },
        { kind: "text", data: { body: "中间说明" } },
        { kind: "toolCall", data: genTool("t2", "editDraft") },
      ]),
    ];
    await render(<ChatMessageList messages={messages} streamActive={false} />);
    expect(host?.querySelector(".u-procdiv")).toBeNull();
  });
});

async function render(element: ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
  });
}

function mockReducedMotion(matches: boolean): void {
  const originalMatchMedia = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: query === "(prefers-reduced-motion: reduce)" ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
  restoreMatchMedia = () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  };
}

// 0702:流式最后一行内联实时渲染。流式半截输入就是"脏路径",逐形态枚举。
describe("splitStreamingInlineRuns", () => {
  it("完整 **粗** 对切成 plain/bold/plain,start=可见内容原文偏移", () => {
    expect(splitStreamingInlineRuns("你选择了**聚焦WAIC**、继续")).toEqual([
      { kind: "plain", text: "你选择了", start: 0 },
      { kind: "bold", text: "聚焦WAIC", start: 6 },
      { kind: "plain", text: "、继续", start: 14 },
    ]);
  });

  it("尾部未闭合 ** 乐观按加粗渲染,闭合后内容 start 不变(动画 key 稳定)", () => {
    const open = splitStreamingInlineRuns("好的,**专业正式");
    expect(open).toEqual([
      { kind: "plain", text: "好的,", start: 0 },
      { kind: "bold", text: "专业正式", start: 5 },
    ]);
    const closed = splitStreamingInlineRuns("好的,**专业正式**。");
    expect(closed[1]).toEqual({ kind: "bold", text: "专业正式", start: 5 });
    expect(closed[2]).toEqual({ kind: "plain", text: "。", start: 11 });
  });

  it("行尾裸 **(尚无内容)不产出空 bold run,前文照常", () => {
    expect(splitStreamingInlineRuns("先说一句**")).toEqual([
      { kind: "plain", text: "先说一句", start: 0 },
    ]);
  });

  it("行内码与完整链接照 renderInline 同规则样式化", () => {
    expect(splitStreamingInlineRuns("用 `pnpm dev` 见 [文档](https://a.b/c) 了解")).toEqual([
      { kind: "plain", text: "用 ", start: 0 },
      { kind: "code", text: "pnpm dev", start: 3 },
      { kind: "plain", text: " 见 ", start: 12 },
      { kind: "link", text: "文档", href: "https://a.b/c", start: 16 },
      { kind: "plain", text: " 了解", start: 34 },
    ]);
  });

  it("BMP 外码点(emoji)在前,偏移按字符计不漂移", () => {
    expect(splitStreamingInlineRuns("😊😊**粗体**尾")).toEqual([
      { kind: "plain", text: "😊😊", start: 0 },
      { kind: "bold", text: "粗体", start: 4 },
      { kind: "plain", text: "尾", start: 8 },
    ]);
  });

  it("无任何标记时整行一个 plain run", () => {
    expect(splitStreamingInlineRuns("平平无奇的一行")).toEqual([
      { kind: "plain", text: "平平无奇的一行", start: 0 },
    ]);
  });

  it("用户报障原句:两个粗体对全部实时样式化", () => {
    const runs = splitStreamingInlineRuns(
      "好的，你选择了**聚焦WAIC大会**、**专业正式风格**。我这就基于素材撰写新闻稿。",
    );
    expect(runs.filter((r) => r.kind === "bold").map((r) => r.text)).toEqual([
      "聚焦WAIC大会",
      "专业正式风格",
    ]);
    expect(runs.map((r) => r.kind)).toEqual(["plain", "bold", "plain", "bold", "plain"]);
  });
});

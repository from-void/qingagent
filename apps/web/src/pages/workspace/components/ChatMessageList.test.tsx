// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatMessage,
  DocSuggestion,
  ToolCallSpec,
  WorkspaceAction,
} from "../data/protocol";
import { sanitizeVisibleText, serializeChipRichText } from "@qingagent/contract-ts";
import {
  buildWholeDocReviewKey,
  buildEmptyHintTypewriterPlan,
  ChatMessageList,
  EMPTY_HINT_TEXT,
  isAwaitingModelSegment,
  parseExternalClient,
  renderSimpleMarkdown,
  shouldShowPreTokenLoading,
  splitStreamingInlineRuns,
} from "./ChatMessageList";
import { resources } from "../../../system/resources";
import {
  initialWorkspaceState,
  workspaceReducer,
} from "../data/workspaceState";

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

function userMessage(id = "m-user"): ChatMessage {
  return {
    id,
    role: { kind: "user" },
    ts: "2026-01-01T00:00:00.000Z",
    parts: [{ kind: "text", data: { body: "写一段开头" } }],
    chips: null,
  };
}

type AskUserAnswersData = Extract<
  NonNullable<ToolCallSpec["result"]>,
  { kind: "askUserAnswers" }
>["data"];

const answeredAskUserData: AskUserAnswersData = {
  "q-tone": { chosen: ["restrained"], freeText: null, numericValue: null },
};

function askUserToolCall(
  id: string,
  status: ToolCallSpec["status"] = { kind: "done" },
  mode: "overlay" | "fullpage" = "overlay",
  answers: AskUserAnswersData = answeredAskUserData,
): ToolCallSpec {
  return {
    id,
    name: "askUser",
    render: { kind: "rightForm" },
    status,
    body: {
      kind: "askUser",
      data: {
        id: `ask-${id}`,
        mode: { kind: mode },
        purpose: null,
        source: "确认方向",
        rationale: null,
        questions: [
          {
            id: "q-tone",
            label: "希望怎么改？",
            kind: { kind: "single" },
            options: [
              {
                value: "restrained",
                label: "更克制",
                description: null,
                preview: null,
              },
            ],
            placeholder: null,
            slider: null,
          },
        ],
      },
    },
    result: { kind: "askUserAnswers", data: answers },
  };
}

function agentToolMessage(spec: ToolCallSpec, id = `m-${spec.id}`): ChatMessage {
  return {
    id,
    role: { kind: "agent" },
    ts: "2026-01-01T00:00:00.000Z",
    parts: [{ kind: "toolCall", data: spec }],
    chips: null,
  };
}

function askUserAnswerCardMessage(toolCallId: string, id = `answer-${toolCallId}`): ChatMessage {
  return {
    id,
    role: { kind: "user" },
    ts: "2026-01-01T00:00:01.000Z",
    parts: [
      {
        kind: "askUserAnswerCard",
        data: {
          toolCallId,
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
  };
}

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
    resources.reset();
    host?.remove();
    host = null;
  });

  it("shouldShowPreTokenLoading 只在流进行且末条为用户消息时显示", () => {
    const message = userMessage();
    const agentMessage: ChatMessage = {
      id: "m-agent",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:01.000Z",
      parts: [{ kind: "thinking", data: { id: "think-1", steps: ["正在分析"] } }],
      chips: null,
    };

    expect(shouldShowPreTokenLoading([], false)).toBe(false);
    expect(shouldShowPreTokenLoading([message], false)).toBe(false);
    expect(shouldShowPreTokenLoading([message], true)).toBe(true);
    expect(shouldShowPreTokenLoading([message, agentMessage], true)).toBe(false);
  });

  it("isAwaitingModelSegment 覆盖无 reasoning 的等待窗,不误报正文/运行中工具", () => {
    const tool = (status: ToolCallSpec["status"]): ToolCallSpec => ({
      id: `t-${status.kind}`,
      name: "webSearch",
      render: { kind: "chatInline" },
      status,
      body: { kind: "generic", data: { argsJson: "{}" } },
      result: null,
    });

    // 空 agent 消息 = 请求已发出、一个 part 都没回。
    expect(isAwaitingModelSegment(undefined)).toBe(true);
    expect(isAwaitingModelSegment({ kind: "thinking", data: { id: "t", steps: ["嗯"] } })).toBe(true);
    // 工具跑完等模型续写:这正是自定义网关最常静默的那几十秒。
    expect(isAwaitingModelSegment({ kind: "toolCall", data: tool({ kind: "done" }) })).toBe(true);
    expect(isAwaitingModelSegment({ kind: "toolCall", data: tool({ kind: "aborted" }) })).toBe(true);
    expect(isAwaitingModelSegment({ kind: "toolCall", data: tool({ kind: "committed" }) })).toBe(true);

    // 正文已在逐字出现,自带可视反馈。
    expect(isAwaitingModelSegment({ kind: "text", data: { body: "写好了" } })).toBe(false);
    expect(isAwaitingModelSegment({ kind: "code", data: { lang: "ts", body: "x" } })).toBe(false);
    // 工具自己有运行态/待用户处理文案,叠"思考中"是谎报。
    expect(isAwaitingModelSegment({
      kind: "toolCall",
      data: tool({ kind: "running", data: { progressPct: null, etaSec: null } }),
    })).toBe(false);
    expect(isAwaitingModelSegment({ kind: "toolCall", data: tool({ kind: "pending" }) })).toBe(false);
    expect(isAwaitingModelSegment({ kind: "toolCall", data: tool({ kind: "reviewing" }) })).toBe(false);
  });

  it("模型不吐 reasoning 时,空 agent 消息与工具结束后的续写窗都出「思考中」", async () => {
    const emptyAgent: ChatMessage = {
      id: "m-agent",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:01.000Z",
      parts: [],
      chips: null,
    };

    await render(
      <ChatMessageList messages={[userMessage(), emptyAgent]} streamActive />,
    );
    expect(host?.textContent ?? "").toContain("思考中");

    const afterTool: ChatMessage = {
      ...emptyAgent,
      parts: [{
        kind: "toolCall",
        data: {
          id: "t-1",
          name: "webSearch",
          render: { kind: "chatInline" },
          status: { kind: "done" },
          body: { kind: "generic", data: { argsJson: "{}" } },
          result: null,
        },
      }],
    };
    await act(async () => {
      root?.render(
        <ChatMessageList messages={[userMessage(), afterTool]} streamActive />,
      );
    });
    expect(host?.textContent ?? "").toContain("思考中");

    // 正文开始逐字出现后立刻掐断,不与正文并存。
    await act(async () => {
      root?.render(
        <ChatMessageList
          messages={[userMessage(), {
            ...afterTool,
            parts: [...afterTool.parts, { kind: "text", data: { body: "查到了三条" } }],
          }]}
          streamActive
        />,
      );
    });
    expect(host?.textContent ?? "").toContain("查到了三条");
    expect(host?.textContent ?? "").not.toContain("思考中");
  });

  it("流在跑但新一轮 agent 消息未建时,上一轮消息不冒「思考中」", async () => {
    const previousTurn: ChatMessage = {
      id: "m-agent-prev",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:01.000Z",
      parts: [{
        kind: "toolCall",
        data: {
          id: "t-prev",
          name: "webSearch",
          render: { kind: "chatInline" },
          status: { kind: "done" },
          body: { kind: "generic", data: { argsJson: "{}" } },
          result: null,
        },
      }],
      chips: null,
    };
    const newUserTurn: ChatMessage = { ...userMessage(), id: "m-user-2" };

    await render(
      <ChatMessageList messages={[previousTurn, newUserTurn]} streamActive />,
    );
    expect(host?.textContent ?? "").not.toContain("思考中");
  });

  it("首 token 前 loading 文案 2 秒后切换", async () => {
    vi.useFakeTimers();
    const messages = [userMessage()];
    await render(<ChatMessageList messages={messages} streamActive={false} showLoading />);

    expect(host?.textContent ?? "").toContain("正在连接模型");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(host?.textContent ?? "").toContain("正在连接模型");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(host?.textContent ?? "").toContain("正在准备上下文,首次对话会稍慢");
  });

  it("首 token 前 loading 隐藏时清理分档文案定时器", async () => {
    vi.useFakeTimers();
    const messages = [userMessage()];
    await render(<ChatMessageList messages={messages} streamActive={false} showLoading />);

    await act(async () => {
      root?.render(<ChatMessageList messages={messages} streamActive={false} showLoading={false} />);
    });

    expect(host?.textContent ?? "").not.toContain("正在连接模型");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("常见 markdown 链接和裸 URL 都安全渲染为可点击链接", async () => {
    const wecomUrl = "https://work.weixin.qq.com/wework_admin/frame#apps";
    const labeledUrl = "https://example.com/search?q=%E4%B8%AD%E6%96%87&x=1#结果";
    const parenthesizedUrl = "https://example.com/wiki/A_(B)?from=chat#section";
    const bareUrl = "https://example.com/direct/path?x=1&y=2#part";
    await render(
      <div>
        {renderSimpleMarkdown([
          "1. 在浏览器打开这个链接:",
          `   [${wecomUrl}](${wecomUrl})`,
          "查看[文字](https://example.com/guide?q=1#intro)",
          `查看[含 # / ? & 中文 和空格](${labeledUrl})`,
          `括号链接[文档](${parenthesizedUrl})`,
          `裸链 ${bareUrl} 继续`,
          "[危险](javascript:alert(1))",
          "[数据](data:text/html,boom)",
          "javascript:alert(1) data:text/html,boom",
        ].join("\n"))}
      </div>,
    );

    const anchors = Array.from(host!.querySelectorAll<HTMLAnchorElement>("a"));
    expect(anchors.map((anchor) => anchor.getAttribute("href"))).toEqual([
      wecomUrl,
      "https://example.com/guide?q=1#intro",
      labeledUrl,
      parenthesizedUrl,
      bareUrl,
    ]);
    expect(anchors[0]?.textContent).not.toContain(`[${wecomUrl}]`);
    expect(anchors[0]?.textContent).toContain(wecomUrl);
    expect(anchors[1]?.textContent).toContain("文字");
    expect(anchors[2]?.textContent).toContain("含 # / ? & 中文 和空格");
    for (const anchor of anchors) {
      expect(anchor.target).toBe("_blank");
      expect(anchor.rel.split(/\s+/)).toEqual(expect.arrayContaining(["noreferrer", "noopener"]));
      expect(anchor.protocol === "http:" || anchor.protocol === "https:").toBe(true);
    }
    expect(host?.textContent).toContain("[危险](javascript:alert(1))");
    expect(host?.textContent).toContain("[数据](data:text/html,boom)");
    expect(anchors.some((anchor) => /^(?:javascript|data):/u.test(anchor.href))).toBe(false);
  });

  it("站内文件服务图片渲染为带替代文本的 img", async () => {
    const src = "/api/v1/files/2c918f26-illustration/illustration.svg";
    await render(<div>{renderSimpleMarkdown(`![太空橘猫 · 梦幻星空](${src})`)}</div>);

    const image = host!.querySelector<HTMLImageElement>("img");
    expect(image?.getAttribute("src")).toBe(src);
    expect(image?.getAttribute("alt")).toBe("太空橘猫 · 梦幻星空");
    expect(image?.parentElement?.classList).toContain("u-thumb");
    expect(image?.parentElement?.classList).toContain("chat-markdown-image");
  });

  it("绝对 http 和 https 图片均渲染为 img", async () => {
    await render(
      <div>
        {renderSimpleMarkdown([
          "![HTTP 图](http://images.example.com/a.png)",
          "![HTTPS 图](https://images.example.com/b.webp)",
        ].join("\n"))}
      </div>,
    );

    const images = Array.from(host!.querySelectorAll<HTMLImageElement>("img"));
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "http://images.example.com/a.png",
      "https://images.example.com/b.webp",
    ]);
    expect(images.map((image) => image.getAttribute("alt"))).toEqual(["HTTP 图", "HTTPS 图"]);
  });

  it("危险或非白名单图片地址回退纯文本且不改变普通相对链接行为", async () => {
    const markdown = [
      "![脚本](javascript:alert(1))",
      "![数据](data:image/png;base64,AAAA)",
      "![上级](../private/image.png)",
      "![其它站内路径](/assets/image.png)",
      "[普通相对链接](/api/v1/files/document)",
    ].join("\n");
    await render(<div>{renderSimpleMarkdown(markdown)}</div>);

    expect(host!.querySelector("img")).toBeNull();
    expect(host!.querySelector("a")).toBeNull();
    for (const line of markdown.split("\n")) {
      expect(host?.textContent).toContain(line);
    }
  });

  it("未闭合图片语法在流式和完整渲染中都回退纯文本", async () => {
    const partial = "生成结果：![太空橘猫](";
    await render(<div>{renderSimpleMarkdown(partial)}</div>);

    expect(host!.querySelector("img")).toBeNull();
    expect(host?.textContent).toBe(partial);
    expect(splitStreamingInlineRuns(partial)).toEqual([
      { kind: "plain", text: partial, start: 0 },
    ]);
  });

  it("模型连续使用 1. 时按 markdown 规则递增编号并保留子级无序列表", async () => {
    await render(
      <div>
        {renderSimpleMarkdown([
          "1. 敏感词一",
          "   - 语境：第一处上下文",
          "   - 已附整句改写建议：建议一",
          "1. 敏感词二",
          "   - 语境：第二处上下文",
          "   - 已附整句改写建议：建议二",
        ].join("\n"))}
      </div>,
    );

    const orderedLists = host!.querySelectorAll("ol");
    expect(orderedLists).toHaveLength(1);
    const parentItems = Array.from(orderedLists[0]!.children) as HTMLLIElement[];
    expect(parentItems).toHaveLength(2);
    expect(parentItems.map((item, index) => item.value || orderedLists[0]!.start + index)).toEqual([1, 2]);
    expect(parentItems.map((item) => item.querySelectorAll(":scope > ul > li").length)).toEqual([2, 2]);
  });

  it("空行分隔的有序项保持同一列表且子级列表不被提升到父级", async () => {
    await render(
      <div>
        {renderSimpleMarkdown([
          "1. 第一处问题",
          "",
          "   - 语境：第一处上下文",
          "",
          "2. 第二处问题",
          "",
          "   - 语境：第二处上下文",
        ].join("\n"))}
      </div>,
    );

    const orderedLists = host!.querySelectorAll("ol");
    expect(orderedLists).toHaveLength(1);
    const parentItems = Array.from(orderedLists[0]!.children) as HTMLLIElement[];
    expect(parentItems.map((item, index) => item.value || orderedLists[0]!.start + index)).toEqual([1, 2]);
    expect(parentItems.every((item) => item.querySelector(":scope > ul") !== null)).toBe(true);
    expect(host!.querySelectorAll(":scope > div > ul")).toHaveLength(0);
  });

  it("有序列表显式跳号时尊重源序号", async () => {
    await render(<div>{renderSimpleMarkdown("1. 第一项\n3. 第三项")}</div>);

    const orderedList = host!.querySelector("ol")!;
    const items = Array.from(orderedList.children) as HTMLLIElement[];
    expect(items.map((item, index) => item.value || orderedList.start + index)).toEqual([1, 3]);
    expect(items[1]!.getAttribute("value")).toBe("3");
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

  it("readMaterial 工具卡使用文件资源的 displayName", async () => {
    const materialId = "76a681d9-54aa-4dee-9123-ccfc32ba35c";
    resources.upsert({
      resourceRef: { id: materialId, domain: { kind: "file" } },
      displayName: "赛事手册.pdf",
      summary: "",
      mime: "application/pdf",
      byteLen: 1024,
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: null,
    });
    const readMaterial: ToolCallSpec = {
      id: "tc-read-material",
      name: "readMaterial",
      render: { kind: "chatInline" },
      status: { kind: "done" },
      body: { kind: "generic", data: { argsJson: JSON.stringify({ materialId }) } },
      result: null,
    };

    await render(
      <ChatMessageList
        messages={[agentToolMessage(readMaterial)]}
        streamActive={false}
      />,
    );

    expect(host?.textContent).toContain("读取素材");
    expect(host?.textContent).toContain("赛事手册.pdf");
    expect(host?.textContent).not.toContain("76a681d9-54");
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

  it("真实恢复帧经 reducer 后在聊天史显示问卷中断说明并保持输入解锁", async () => {
    const interruptedAskUser: ToolCallSpec = {
      id: "tc-restore-interrupted",
      name: "askUser",
      render: { kind: "rightForm" },
      status: { kind: "aborted" },
      body: {
        kind: "askUser",
        data: {
          id: "ask-restore-interrupted",
          mode: { kind: "fullpage" },
          purpose: { kind: "initialBrief" },
          source: null,
          rationale: null,
          questions: [],
        },
      },
      result: {
        kind: "genericText",
        data: "上次问卷生成已中断，输入已恢复，可直接重新描述需求",
      },
    };

    const restoreActions: WorkspaceAction[] = [
      {
        kind: "restoreReset",
        data: { epoch: 2, snapshotSeq: 0 },
      },
      {
        kind: "docStateChanged",
        data: { state: { kind: "empty" }, activeOverlay: null, agentBusy: false },
      },
      {
        kind: "chatMessageAdded",
        data: {
          message: {
            id: "m-restore-interrupted",
            role: { kind: "agent" },
            ts: "2026-08-03T00:00:00.000Z",
            parts: [{ kind: "toolCall", data: interruptedAskUser }],
            chips: null,
          },
          appendSeq: 1,
        },
      },
      {
        kind: "toolCallUpdated",
        data: {
          messageId: "m-restore-interrupted",
          toolCallId: interruptedAskUser.id,
          spec: interruptedAskUser,
        },
      },
    ];
    const restored = restoreActions.reduce(workspaceReducer, initialWorkspaceState);

    await render(
      <ChatMessageList
        messages={restored.messages}
        streamActive={false}
      />,
    );

    expect(restored.activeOverlay).toBeNull();
    expect(restored.agentBusy).toBe(false);
    expect(host?.textContent ?? "").toContain(
      "上次问卷生成已中断，输入已恢复，可直接重新描述需求",
    );
    expect(host?.querySelector('[data-wf="AskUserRestoreInterrupted"]')).not.toBeNull();
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
              body: [
                "[tool-result]",
                "toolName: editDraft",
                "toolCallId: call-1",
                'args: {"blockId":"block-a"}',
                'result: {"ok":true}',
              ].join("\n"),
            },
          },
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
    expect(text).not.toContain("[tool-result]");
    expect(text).toContain("这是可见回复");
    expect(host?.querySelector('[data-wf="ChatMsg-system"]')).toBeNull();
  });

  it("内部文本分片经 reducer 合并隐藏后，独立兜底消息仍实际渲染", async () => {
    const internalDeltas = [
      "[tool-",
      "result]\n",
      "toolName: editDraft\n",
      "toolCallId: call-1\n",
      'args: {"blockId":"block-a"}\n',
      'result: {"ok":true}',
    ];
    const rawMessage: ChatMessage = {
      id: "m-split-internal",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [],
      chips: null,
    };
    const fallbackMessage: ChatMessage = {
      id: "m-visibility-fallback",
      role: { kind: "agent" },
      ts: "2026-01-01T00:00:01.000Z",
      parts: [
        {
          kind: "text",
          data: {
            body:
              "模型这一轮没有返回任何内容，可能是临时异常。请重试，或换个说法再发一次。",
          },
        },
      ],
      chips: null,
    };
    const actions: WorkspaceAction[] = [
      { kind: "chatMessageAdded", data: { message: rawMessage } },
      ...internalDeltas.map(
        (body, index): WorkspaceAction => ({
          kind: "chatMessageAppended",
          data: {
            messageId: rawMessage.id,
            seq: index + 1,
            part: { kind: "text", data: { body } },
          },
        }),
      ),
      { kind: "chatMessageAdded", data: { message: fallbackMessage } },
    ];
    const state = actions.reduce(workspaceReducer, initialWorkspaceState);
    const mergedRawPart = state.messages[0]?.parts[0];

    expect(state.messages[0]?.parts).toHaveLength(1);
    expect(
      mergedRawPart?.kind === "text" ? mergedRawPart.data.body : null,
    ).toBe(internalDeltas.join(""));
    expect(
      mergedRawPart?.kind === "text"
        ? sanitizeVisibleText(mergedRawPart.data.body)
        : "unexpected",
    ).toBeNull();

    await render(
      <ChatMessageList
        messages={state.messages}
        streamActive={false}
      />,
    );

    const text = host?.textContent ?? "";
    expect(text).toContain("模型这一轮没有返回任何内容");
    expect(text).not.toContain("[tool-result]");
    expect(text).not.toContain("block-a");
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

  it("用户气泡保留转义后的字面 chip marker，只渲染真实 marker", async () => {
    const protocolPrefix = "\u001eqa-chip-rich-text-v1\u001f";
    const messages: ChatMessage[] = [{
      id: "m-user-literal-chip-marker",
      role: { kind: "user" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [{
        kind: "text",
        data: {
          body: serializeChipRichText([
            { kind: "text", text: `${protocolPrefix}字面 {{chip:0}}，真实 ` },
            { kind: "chip", index: 0, marker: "{{chip:0}}" },
          ]),
        },
      }],
      chips: [{
        kind: { kind: "attach" },
        resourceRef: { id: "file-1", domain: { kind: "file" } },
        prefix: null,
        label: "资料.pdf",
        suffix: null,
        text: null,
      }],
    }];

    await render(<ChatMessageList messages={messages} streamActive={false} />);

    expect(host?.textContent).toContain(`${protocolPrefix}字面 {{chip:0}}，真实`);
    expect(host?.querySelectorAll(".chat-chip")).toHaveLength(1);
    expect(host?.textContent).toContain("资料.pdf");
  });

  it("用户气泡里的批注 text chip 只回显短标签，不退化成长文本卡或泄露完整指令", async () => {
    const messages: ChatMessage[] = [{
      id: "m-user-annotation-chip",
      role: { kind: "user" },
      ts: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text", data: { body: "请处理{{chip:0}}" } }],
      chips: [{
        kind: { kind: "text" },
        resourceRef: null,
        prefix: null,
        label: "批注·金额口径漂移",
        suffix: null,
        text: "按批注修改:「原句」——改为120亿元（原因:素材口径不一致）",
      }],
    }];

    await render(<ChatMessageList messages={messages} streamActive={false} />);

    const chip = host?.querySelector<HTMLElement>('.chat-chip[data-kind="annotation"]');
    expect(chip?.textContent).toContain("批注·金额口径漂移");
    expect(host?.querySelector(".chat-chip-longtext")).toBeNull();
    expect(host?.textContent).not.toContain("素材口径不一致");
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

  it("用户动作卡渲染标题与明细且不套用户气泡", async () => {
    const messages: ChatMessage[] = [
      {
        id: "m-action-card",
        role: { kind: "user" },
        ts: "2026-01-01T00:00:00.000Z",
        parts: [
          {
            kind: "actionCard",
            data: {
              title: "生成公众号稿",
              lines: [
                { label: "模板", value: "深度长文" },
                { label: "补充", value: "语气更克制" },
              ],
              status: "done",
            },
          },
        ],
        chips: null,
      },
    ];

    await render(<ChatMessageList messages={messages} streamActive={false} />);

    const card = host?.querySelector<HTMLElement>('[data-wf="ActionCard"]');
    expect(card).not.toBeNull();
    expect(card?.closest(".wf-msg.user")).toBeNull();
    expect(host?.querySelector('[data-wf="InkBubbleMock"]')).toBeNull();
    expect(host?.textContent ?? "").toContain("生成公众号稿");
    expect(host?.textContent ?? "").toContain("模板深度长文");
    expect(host?.textContent ?? "").toContain("补充语气更克制");
  });

  it("审查中止卡显示中止终态且不再保留完成勾", async () => {
    const messages: ChatMessage[] = [{
      id: "m-review-aborted",
      role: { kind: "user" },
      ts: "2026-08-05T10:00:00.000Z",
      parts: [{
        kind: "actionCard",
        data: {
          title: "一致性审查",
          lines: [{ label: "模板", value: "全面自洽核查" }],
          status: "aborted",
        },
      }],
      chips: null,
    }];

    await render(<ChatMessageList messages={messages} streamActive={false} />);

    const card = host?.querySelector<HTMLElement>('[data-wf="ActionCard"]');
    expect(card?.dataset.status).toBe("aborted");
    expect(card?.textContent).toContain("审查已中止");
    expect(card?.querySelector(".askuser-card-check svg")).toBeNull();
  });

  it("用户回流的问卷答案卡复用已提交答案结构且不套用户气泡", async () => {
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
    expect(card?.classList.contains("askuser-card")).toBe(true);
    expect(card?.classList.contains("askuser-card--answers")).toBe(true);
    expect(card?.classList.contains("bigplan-panel")).toBe(false);
    expect(card?.querySelector(".askuser-card-header")?.textContent).toContain("已提交写作方向问卷");
    expect(card?.querySelector(".askuser-card-row")).not.toBeNull();
    expect(card?.querySelector(".askuser-card-a")?.textContent).toContain("更克制");
    expect(card?.querySelector(".bp-head, .bp-body, .bp-q, .bp-opt")).toBeNull();
    expect(card?.closest(".wf-msg.user")).toBeNull();
    expect(host?.querySelector('[data-wf="InkBubbleMock"]')).toBeNull();
  });

  it("overlay askUser done 在对应答卷卡到达后同组件 rerender 收敛为单卡", async () => {
    const toolCallId = "ask-overlay-rerender";
    const toolMessage = agentToolMessage(askUserToolCall(toolCallId));

    await render(
      <ChatMessageList messages={[toolMessage]} streamActive={false} />,
    );
    expect(host?.querySelector(".u-bar")).not.toBeNull();
    expect(host?.querySelector('[data-wf="AskUserAnswerCard"]')).toBeNull();

    await act(async () => {
      root?.render(
        <ChatMessageList
          messages={[toolMessage, askUserAnswerCardMessage(toolCallId)]}
          streamActive={false}
        />,
      );
    });

    expect(host?.querySelector(".u-bar")).toBeNull();
    expect(host?.querySelectorAll('[data-wf="AskUserAnswerCard"]').length).toBe(1);
  });

  it("只有异 toolCallId 的答卷卡时仍保留目标 overlay askUser 工具行", async () => {
    await render(
      <ChatMessageList
        messages={[
          agentToolMessage(askUserToolCall("ask-target")),
          askUserAnswerCardMessage("ask-other"),
        ]}
        streamActive={false}
      />,
    );

    expect(host?.querySelector(".u-bar")).not.toBeNull();
    expect(host?.querySelectorAll('[data-wf="AskUserAnswerCard"]').length).toBe(1);
  });

  it.each([
    ["空答案", {}],
    ["全空白答案", { "q-tone": { chosen: [], freeText: "   ", numericValue: null } }],
  ] satisfies Array<[string, AskUserAnswersData]>) (
    "%s且无答卷卡时保留 overlay askUser 工具行",
    async (_label, answers) => {
      await render(
        <ChatMessageList
          messages={[agentToolMessage(askUserToolCall("ask-empty-answer", { kind: "done" }, "overlay", answers))]}
          streamActive={false}
        />,
      );

      expect(host?.querySelector(".u-bar")).not.toBeNull();
      expect(host?.querySelector('[data-wf="AskUserAnswerCard"]')).toBeNull();
    },
  );

  it.each([
    ["pending", { kind: "pending" }],
    ["running", { kind: "running", data: { progressPct: null, etaSec: null } }],
  ] satisfies Array<[string, ToolCallSpec["status"]]>) (
    "overlay askUser %s 即使其余抑制门槛成立也保留工具行",
    async (_label, status) => {
      const toolCallId = `ask-${_label}`;
      await render(
        <ChatMessageList
          messages={[
            agentToolMessage(askUserToolCall(toolCallId, status)),
            askUserAnswerCardMessage(toolCallId),
          ]}
          streamActive={false}
        />,
      );

      expect(host?.querySelector(".u-bar")).not.toBeNull();
      expect(host?.querySelectorAll('[data-wf="AskUserAnswerCard"]').length).toBe(1);
    },
  );

  it("fullpage done 汇总卡与普通 done 工具不受答卷卡 Set 影响", async () => {
    const fullpageId = "ask-fullpage";
    const ordinaryId = "ordinary-tool";
    const ordinaryTool: ToolCallSpec = {
      id: ordinaryId,
      name: "webSearch",
      render: { kind: "chatInline" },
      status: { kind: "done" },
      body: { kind: "generic", data: { argsJson: "{}" } },
      result: null,
    };

    await render(
      <ChatMessageList
        messages={[
          agentToolMessage(askUserToolCall(fullpageId, { kind: "done" }, "fullpage")),
          agentToolMessage(ordinaryTool),
          askUserAnswerCardMessage(fullpageId),
          askUserAnswerCardMessage(ordinaryId),
        ]}
        streamActive={false}
      />,
    );

    expect(host?.querySelector('[data-wf="ToolCall"].askuser-card')?.textContent).toContain("已提交答案");
    expect(host?.querySelector(".u-bar")).not.toBeNull();
  });

  it("被抑制工具是唯一 part 时不残留空 ChatMsg-agent 外壳", async () => {
    const toolCallId = "ask-no-empty-shell";
    await render(
      <ChatMessageList
        messages={[
          agentToolMessage(askUserToolCall(toolCallId)),
          askUserAnswerCardMessage(toolCallId),
        ]}
        streamActive={false}
      />,
    );

    expect(host?.querySelector('[data-wf="ChatMsg-agent"]')).toBeNull();
    expect(host?.querySelector('[data-wf="ChatMsg-user-card"]')).not.toBeNull();
    expect(host?.querySelector('[data-wf="AskUserAnswerCard"]')).not.toBeNull();
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

  it("部分成功 patchSummary 如实显示已写入与失效计数", async () => {
    const messages: ChatMessage[] = [{
      id: "m-partial-review",
      role: { kind: "agent" },
      ts: "2026-07-17T00:00:00.000Z",
      parts: [{
        kind: "patchSummary",
        data: {
          count: 3,
          hunkIds: ["h-1", "h-2", "h-3"],
          reviewOutcome: "committed",
          appliedCount: 2,
          conflictCount: 1,
        },
      }],
      chips: null,
    }];

    await render(<ChatMessageList messages={messages} streamActive={false} />);

    expect(host?.textContent ?? "").toContain("2 处已写入，1 处因文档变化失效");
    expect(host?.textContent ?? "").not.toContain("本轮修改未写入");
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
    expect(host?.textContent ?? "").toContain("正在连接模型");
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
  const svgTool = (id: string): ToolCallSpec => ({
    id,
    name: "generateSvg",
    render: { kind: "chatInline" },
    status: { kind: "done" },
    body: {
      kind: "generateSvg",
      data: {
        prompt: "配图",
        progress: {
          stage: "done",
          src: "/api/v1/files/x/illustration.svg",
        },
      },
    } as unknown as ToolCallSpec["body"],
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

  const resumedImageTurn = (): ChatMessage[] => [
    userMessage("m-user-image"),
    {
      ...turn([
        { kind: "toolCall", data: svgTool("t-svg") },
        { kind: "toolCall", data: genTool("t-skill", "skill_read") },
        { kind: "toolCall", data: genTool("t-write", "writeDraft") },
        { kind: "toolCall", data: askUserToolCall("ask-image") },
      ]),
      id: "m-before-resume",
    },
    askUserAnswerCardMessage("ask-image", "m-answer-image"),
    {
      ...turn([
        { kind: "toolCall", data: genTool("t-read", "readDraft") },
        { kind: "toolCall", data: genTool("t-diff", "readDiff") },
      ]),
      id: "m-after-resume",
    },
  ];

  it("整轮仍运行时不显示图片汇总——即使工具全 done、窄 stream 信号暂时为 false", async () => {
    const running = resumedImageTurn();

    // askUser 答卷前后的两个 agent message 属于同一逻辑轮；现场窗口里停止按钮仍在
    // (turnActive=true)，但 state.streamActive 可因投影/子流衔接暂时为 false。
    await render(
      <ChatMessageList
        messages={running}
        streamActive={false}
        turnActive
      />,
    );
    expect(host?.querySelector(".u-imgsum")).toBeNull();
  });

  it("整轮结束后显示图片汇总", async () => {
    await render(
      <ChatMessageList
        messages={resumedImageTurn()}
        streamActive={false}
        turnActive={false}
      />,
    );
    expect(host?.querySelector(".u-imgsum")).not.toBeNull();
    expect(host?.textContent ?? "").toContain("已生成 1 张图片");
  });

  it("汇总行门在「推理结束」而非「回合结清」:待审批 live patch 期间也要出(luna r1 第7项)", async () => {
    const pendingApproval: ChatMessage[] = [
      turn([
        { kind: "toolCall", data: svgTool("t-svg") },
        { kind: "patchSummary", data: { count: 1, hunkIds: ["h-img"] } },
      ]),
    ];
    // liveHunkKey 命中 → anyLivePatch=true → turnSettled=false;但推理已结束,汇总行必须在场
    await render(<ChatMessageList messages={pendingApproval} streamActive={false} liveHunkKey="h-img" />);
    expect(host?.querySelector(".u-imgsum")).not.toBeNull();
    expect(host?.textContent ?? "").toContain("已生成 1 张图片");
  });

  it("parseExternalClient 从消息 id 解析调用方,非外部消息返回 null", () => {
    expect(parseExternalClient("external-claudecode-3f2a1b2c-0000")).toBe("claude-code");
    expect(parseExternalClient("external-codex-3f2a1b2c-0000")).toBe("codex");
    // 未知 token / 老格式 external-<uuid> 归到通用 agent
    expect(parseExternalClient("external-3f2a1b2c-0000")).toBe("agent");
    expect(parseExternalClient("external-something-x")).toBe("agent");
    // 非外部消息
    expect(parseExternalClient("agent-turn-1")).toBeNull();
    expect(parseExternalClient("m-123")).toBeNull();
  });

  it("external-* 提案单独挂一条外部信息条，审阅 chip 与普通 agent 保持一致(解耦)", async () => {
    const messages: ChatMessage[] = [
      {
        ...turn([{ kind: "patchSummary", data: { count: 3, hunkIds: ["external-h1", "external-h2", "external-h3"] } }]),
        id: "external-proposal-1",
      },
      turn([{ kind: "patchSummary", data: { count: 2, hunkIds: ["agent-h1", "agent-h2"] } }]),
    ];

    await render(<ChatMessageList messages={messages} streamActive={false} />);

    // 独立的外部信息条只挂在 external-* 消息上,且不掺 count(count 归审阅 chip)。
    const notes = host?.querySelectorAll('[data-wf="ExternalOpNote"]') ?? [];
    expect(notes.length).toBe(1);
    expect(notes[0]?.textContent ?? "").toContain("提交了修改");
    expect(notes[0]?.querySelector("svg")).not.toBeNull();
    // 审阅 chip 与来源解耦:外部、普通两条都是通用的「已修改 N 处」。
    expect(host?.textContent ?? "").toContain("已修改 3 处");
    expect(host?.textContent ?? "").toContain("已修改 2 处");
    expect(host?.textContent ?? "").not.toContain("外部工具提交了 3 处修改");
  });

  it("external-* 用户消息(代发)在气泡上方挂一条「代你发送了一条消息」信息条", async () => {
    const messages: ChatMessage[] = [
      userMessage("external-claudecode-3f2a1b2c-0000"),
      userMessage("m-user-normal"),
    ];

    await render(<ChatMessageList messages={messages} streamActive={false} />);

    // 只在 external-* 用户消息上挂一条,文案是"代发"而非"提交修改"。
    const notes = host?.querySelectorAll('[data-wf="ExternalOpNote"]') ?? [];
    expect(notes.length).toBe(1);
    expect(notes[0]?.textContent ?? "").toContain("Claude Code 代你发送了一条消息");
    expect(notes[0]?.textContent ?? "").not.toContain("提交了修改");
    expect(notes[0]?.querySelector("svg")).not.toBeNull();
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

  it("流式最后一行也会 autolink 裸 URL 并剥离句末标点", () => {
    expect(splitStreamingInlineRuns("打开 https://example.com/path?q=1&x=2#part，继续")).toEqual([
      { kind: "plain", text: "打开 ", start: 0 },
      {
        kind: "link",
        text: "https://example.com/path?q=1&x=2#part",
        href: "https://example.com/path?q=1&x=2#part",
        start: 3,
      },
      { kind: "plain", text: "，继续", start: 40 },
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

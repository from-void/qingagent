// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../data/protocol";
import { ChatMessageList } from "./ChatMessageList";

const workspaceCss = readFileSync(resolve(process.cwd(), "src/pages/workspace/workspace.css"), "utf8");
const inkSkinCss = readFileSync(resolve(process.cwd(), "src/pages/workspace/workspace-ink-skin.css"), "utf8");
const tokenCss = readFileSync(resolve(process.cwd(), "../../packages/ui-kit/src/tokens.css"), "utf8");

let root: Root | null = null;
let style: HTMLStyleElement | null = null;
let workspaceHost: HTMLDivElement | null = null;
let chatHost: HTMLDivElement | null = null;

describe("AskUserAnswerCard", () => {
  beforeEach(() => {
    style = document.createElement("style");
    style.textContent = `${tokenCss}\n${workspaceCss}\n${inkSkinCss}`;
    document.head.appendChild(style);

    workspaceHost = document.createElement("div");
    workspaceHost.id = "view-workspace";
    const left = document.createElement("div");
    left.className = "ws-left";
    chatHost = document.createElement("div");
    chatHost.className = "ws-chat";
    left.appendChild(chatHost);
    workspaceHost.appendChild(left);
    document.body.appendChild(workspaceHost);
    root = createRoot(chatHost);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    workspaceHost?.remove();
    workspaceHost = null;
    chatHost = null;
    style?.remove();
    style = null;
    vi.restoreAllMocks();
  });

  it("提交后的答卷卡不回退成 bigplan 奶白纸大卡", async () => {
    await renderAskUserAnswerCard();

    const card = chatHost?.querySelector<HTMLElement>('[data-wf="AskUserAnswerCard"]');
    expect(card).not.toBeNull();
    expect(card?.classList.contains("bigplan-panel")).toBe(false);
    expect(card?.querySelector(".bp-head, .bp-body, .bp-q, .bp-opt")).toBeNull();

    const cardStyle = getComputedStyle(card!);
    const heading = card!.querySelector<HTMLElement>(".askuser-answer-head h2");
    const question = card!.querySelector<HTMLElement>(".askuser-answer-title");
    expect(heading).not.toBeNull();
    expect(question).not.toBeNull();

    expect(cardStyle.maxWidth).toBe("430px");
    expect(cardStyle.backgroundColor).not.toBe("rgb(239, 231, 214)");
    expect(cardStyle.backgroundColor).not.toBe("rgba(239, 231, 214, 1)");

    const headingFontSize = Number.parseFloat(getComputedStyle(heading!).fontSize);
    expect(headingFontSize).toBeLessThanOrEqual(16);
    expect(headingFontSize).toBeGreaterThanOrEqual(14);

    const foreground = parseRgb(getComputedStyle(question!).color) ?? [236, 227, 208];
    const background = parseRgb(cardStyle.backgroundColor) ?? blend([255, 255, 255], [22, 33, 44], 0.04);
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});

async function renderAskUserAnswerCard(): Promise<void> {
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

  await act(async () => {
    root?.render(<ChatMessageList messages={messages} streamActive={false} />);
  });
}

function parseRgb(input: string): [number, number, number] | null {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(input.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function blend(
  foreground: [number, number, number],
  background: [number, number, number],
  alpha: number,
): [number, number, number] {
  return [
    Math.round(foreground[0] * alpha + background[0] * (1 - alpha)),
    Math.round(foreground[1] * alpha + background[1] * (1 - alpha)),
    Math.round(foreground[2] * alpha + background[2] * (1 - alpha)),
  ];
}

function relativeLuminance(rgb: [number, number, number]): number {
  const normalize = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const r = normalize(rgb[0]);
  const g = normalize(rgb[1]);
  const b = normalize(rgb[2]);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(left: [number, number, number], right: [number, number, number]): number {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

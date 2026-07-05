import { describe, expect, it, vi } from "vitest";
import type { AskMoreQuestion } from "../tools/askMore.js";

let cannedText = "";

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => vi.fn(() => ({ modelId: "deepseek-v4-flash" }))),
}));

vi.mock("ai", () => ({
  streamText: vi.fn(() => ({
    textStream: (async function* () {
      yield cannedText;
    })(),
  })),
}));

async function collectAskMore(canned: string): Promise<AskMoreQuestion[][]> {
  cannedText = canned;
  const { streamMoreQuestions } = await import("../tools/askMore.js");
  const yields: AskMoreQuestion[][] = [];

  for await (const questions of streamMoreQuestions({
    conversationSummary: "",
    currentQuestions: [],
    currentAnswers: {},
  })) {
    yields.push(questions);
  }

  return yields;
}

async function parsePartialAskMore(canned: string): Promise<AskMoreQuestion[]> {
  const { tryParsePartialAskMoreQuestions } = await import("../tools/askMore.js");
  return tryParsePartialAskMoreQuestions(canned);
}

describe("tryParsePartialAskMoreQuestions 脏流式输入", () => {
  it("完整对象 label 不是字符串时不产出问题", async () => {
    const questions = await parsePartialAskMore(
      '[{"id":"q-extra-bad-label","label":123,"kind":{"kind":"text"},"options":[]}]',
    );

    expect(questions).toEqual([]);
  });

  it("完整对象 kind 不是合法嵌套结构时不产出问题", async () => {
    const stringKind = await parsePartialAskMore(
      '[{"id":"q-extra-string-kind","label":"题目","kind":"text","options":[]}]',
    );
    const nestedKind = await parsePartialAskMore(
      '[{"id":"q-extra-nested-kind","label":"题目","kind":{"kind":{"kind":"text"}},"options":[]}]',
    );

    expect(stringKind).toEqual([]);
    expect(nestedKind).toEqual([]);
  });

  it("半截对象 label 里的转义引号会完整解码", async () => {
    const questions = await parsePartialAskMore(
      '[{"id":"q-extra-quote","label":"他说\\"你好\\"","kind":{"kind":"text"},"options":[',
    );

    expect(questions[0]).toMatchObject({
      id: "q-extra-quote",
      label: '他说"你好"',
      kind: { kind: "text" },
      options: [],
    });
  });
});

describe("streamMoreQuestions final extraction", () => {
  it("parses final askMore questions with trailing prose and stray bracket", async () => {
    const questions: AskMoreQuestion[] = [
      {
        id: "q-extra-tone",
        label: "语气偏好",
        kind: { kind: "single" },
        options: [{ value: "warm", label: "温和]" }],
        placeholder: "",
      },
    ];
    const canned = `${JSON.stringify(questions)}\n\n补充说明。]`;

    const yields = await collectAskMore(canned);

    expect(yields.at(-1)).toEqual(questions);
    expect(yields.at(-1)?.[0]?.options[0]?.label).toBe("温和]");
  });

  it("parses final askMore questions inside ```json fence", async () => {
    const questions: AskMoreQuestion[] = [
      {
        id: "q-extra-tone",
        label: "语气偏好",
        kind: { kind: "single" },
        options: [{ value: "warm", label: "温和]" }],
        placeholder: "",
      },
    ];
    const canned = `\`\`\`json\n${JSON.stringify(questions)}\n\`\`\`\n说明]`;

    const yields = await collectAskMore(canned);

    expect(yields.at(-1)).toEqual(questions);
  });

  it("yields an empty final result instead of throwing for prose-only declines", async () => {
    const yields = await collectAskMore("我无法生成更多问题了，现有问题已覆盖。");

    expect(yields).toEqual([[]]);
  });

  it("yields an empty final result instead of throwing for malformed balanced arrays", async () => {
    const yields = await collectAskMore('[{"id":"q-extra-focus","label":]');

    expect(yields).toEqual([[]]);
  });
});

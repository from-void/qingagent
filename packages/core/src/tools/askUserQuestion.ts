import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  adaptAskUserQuestionInput,
  askUserQuestionInputSchema,
  buildQuestionnaireRejectedResult,
  questionnaireRejectedResultSchema,
} from "./askUserQuestionAdapter.js";

const answerSchema = z.object({
  chosen: z.array(z.string()),
  freeText: z.string().nullable(),
  numericValue: z.number().nullable().optional(),
  questionLabel: z.string().optional(),
  chosenLabels: z.array(z.string()).optional(),
});

const resumeSchema = z.record(z.string(), answerSchema.optional());
const questionSchema = z.object({
  id: z.string(),
  header: z.string().nullable().optional().refine(
    (value) => value == null || Array.from(value).length <= 12,
    { message: "header 最多 12 个 Unicode code point" },
  ),
  label: z.string(),
  kind: z.enum(["single", "multi"]),
  options: z.array(z.object({
    value: z.string(),
    label: z.string(),
    description: z.string().nullable(),
    preview: z.string().nullable(),
  })).max(4),
  placeholder: z.null(),
});

export const askUserQuestionTool = createTool({
  id: "askUserQuestion",
  description:
    "向用户提出 1 至 4 道通用单选或多选题。questions 会逐字传给问卷通道；每题至少两个选项。工具会挂起当前轮并等待用户回答。",
  inputSchema: askUserQuestionInputSchema,
  outputSchema: z.union([resumeSchema, questionnaireRejectedResultSchema]),
  suspendSchema: z.object({
    id: z.string(),
    purpose: z.enum(["initialBrief", "quickClarification", "directionChange"]).optional(),
    source: z.string().nullable(),
    rationale: z.string().nullable(),
    questions: z.array(questionSchema).max(4),
  }),
  resumeSchema,
  execute: async (input, context) => {
    const { resumeData, suspend } = context?.agent ?? {};
    if (resumeData) return resumeData;

    const adapted = adaptAskUserQuestionInput(input);
    if (adapted.questions.length === 0) {
      return buildQuestionnaireRejectedResult();
    }
    if (!suspend) {
      return buildQuestionnaireRejectedResult("当前运行环境不支持挂起问卷");
    }
    return await suspend({
      id: adapted.id,
      source: null,
      rationale: adapted.rationale,
      questions: adapted.questions.map((question) => ({
        ...question,
        kind: question.kind.kind as "single" | "multi",
      })),
    });
  },
});

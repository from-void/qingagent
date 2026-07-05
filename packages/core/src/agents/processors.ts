import type {
  InputProcessorOrWorkflow,
  OutputProcessor,
  OutputProcessorOrWorkflow,
  UnicodeNormalizerOptions,
} from "@mastra/core/processors";
import {
  BatchPartsProcessor,
  ModerationProcessor,
  PIIDetector,
  ProcessorStepSchema,
  PromptInjectionDetector,
  UnicodeNormalizer,
} from "@mastra/core/processors";
import type { OpenAICompatibleConfig } from "@mastra/core/llm";
import type { RequestContext } from "@mastra/core/request-context";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import {
  DEEPSEEK_MODEL_IDS,
  resolveBaseUrl,
  resolveDeepseekAuth,
} from "../llm/modelConfig.js";
import { toolSearchProcessorFromRequestContext } from "./toolSearch.js";

export const QINGAGENT_BATCH_PARTS_SIZE = 8;
export const QINGAGENT_BATCH_PARTS_MAX_WAIT_MS = 10;

export const QINGAGENT_PROCESSOR_ENV = {
  promptInjection: "QINGAGENT_PROCESSOR_PROMPT_INJECTION",
  moderation: "QINGAGENT_PROCESSOR_MODERATION",
  pii: "QINGAGENT_PROCESSOR_PII",
} as const;

export interface QingagentProcessorFlags {
  promptInjection: boolean;
  moderation: boolean;
  pii: boolean;
}

const UNICODE_NORMALIZER_DIRTY_RE =
  /[\x00-\x1F\x7F-\x9F\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u2070-\u209F\u2100-\u214F\u2150-\u218F\u2460-\u24FF\u3000-\u303F\u3200-\u33FF\uF900-\uFAFF\uFB00-\uFDFF\uFE00-\uFEFF\uFF00-\uFFEF]|^\s|\s$| {2,}/u;

class NoopPreservingUnicodeNormalizer extends UnicodeNormalizer {
  private readonly qingagentOptions: Required<UnicodeNormalizerOptions>;

  constructor(options: UnicodeNormalizerOptions = {}) {
    super(options);
    this.qingagentOptions = {
      stripControlChars: options.stripControlChars ?? false,
      preserveEmojis: options.preserveEmojis ?? true,
      collapseWhitespace: options.collapseWhitespace ?? true,
      trim: options.trim ?? true,
    };
  }

  override processInput(args: Parameters<UnicodeNormalizer["processInput"]>[0]): ReturnType<UnicodeNormalizer["processInput"]> {
    try {
      let changed = false;
      const messages = args.messages.map((message) => {
        let messageChanged = false;
        const content = message.content as typeof message.content & {
          parts?: Array<Record<string, unknown>>;
          content?: unknown;
        };
        const parts = Array.isArray(content.parts)
          ? content.parts.map((part) => {
              if (part.type === "text" && typeof part.text === "string") {
                const normalizedText = this.normalizeQingagentText(part.text);
                if (normalizedText !== part.text) {
                  messageChanged = true;
                  return { ...part, text: normalizedText };
                }
              }
              return part;
            })
          : content.parts;
        const contentText = typeof content.content === "string"
          ? this.normalizeQingagentText(content.content)
          : content.content;
        if (contentText !== content.content) messageChanged = true;
        if (!messageChanged) return message;
        changed = true;
        return {
          ...message,
          content: {
            ...content,
            parts,
            content: contentText,
          },
        };
      });
      return changed ? messages : args.messages;
    } catch {
      return args.messages;
    }
  }

  private normalizeQingagentText(text: string): string {
    if (!UNICODE_NORMALIZER_DIRTY_RE.test(text)) return text;
    let normalized = text.normalize("NFKC");
    if (this.qingagentOptions.stripControlChars) {
      normalized = this.qingagentOptions.preserveEmojis
        ? normalized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
        : normalized.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, "");
    }
    if (this.qingagentOptions.collapseWhitespace) {
      normalized = normalized.replace(/\r\n/g, "\n");
      normalized = normalized.replace(/\r/g, "\n");
      normalized = normalized.replace(/\n+/g, "\n");
      normalized = normalized.replace(/[ \t]+/g, " ");
    }
    return this.qingagentOptions.trim ? normalized.trim() : normalized;
  }
}

const DEFAULT_UNICODE_NORMALIZER = new NoopPreservingUnicodeNormalizer({
  stripControlChars: true,
  preserveEmojis: true,
  collapseWhitespace: true,
  trim: true,
});

const DEFAULT_BATCH_PARTS_PROCESSOR = new BatchPartsProcessor({
  batchSize: QINGAGENT_BATCH_PARTS_SIZE,
  maxWaitTime: QINGAGENT_BATCH_PARTS_MAX_WAIT_MS,
  emitOnNonText: true,
}) satisfies OutputProcessor;

/**
 * D8-A 策略编排表:
 * - Unicode/control chars: normalize,不 block;始终启用。
 * - prompt-injection: block;LLM 型,仅 QINGAGENT_PROCESSOR_PROMPT_INJECTION=1 时启用。
 * - PII: redact;LLM 型,仅 QINGAGENT_PROCESSOR_PII=1 时启用。
 * - moderation: 仅观测(warn);LLM 型,仅 QINGAGENT_PROCESSOR_MODERATION=1 时启用。
 * - secret/api-key 泄露仍归自研 redaction.ts:18 起的字段/文本 redaction;processor 不重复扫。
 *
 * Processors 不替代这些既有防线:工具 IO 序列化截断+redaction(redaction.ts:176 起)、
 * stream/工具卡展示侧 redaction、workspace 路径/错误清洗、SVG/artifact sanitizer。
 * Mastra processors 只处理模型输入/输出链路,碰不到工具内外部 IO 与 artifact 落盘面。
 */

function isEnabledFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function hasInputLlmGuardrail(flags: QingagentProcessorFlags): boolean {
  return flags.promptInjection || flags.moderation || flags.pii;
}

function hasOutputLlmGuardrail(flags: QingagentProcessorFlags): boolean {
  return flags.moderation || flags.pii;
}

export function resolveQingagentProcessorFlags(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): QingagentProcessorFlags {
  return {
    promptInjection: isEnabledFlag(env[QINGAGENT_PROCESSOR_ENV.promptInjection]),
    moderation: isEnabledFlag(env[QINGAGENT_PROCESSOR_ENV.moderation]),
    pii: isEnabledFlag(env[QINGAGENT_PROCESSOR_ENV.pii]),
  };
}

export function resolveQingagentGuardrailModel(
  requestContext?: RequestContext,
): OpenAICompatibleConfig {
  const { apiKey } = resolveDeepseekAuth(requestContext);
  return {
    id: `deepseek/${DEEPSEEK_MODEL_IDS.flash}`,
    url: resolveBaseUrl(requestContext),
    apiKey,
  };
}

const STRUCTURED_OUTPUT_OPTIONS = {
  // deepseek-v4-flash 不支持 response_format json_schema;保持 json prompt + 自解析路径。
  jsonPromptInjection: true,
} as const;

function createPromptInjectionDetector(model: OpenAICompatibleConfig): PromptInjectionDetector {
  return new PromptInjectionDetector({
    model,
    strategy: "block",
    threshold: 0.8,
    detectionTypes: ["injection", "jailbreak", "system-override"],
    lastMessageOnly: true,
    includeScores: true,
    structuredOutputOptions: STRUCTURED_OUTPUT_OPTIONS,
  });
}

function createModerationProcessor(model: OpenAICompatibleConfig): ModerationProcessor {
  return new ModerationProcessor({
    model,
    strategy: "warn",
    threshold: 0.8,
    lastMessageOnly: true,
    includeScores: true,
    structuredOutputOptions: STRUCTURED_OUTPUT_OPTIONS,
  });
}

function createPiiDetector(model: OpenAICompatibleConfig): PIIDetector {
  return new PIIDetector({
    model,
    strategy: "redact",
    redactionMethod: "placeholder",
    threshold: 0.6,
    lastMessageOnly: true,
    includeDetections: true,
    preserveFormat: true,
    structuredOutputOptions: STRUCTURED_OUTPUT_OPTIONS,
  });
}

function selectParallelBranch(inputData: unknown, branchId: string): unknown {
  if (!inputData || typeof inputData !== "object") return inputData;
  const record = inputData as Record<string, unknown>;
  return record[branchId] ?? Object.values(record)[0] ?? inputData;
}

function asInputProcessorWorkflow(workflow: unknown): InputProcessorOrWorkflow {
  // Mastra 1.49.0 官方文档要求 processor workflow 使用 ProcessorStepSchema,
  // 但 ProcessorWorkflow 的导出类型把 input/output 收窄成 ProcessorStepOutputSchema。
  // 这里仅绕过该泛型不匹配,运行时仍是官方 workflow-as-processor。
  return workflow as InputProcessorOrWorkflow;
}

function asOutputProcessorWorkflow(workflow: unknown): OutputProcessorOrWorkflow {
  return workflow as OutputProcessorOrWorkflow;
}

function buildInputGuardrailWorkflow(
  flags: QingagentProcessorFlags,
  model: OpenAICompatibleConfig,
): InputProcessorOrWorkflow | null {
  const steps = [
    ...(flags.pii ? [createStep(createPiiDetector(model))] : []),
    ...(flags.promptInjection ? [createStep(createPromptInjectionDetector(model))] : []),
    ...(flags.moderation ? [createStep(createModerationProcessor(model))] : []),
  ];
  if (steps.length === 0) return null;
  const carryBranch = flags.pii ? "processor:pii-detector" : steps[0]!.id;
  return asInputProcessorWorkflow(createWorkflow({
    id: "qingagent-input-llm-guardrails",
    inputSchema: ProcessorStepSchema,
    outputSchema: ProcessorStepSchema,
  })
    .parallel(steps)
    .map(async ({ inputData }) => selectParallelBranch(inputData, carryBranch))
    .commit());
}

function buildOutputGuardrailWorkflow(
  flags: QingagentProcessorFlags,
  model: OpenAICompatibleConfig,
): OutputProcessorOrWorkflow | null {
  const steps = [
    ...(flags.pii ? [createStep(createPiiDetector(model))] : []),
    ...(flags.moderation ? [createStep(createModerationProcessor(model))] : []),
  ];
  if (steps.length === 0) return null;
  const carryBranch = flags.pii ? "processor:pii-detector" : steps[0]!.id;
  return asOutputProcessorWorkflow(createWorkflow({
    id: "qingagent-output-llm-guardrails",
    inputSchema: ProcessorStepSchema,
    outputSchema: ProcessorStepSchema,
  })
    .parallel(steps)
    .map(async ({ inputData }) => selectParallelBranch(inputData, carryBranch))
    .commit());
}

export function buildQingagentInputProcessors({
  requestContext,
}: {
  requestContext?: RequestContext;
} = {}): InputProcessorOrWorkflow[] {
  const flags = resolveQingagentProcessorFlags();
  const processors: InputProcessorOrWorkflow[] = [DEFAULT_UNICODE_NORMALIZER];
  const toolSearch = toolSearchProcessorFromRequestContext(requestContext);
  if (toolSearch) processors.push(toolSearch);
  if (hasInputLlmGuardrail(flags)) {
    const llmGuardrails = buildInputGuardrailWorkflow(
      flags,
      resolveQingagentGuardrailModel(requestContext),
    );
    if (llmGuardrails) processors.push(llmGuardrails);
  }
  return processors;
}

export function buildQingagentOutputProcessors({
  requestContext,
}: {
  requestContext?: RequestContext;
} = {}): OutputProcessorOrWorkflow[] {
  const flags = resolveQingagentProcessorFlags();
  const processors: OutputProcessorOrWorkflow[] = [DEFAULT_BATCH_PARTS_PROCESSOR];
  if (hasOutputLlmGuardrail(flags)) {
    const llmGuardrails = buildOutputGuardrailWorkflow(
      flags,
      resolveQingagentGuardrailModel(requestContext),
    );
    if (llmGuardrails) processors.push(llmGuardrails);
  }
  return processors;
}

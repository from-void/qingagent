import type { LegacySection } from "@qingagent/contract-ts";
import {
  compileAiDocumentToPm,
  countDocVisibleChars,
  pmToLegacySections,
  qingmlParse,
  type AiIrBlockError,
  type PmDoc,
} from "@qingagent/pm-schema";
import type { Material } from "../types/material.js";

export interface GenerateAiDocumentResult {
  success: true;
  doc: PmDoc;
  legacySections: LegacySection[];
  wordCount: number;
  generationMode: "streamObject" | "fallbackStreamText";
  blockErrors?: never;
  error?: never;
}

export interface GenerateAiDocumentFailure {
  success: false;
  error: string;
  blockErrors?: AiIrBlockError[];
  doc?: never;
  legacySections?: never;
  wordCount?: never;
  generationMode?: "streamObject" | "fallbackStreamText";
}

export type GenerateAiDocumentOutput = GenerateAiDocumentResult | GenerateAiDocumentFailure;

export interface RetryAiBlockContext {
  index: number;
  error: AiIrBlockError;
  previousBlock: unknown;
  document: { title?: string | null; blocks: unknown[] };
}

export type RetryAiBlock = (context: RetryAiBlockContext) => Promise<unknown>;

export type AiDocumentParseFailureKind =
  | "length_truncated"
  | "qingml_bad_block"
  | "qingml_empty";

export interface AiDocumentParseDiagnostics {
  extracted: string;
  repaired: boolean;
  repairKinds: string[];
  failureKind?: AiDocumentParseFailureKind;
}

export class AiDocumentParseError extends Error {
  constructor(
    message: string,
    readonly diagnostics: AiDocumentParseDiagnostics,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AiDocumentParseError";
  }
}

export function isLengthTruncatedFinishReason(finishReason: string | null | undefined): boolean {
  const value = finishReason?.trim().toLowerCase();
  return value === "length" || value === "max_tokens";
}

export function parseAiDocumentFromQingml(
  rawText: string,
  title?: string,
): { document: { title?: string | null; blocks: unknown[] }; diagnostics: AiDocumentParseDiagnostics } {
  const result = qingmlParse(rawText);
  const badBlocks = result.warnings.filter((warning) => warning.severity === "bad-block");
  if (badBlocks.length > 0) {
    const details = badBlocks.map((warning) => `${warning.kind}: ${warning.detail}`).join("; ");
    throw new AiDocumentParseError(
      `QingML bad-block: ${details}`,
      { extracted: rawText, repaired: false, repairKinds: [], failureKind: "qingml_bad_block" },
    );
  }
  if (result.blocks.length === 0) {
    throw new AiDocumentParseError(
      "QingML document is empty",
      { extracted: rawText, repaired: false, repairKinds: [], failureKind: "qingml_empty" },
    );
  }
  return {
    document: { title: result.title ?? title ?? null, blocks: result.blocks },
    diagnostics: { extracted: rawText, repaired: false, repairKinds: [] },
  };
}

function tallyBlockKinds(blocks: unknown[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const b of blocks) {
    const k = b && typeof b === "object" && "type" in b ? String((b as { type: unknown }).type) : "?";
    t[k] = (t[k] ?? 0) + 1;
  }
  return t;
}

function tallyStrings(arr: string[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const s of arr) t[s] = (t[s] ?? 0) + 1;
  return t;
}

export async function compileAiDocumentWithBlockRetry(
  input: { title?: string | null; blocks: unknown[] },
  retryBlock?: RetryAiBlock,
  maxBlockRetries = 1,
): Promise<GenerateAiDocumentOutput> {
  const working = {
    title: input.title,
    blocks: [...input.blocks],
  };

  for (let attempt = 0; attempt <= maxBlockRetries; attempt++) {
    const compiled = compileAiDocumentToPm(working);
    console.log("[writeDraft] AI-IR 编译结果", {
      attempt,
      ok: compiled.ok,
      inputBlockKinds: tallyBlockKinds(working.blocks),
      pmBlockTypes: compiled.doc ? tallyStrings(compiled.doc.content.map((n) => n.type)) : null,
      droppedBlocks: compiled.blockErrors.map((e) => ({ index: e.index, msg: e.message.slice(0, 120) })),
      wordCount: compiled.doc ? countDocVisibleChars(compiled.doc) : 0,
    });
    if (compiled.ok && compiled.doc) {
      const legacySections = pmToLegacySections(compiled.doc) as unknown as LegacySection[];
      return {
        success: true,
        doc: compiled.doc,
        legacySections,
        wordCount: countDocVisibleChars(compiled.doc),
        generationMode: "fallbackStreamText",
      };
    }

    const retryableErrors = compiled.blockErrors.filter((error) => error.index >= 0);
    if (!retryBlock || attempt >= maxBlockRetries || retryableErrors.length === 0) {
      return {
        success: false,
        error: compiled.blockErrors.map((error) => `block ${error.index}: ${error.message}`).join("; "),
        blockErrors: compiled.blockErrors,
      };
    }

    await Promise.all(
      retryableErrors.map(async (error) => {
        const replacement = await retryBlock({
          index: error.index,
          error,
          previousBlock: working.blocks[error.index],
          document: working,
        });
        working.blocks[error.index] = replacement;
      }),
    );
  }

  return { success: false, error: "AI-IR block retry exhausted" };
}

export function materialContextFrom(materials: Map<string, Material> | undefined): string {
  return materials
    ? Array.from(materials.values())
        .map((m) => {
          // 抓取类素材带来源 URL 时,把 URL 一并喂给生成模型——否则『检索来源引用范本』要求
          // 模型用 url 原值挂 link mark,模型却看不到 url,只能省略或瞎猜(回归 search-ref-not-citation-block)。
          const url = m.metadata?.sourceUrl;
          const head = url ? `素材: ${m.filename}（来源URL: ${url}）` : `素材: ${m.filename}`;
          const body = m.visionSummary
            ? `【图像识别摘要】${m.visionSummary}\n${m.text}`
            : m.text;
          return `${head}\n${body}`;
        })
        .join("\n\n")
    : "";
}

/** writeDraft 只追加任务与素材；完整 QingML 规则只存在主 system。 */
export function buildQingmlSteeringTail(materialContext: string, finalInstruction: string): string {
  return [
    "不要调用任何工具。现在进入 writeDraft 旁支生成模式，按主 system 的 QingML 生成总规直接输出文档。",
    materialContext ? `以下是本次素材（仅作参考，来源 URL 必须原样用于可点击引用）：\n${materialContext}` : "本次没有可用图片或文件，不要输出 <img>/<file>。",
    finalInstruction,
    "首字符必须是 <；只输出完整闭合的 QingML，不要输出聊天文字、问卷、Markdown fence 或解释。",
  ].join("\n\n");
}

export function buildQingmlRetryUserPrompt(basePrompt: string, attempt: number, lastError: string): string {
  if (attempt <= 0) return basePrompt;
  return `${basePrompt}\n\n上一轮输出未通过 QingML 解析或校验，错误: ${lastError.slice(0, 500)}\n本次是第 ${attempt + 1} 次尝试：只输出完整、闭合的 QingML 标记。特别注意：<pre>/<math-block>/<mermaid>/<drawio> 内的 < 和 & 必须写成 &lt; / &amp;。不要输出 markdown fence、解释文字或半截标记。`;
}

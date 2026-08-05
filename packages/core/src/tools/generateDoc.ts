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
import { MATERIAL_CONTEXT_MAX_CHARS } from "./materialContextBudget.js";

export { MATERIAL_CONTEXT_MAX_CHARS } from "./materialContextBudget.js";

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

const MATERIAL_CONTEXT_CHUNK_CHARS = 4_000;

export interface MaterialContextOptions {
  /** 标题、提纲与当前任务等，用于超预算后的确定性分块选取。 */
  relevanceText?: string;
  maxChars?: number;
  /** 仅供确定性调优与测试覆盖；生产使用集中定义的默认块大小。 */
  chunkChars?: number;
}

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

function materialHead(material: Material): string {
  // 抓取类素材带来源 URL 时,把 URL 一并喂给生成模型——否则『检索来源引用范本』要求
  // 模型用 url 原值挂 link mark,模型却看不到 url,只能省略或瞎猜(回归 search-ref-not-citation-block)。
  const url = material.metadata?.sourceUrl;
  return url
    ? `素材: ${material.filename}（来源URL: ${url}）`
    : `素材: ${material.filename}`;
}

function materialBody(material: Material): string {
  return material.visionSummary
    ? `【图像识别摘要】${material.visionSummary}\n${material.text}`
    : material.text;
}

function splitMaterialText(text: string, maxChars: number): string[] {
  if (!text) return [""];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const minBreak = start + Math.floor(maxChars / 2);
      const candidates = [
        text.lastIndexOf("\n\n", end),
        text.lastIndexOf("\n", end),
        text.lastIndexOf("。", end),
        text.lastIndexOf("！", end),
        text.lastIndexOf("？", end),
      ].filter((index) => index >= minBreak);
      if (candidates.length > 0) end = Math.max(...candidates) + 1;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    start = end;
    while (start < text.length && /\s/u.test(text[start] ?? "")) start += 1;
  }
  return chunks.length > 0 ? chunks : [""];
}

function relevanceTerms(value: string): string[] {
  const normalized = value.toLowerCase();
  const terms = new Set(
    normalized.match(/[a-z0-9][a-z0-9._+-]{1,}/g) ?? [],
  );
  for (const cjk of normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/gu) ?? []) {
    if (cjk.length <= 12) terms.add(cjk);
    const chars = Array.from(cjk);
    for (let index = 0; index < chars.length - 1; index += 1) {
      terms.add(`${chars[index]}${chars[index + 1]}`);
    }
  }
  return [...terms];
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset < haystack.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function scoreMaterialChunk(
  material: Material,
  chunk: string,
  terms: readonly string[],
): number {
  if (terms.length === 0) return 0;
  const body = chunk.toLowerCase();
  const metadata = [
    material.filename,
    material.metadata.title,
    material.summary,
    material.visionSummary,
  ].filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n")
    .toLowerCase();
  return terms.reduce((score, term) => {
    const bodyHits = countOccurrences(body, term);
    const metadataHit = metadata.includes(term) ? 1 : 0;
    return score + bodyHits * Math.max(2, term.length) + metadataHit;
  }, 0);
}

export function materialContextFrom(
  materials: Map<string, Material> | undefined,
  options: MaterialContextOptions = {},
): string {
  if (!materials || materials.size === 0) return "";
  const maxChars = Math.max(
    0,
    Math.floor(options.maxChars ?? MATERIAL_CONTEXT_MAX_CHARS),
  );
  if (maxChars === 0) return "";

  const materialList = Array.from(materials.values());
  const fullContext = materialList
    .map((material) => `${materialHead(material)}\n${materialBody(material)}`)
    .join("\n\n");
  if (fullContext.length <= maxChars) return fullContext;

  const chunkChars = Math.max(
    32,
    Math.floor(options.chunkChars ?? MATERIAL_CONTEXT_CHUNK_CHARS),
  );
  const terms = relevanceTerms(options.relevanceText ?? "");
  const candidates = materialList.flatMap((material, materialIndex) => {
    const chunks = splitMaterialText(materialBody(material), chunkChars);
    return chunks.map((chunk, chunkIndex) => ({
      materialIndex,
      chunkIndex,
      score: scoreMaterialChunk(material, chunk, terms),
      rendered: `${materialHead(material)}（节选 ${chunkIndex + 1}/${chunks.length}）\n${chunk}`,
    }));
  }).sort((left, right) =>
    right.score - left.score ||
    left.materialIndex - right.materialIndex ||
    left.chunkIndex - right.chunkIndex
  );

  const selected: typeof candidates = [];
  let selectedLength = 0;
  for (const candidate of candidates) {
    const separatorLength = selected.length > 0 ? 2 : 0;
    if (selectedLength + separatorLength + candidate.rendered.length > maxChars) continue;
    selected.push(candidate);
    selectedLength += separatorLength + candidate.rendered.length;
  }

  // 极端情况下连一个片段的标题/URL 都装不下，也必须返回有界文本而非让请求失败。
  if (selected.length === 0) return (candidates[0]?.rendered ?? fullContext).slice(0, maxChars);

  return selected
    .sort((left, right) =>
      left.materialIndex - right.materialIndex ||
      left.chunkIndex - right.chunkIndex
    )
    .map((candidate) => candidate.rendered)
    .join("\n\n")
    .slice(0, maxChars);
}

/** writeDraft 追加任务、素材与按需技能；未激活技能时仍不复制主 system 的 QingML 总规。 */
export function buildQingmlSteeringTail(
  materialContext: string,
  finalInstruction: string,
  skillInstruction = "",
): string {
  return [
    "不要调用任何工具。现在进入 writeDraft 旁支生成模式，按主 system 的 QingML 生成总规直接输出文档。",
    materialContext ? `以下是本次素材（仅作参考，来源 URL 必须原样用于可点击引用）：\n${materialContext}` : "本次没有可用图片或文件，不要输出 <img>/<file>。",
    skillInstruction,
    finalInstruction,
    "首字符必须是 <；只输出完整闭合的 QingML，不要输出聊天文字、问卷、Markdown fence 或解释。",
  ].filter(Boolean).join("\n\n");
}

export function buildQingmlRetryUserPrompt(basePrompt: string, attempt: number, lastError: string): string {
  if (attempt <= 0) return basePrompt;
  return `${basePrompt}\n\n上一轮输出未通过 QingML 解析或校验，错误: ${lastError.slice(0, 500)}\n本次是第 ${attempt + 1} 次尝试：只输出完整、闭合的 QingML 标记。特别注意：<pre>/<math-block>/<mermaid>/<drawio> 内的 < 和 & 必须写成 &lt; / &amp;。不要输出 markdown fence、解释文字或半截标记。`;
}

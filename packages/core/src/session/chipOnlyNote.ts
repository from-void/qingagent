import { createHash } from "node:crypto";
import { parseChipRichText, type ChatChip } from "@qingagent/contract-ts";

export const DEFAULT_SKILL_CHIP_INSTRUCTION_CHAR_LIMIT = 200_000;

export type SkillChipLoadFailureReason =
  | "missing-skill-id"
  | "disabled"
  | "not-found"
  | "read-failed";

export type SkillChipInstructionLoadResult =
  | {
      ok: true;
      id: string;
      source: string;
      content: string;
    }
  | {
      ok: false;
      id: string;
      reason: Exclude<SkillChipLoadFailureReason, "missing-skill-id">;
      message?: string;
      error?: string;
    };

export type SkillChipInstructionLoader = (input: {
  id: string;
  label: string;
  index: number;
}) => Promise<SkillChipInstructionLoadResult>;

export interface SkillChipWarning {
  kind: SkillChipLoadFailureReason | "truncated";
  index: number;
  skillId?: string;
  label: string;
  message: string;
}

export interface ComposeInlineChipTextOptions {
  loadSkillInstruction?: SkillChipInstructionLoader;
  maxSkillInstructionChars?: number;
}

export interface ComposeInlineChipTextResult {
  text: string;
  warnings: SkillChipWarning[];
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSkillLikeChip(chip: ChatChip): boolean {
  return chip.kind.kind === "skill" || (chip.kind.kind === "mention" && typeof chip.skillId === "string");
}

function plainChipAnchor(chip: ChatChip): string {
  switch (chip.kind.kind) {
    case "skill":
      return `「技能：${chip.label}」`;
    case "attach":
      return `「文件：${chip.label}」`;
    case "mention":
      return isSkillLikeChip(chip) ? `「技能：${chip.label}」` : `「引用：${chip.label}」`;
    case "selection":
    case "insertion":
      return `「选区：${chip.label}」`;
    default:
      return `「${chip.label}」`;
  }
}

function inlineTextChipContent(chip: ChatChip): string | null {
  return chip.kind.kind === "text" && typeof chip.text === "string" && chip.text.length > 0
    ? chip.text
    : null;
}

function failureText(label: string, reason: SkillChipLoadFailureReason, detail?: string): string {
  switch (reason) {
    case "missing-skill-id":
      return `技能 ${label} 缺少可信 skillId，未加载技能说明。`;
    case "disabled":
      return `技能 ${label} 未启用，未加载技能说明。`;
    case "not-found":
      return `技能 ${label} 不存在，未加载技能说明。`;
    case "read-failed":
      return `技能 ${label} 读取失败，未加载技能说明。${detail ? ` ${detail}` : ""}`;
  }
}

function renderSkillContextBlock(args: {
  index: number;
  skillId: string;
  label: string;
  source: string;
  content: string;
  maxChars: number;
  warnings: SkillChipWarning[];
}): string {
  const { index, skillId, label, source, content, maxChars, warnings } = args;
  const contentHash = sha256(content);
  const truncated = content.length > maxChars;
  const injectedContent = truncated ? content.slice(0, maxChars) : content;
  if (truncated) {
    warnings.push({
      kind: "truncated",
      index,
      skillId,
      label,
      message: `技能 ${label} 的 SKILL.md 长度 ${content.length} 字符，超过硬上限 ${maxChars}，已截断注入。`,
    });
  }

  const attrs = [
    `type="skill"`,
    `index="${index}"`,
    `id="${escapeXmlAttr(skillId)}"`,
    `label="${escapeXmlAttr(label)}"`,
    `source="${escapeXmlAttr(source)}"`,
    `sha256="${contentHash}"`,
    `length="${content.length}"`,
    ...(truncated ? [`truncated="true"`, `limit="${maxChars}"`] : []),
  ].join(" ");
  const diagnostic = truncated
    ? `<qa_chip_diagnostic>技能 instruction 原始长度 ${content.length} 字符，超过硬上限 ${maxChars}，这里只注入前 ${injectedContent.length} 字符；后续内容未静默摘要。</qa_chip_diagnostic>\n`
    : "";

  return [
    `<qa_chip_context ${attrs}>`,
    diagnostic + `<trusted_skill_instruction>`,
    escapeXmlText(injectedContent),
    `</trusted_skill_instruction>`,
    `</qa_chip_context>`,
  ].join("\n");
}

/**
 * 把带 `{{chip:N}}` 占位的 richText 展开成**模型可读的内联文本**。
 *
 * 技能 chip 使用“短锚点 + 紧随结构化块”:锚点保留用户句中位置,结构化块强制注入
 * 完整 SKILL.md。长文本 text chip 是用户正文,按原位内联完整原文。文件/引用/选区
 * chip 保持原有短锚点行为,不把资料当指令执行。
 * 缺失下标的占位符原样保留(宁可模型看到痕迹,不静默吞内容)。
 */
export async function composeInlineChipText(
  richText: string,
  chips: ChatChip[],
  options: ComposeInlineChipTextOptions = {},
): Promise<ComposeInlineChipTextResult> {
  const warnings: SkillChipWarning[] = [];
  const maxChars = options.maxSkillInstructionChars ?? DEFAULT_SKILL_CHIP_INSTRUCTION_CHAR_LIMIT;
  const firstSkillIndexById = new Map<string, number>();
  let out = "";

  for (const part of parseChipRichText(richText)) {
    if (part.kind === "text") {
      out += part.text;
      continue;
    }
    const marker = part.marker;
    const chipIndex = part.index;
    const chip = chips[chipIndex];
    if (!chip) {
      out += marker;
      continue;
    }

    const anchor = plainChipAnchor(chip);
    if (!isSkillLikeChip(chip)) {
      out += inlineTextChipContent(chip) ?? anchor;
      continue;
    }

    const skillId = typeof chip.skillId === "string" && chip.skillId.trim() ? chip.skillId.trim() : null;
    if (!skillId) {
      const message = failureText(chip.label, "missing-skill-id");
      warnings.push({
        kind: "missing-skill-id",
        index: chipIndex,
        label: chip.label,
        message,
      });
      out += `${anchor}\n[系统：${message}]`;
      continue;
    }

    const firstIndex = firstSkillIndexById.get(skillId);
    if (firstIndex !== undefined) {
      out += `${anchor}<qa_chip_ref target="skill:${escapeXmlAttr(skillId)}" firstIndex="${firstIndex}" />`;
      continue;
    }
    firstSkillIndexById.set(skillId, chipIndex);

    if (!options.loadSkillInstruction) {
      const message = failureText(chip.label, "read-failed", "技能加载器不可用。");
      warnings.push({
        kind: "read-failed",
        index: chipIndex,
        skillId,
        label: chip.label,
        message,
      });
      out += `${anchor}\n[系统：${message}]`;
      continue;
    }

    let loaded: SkillChipInstructionLoadResult;
    try {
      loaded = await options.loadSkillInstruction({ id: skillId, label: chip.label, index: chipIndex });
    } catch (error) {
      loaded = {
        ok: false,
        id: skillId,
        reason: "read-failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!loaded.ok) {
      const message = failureText(chip.label, loaded.reason, loaded.message ?? loaded.error);
      warnings.push({
        kind: loaded.reason,
        index: chipIndex,
        skillId,
        label: chip.label,
        message,
      });
      out += `${anchor}\n[系统：${message}]`;
      continue;
    }

    out += `${anchor}\n${renderSkillContextBlock({
      index: chipIndex,
      skillId,
      label: chip.label,
      source: loaded.source,
      content: loaded.content,
      maxChars,
      warnings,
    })}`;
  }

  return { text: out, warnings };
}

/**
 * 纯 chip 发送(用户没打字)时追加给模型的引导(动作本身已由内联 token 表达):
 * 实测 deepseek-v4-flash 面对只有 token 没有诉求的消息容易泛化问候/空响应,
 * 补一句明确引导:先询问缺少的输入,确认后再执行。
 */
export function buildChipOnlyGuidance(chips: ChatChip[]): string | null {
  if (chips.length === 0) return null;
  return (
    "\n\n[系统：用户没有输入文字，仅发送了以上选择。" +
    "请按其用途回应：先向用户询问缺少的输入（例如链接、主题或具体要求），确认后再开始执行，不要当成普通空消息。]"
  );
}

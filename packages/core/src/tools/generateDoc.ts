import type { LegacySection } from "@qingagent/contract-ts";
import {
  aiDocumentEnvelopeSchema,
  compileAiDocumentToPm,
  countDocVisibleChars,
  pmToLegacySections,
  pmToPlainText,
  type AiIrBlockError,
  type PmDoc,
} from "@qingagent/pm-schema";
import { extractJson } from "../bridge/docGenerator.js";
import { repairModelJson } from "../llm/repairToolCallJson.js";
import { repairJsonSyntax } from "../llm/repairJsonSyntax.js";
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
  | "json_syntax"
  | "json_repaired"
  | "non_json"
  | "unescaped_quote"
  | "unclosed_brackets"
  | "length_truncated"
  | "schema";

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

function parseJsonWithModelRepair(
  jsonStr: string,
  opts: {
    finishReason?: string | null;
    repairSyntax?: boolean;
    failOnMissingFinishReasonForCloserRepair?: boolean;
  } = {},
): { parsed: unknown; diagnostics: Omit<AiDocumentParseDiagnostics, "extracted"> } {
  if (isLengthTruncatedFinishReason(opts.finishReason)) {
    throw new AiDocumentParseError(
      `AI-IR JSON was truncated by finish_reason=${opts.finishReason}`,
      { extracted: jsonStr, repaired: false, repairKinds: [], failureKind: "length_truncated" },
    );
  }

  try {
    return { parsed: JSON.parse(jsonStr) as unknown, diagnostics: { repaired: false, repairKinds: [] } };
  } catch (error) {
    const repaired = repairModelJson(jsonStr);
    if (repaired.ok && repaired.changed) {
      try {
        return {
          parsed: JSON.parse(repaired.json) as unknown,
          diagnostics: { repaired: true, repairKinds: ["model_json"] },
        };
      } catch {
        // repairModelJson 自身已 fail-closed；这里继续尝试结构性修复。
      }
    }

    const structuralRepair = opts.repairSyntax === false
      ? { ok: false as const, reason: "noHighConfidenceRepair" as const, repairs: [] }
      : repairJsonSyntax(jsonStr);
    if (structuralRepair.ok) {
      if (structuralRepair.changed) {
        if (
          opts.failOnMissingFinishReasonForCloserRepair &&
          !opts.finishReason &&
          structuralRepair.repairs.some((kind) => kind === "append_missing_closers" || kind.startsWith("insert_missing_"))
        ) {
          throw new AiDocumentParseError(
            "AI-IR JSON ended before finish_reason; refusing closer repair",
            {
              extracted: jsonStr,
              repaired: false,
              repairKinds: structuralRepair.repairs,
              failureKind: "length_truncated",
            },
          );
        }
        return {
          parsed: JSON.parse(structuralRepair.json) as unknown,
          diagnostics: { repaired: true, repairKinds: structuralRepair.repairs },
        };
      }
      return {
        parsed: JSON.parse(structuralRepair.json) as unknown,
        diagnostics: { repaired: false, repairKinds: [] },
      };
    }

    const failureKind = classifyJsonParseFailure(jsonStr, error);
    throw new AiDocumentParseError(
      error instanceof Error ? error.message : String(error),
      { extracted: jsonStr, repaired: false, repairKinds: structuralRepair.repairs, failureKind },
      error,
    );
  }
}

function classifyJsonParseFailure(jsonStr: string, error: unknown): AiDocumentParseFailureKind {
  const trimmed = jsonStr.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return "non_json";
  const message = error instanceof Error ? error.message : String(error);
  if (/property value|after property|Unexpected non-whitespace|unterminated string|bad control character/i.test(message)) {
    return "unescaped_quote";
  }
  if (/end of JSON input|Expected ',' or ']'|Expected ',' or '}'|Unexpected token.*(}|])/i.test(message)) {
    return "unclosed_brackets";
  }
  return "json_syntax";
}

export function parseAiDocumentFromTextDetailed(
  rawText: string,
  title?: string,
  opts: {
    finishReason?: string | null;
    repairSyntax?: boolean;
    failOnMissingFinishReasonForCloserRepair?: boolean;
  } = {},
): { document: { title?: string | null; blocks: unknown[] }; diagnostics: AiDocumentParseDiagnostics } {
  const jsonStr = extractJson(rawText);
  let parsed: unknown;
  let parseDiagnostics: Omit<AiDocumentParseDiagnostics, "extracted">;
  try {
    const parsedResult = parseJsonWithModelRepair(jsonStr, opts);
    parsed = parsedResult.parsed;
    parseDiagnostics = parsedResult.diagnostics;
  } catch (error) {
    if (error instanceof AiDocumentParseError) throw error;
    throw new AiDocumentParseError(
      error instanceof Error ? error.message : String(error),
      { extracted: jsonStr, repaired: false, repairKinds: [], failureKind: "json_syntax" },
      error,
    );
  }
  const candidate = Array.isArray(parsed)
    ? { title, blocks: parsed }
    : parsed;
  const validated = aiDocumentEnvelopeSchema.safeParse(candidate);
  if (!validated.success) {
    throw new AiDocumentParseError(
      validated.error.message,
      {
        extracted: jsonStr,
        repaired: parseDiagnostics.repaired,
        repairKinds: parseDiagnostics.repairKinds,
        failureKind: "schema",
      },
      validated.error,
    );
  }
  return {
    document: validated.data,
    diagnostics: {
      extracted: jsonStr,
      repaired: parseDiagnostics.repaired,
      repairKinds: parseDiagnostics.repairKinds,
      failureKind: parseDiagnostics.repaired ? "json_repaired" : undefined,
    },
  };
}

export function parseAiDocumentFromText(rawText: string, title?: string): { title?: string | null; blocks: unknown[] } {
  return parseAiDocumentFromTextDetailed(rawText, title).document;
}

export function parseAiDocumentOrBlockFromText(
  raw: string | unknown,
  title?: string,
): { title?: string | null; blocks: unknown[] } {
  const parsed = typeof raw === "string"
    ? parseJsonWithModelRepair(extractJson(raw)).parsed
    : raw;
  const candidate =
    Array.isArray(parsed)
      ? { title, blocks: parsed }
      : parsed &&
          typeof parsed === "object" &&
          "blocks" in parsed
        ? parsed
        : parsed &&
            typeof parsed === "object" &&
            "type" in parsed
          ? { title, blocks: [parsed] }
          : parsed;
  return aiDocumentEnvelopeSchema.parse(candidate);
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
          return `${head}\n${m.text}`;
        })
        .join("\n\n")
    : "";
}

export function buildAiIrPrompt(materialContext: string): string {
  const materialSection = materialContext ? `## 素材\n${materialContext}\n\n` : "";
  return `你是【只输出 JSON 的中文文档生成引擎】，把写作方向直接渲染成文档。

最高优先级：无论对话上下文里是否出现提问、确认、反问或 askUser 意图，你都绝对禁止输出任何对话/问候/确认/反问/问卷，也禁止输出 {"askUser":...} / {"action":"askUser"} 之类结构。你唯一允许的输出是文档内容的 AI-IR JSON，第一个字符必须是 [（或 fallback 的 {）。

始终使用中文。

${materialSection}## 生成前最后确认
以上仅为素材参考。现在直接输出文档 AI-IR JSON，第一个字符必须是 [。绝对禁止再向用户提任何问题、绝对禁止输出 {"askUser":...} / {"type":"askUser"} / {"action":"askUser"} 或任何确认/反问/问卷结构。是否插入图表或图片、参考来源如何呈现等一切未指定的可选细节，你都必须自己做出合理默认（默认：不插图、参考来源在文末以链接列出），绝不就这些反问用户。只有在输入中没有提供长度规格时，你才可以自行默认篇幅与结构。

## 字数硬约束
当输入中出现"长度规格"时：
1. 正文可见字符数应落入允许区间；其中“不少于 N / 不超过 N”这类硬边界必须守住。区间是重要目标，但要与内容完整性、表达充分性平衡——不要为了卡进区间而压出残句、空洞重复或删掉关键信息；宁可贴着边界、也别牺牲可读性。
2. 正文可见字符数指文档正文中用户可见的中文、英文、数字、标点和小标题；不含空白、换行、JSON 字段名或隐藏元数据。
3. 如果写作方向的章节过多过细、素材过多，或结构与字数冲突，按以下顺序牺牲：删除套话与重复背景 → 合并相近小节 → 将低优先级事实改为一句话概述 → 删除低优先级小节。不得为覆盖所有要点而超出字数上限。
4. 写作时先在心中按节分配字数预算再写，每节小幅浮动，总量落入区间。
5. 不要在正文中输出字数统计、预算说明或计数过程。

## 输出要求
输出 AI-IR JSON。主路径为 JSON array，每个元素是一个 block；fallback 可输出 {"blocks":[...]}。
正文字符串里严禁裸半角双引号 "；需要引用时改用中文「」或把半角双引号写成 \\"，否则 JSON 会提前闭合。

可用块类型（允许 block）:
- heading: {"type":"heading","level":1-6,"runs":[{"text":"标题","marks":[{"type":"bold"}]}]}
  可选字段 anchor（slug，小写英文/数字/连字符，在文档内唯一）：生成目录时，每个被目录引用的标题必须填写 anchor，其他情况可省略。示例：{"type":"heading","level":2,"anchor":"background","runs":[{"text":"背景介绍"}]}
- paragraph: {"type":"paragraph","textAlign":"left|center|right|justify","runs":[{"text":"正文"}]}
- blockquote: {"type":"blockquote","runs":[{"text":"引用"}]}
- bulletList: {"type":"bulletList","items":[{"runs":[{"text":"一级条目"}],"children":[{"type":"bulletList","items":[{"runs":[{"text":"二级条目"}],"children":[{"type":"bulletList","items":[{"runs":[{"text":"三级条目"}]}]}]}]}]}]}。多级清单必须用 children 递归表达；children 里必须放子 bulletList 或 orderedList，不能放 paragraph。禁止用空格/编号文本模拟层级。
- orderedList: {"type":"orderedList","items":[{"runs":[{"text":"第一项"}],"children":[{"type":"orderedList","items":[{"runs":[{"text":"子项"}]}]}]}]}。有序列表用 orderedList，无序列表用 bulletList；不要输出 {"type":"list","ordered":...} 这种兼容旧写法。
- codeBlock: {"type":"codeBlock","language":"ts","text":"代码"}
- table: {"type":"table","rows":[{"cells":[{"runs":[{"text":"列"}],"header":true}]}]}
- horizontalRule: {"type":"horizontalRule"}
- penNote: {"type":"penNote","runs":[{"text":"旁注"}]}
- taskList: {"type":"taskList","items":[{"checked":false,"runs":[{"text":"父任务"}],"children":[{"type":"taskList","items":[{"checked":false,"runs":[{"text":"子任务"}]},{"checked":true,"runs":[{"text":"已完成子任务"}]}]}]}]}（任务清单/行动项专用，不要用 bulletList 模拟）。多级待办必须用 children 里的子 taskList 表达层级；严禁用 "- [ ]"、缩进或编号文本假装层级。
- callout: {"type":"callout","emoji":"💡","tone":"info","runs":[{"text":"提示内容"}]}（tone 只允许 info/success/warning/danger/neutral。用户要求"提示框/注意/风险/结论卡片/高亮框/强调块"时必须用 callout,不得用 blockquote 或普通 paragraph 代替）
- columnList: {"type":"columnList","columns":[{"widthRatio":0.5,"blocks":[{"type":"heading","level":3,"runs":[{"text":"左栏"}]},{"type":"paragraph","runs":[{"text":"左栏内容"}]}]},{"widthRatio":0.5,"blocks":[{"type":"heading","level":3,"runs":[{"text":"右栏"}]},{"type":"paragraph","runs":[{"text":"右栏内容"}]}]}]}（用户要求分栏/双栏/三栏/左右对照时必须用真实 columnList,每栏 blocks 至少 1 个）
- blockMath: {"type":"blockMath","latex":"E = mc^2"}（块级公式，latex 为 LaTeX 源码，不要带 $ 定界符）
- diagram: {"type":"diagram","lang":"mermaid","source":"flowchart TD\\n  A[开始] --> B[结束]"}（图表块，source 为 Mermaid 源码，支持 flowchart/sequenceDiagram/classDiagram/stateDiagram/erDiagram/gantt/pie/mindmap；流程、结构、关系、对比用图比文字更清楚时用它，前端会渲染成图，svg 不用填。严禁用 codeBlock 写 mermaid 源码冒充图表。改写已有 diagram 时必须保留已有节点/实体/class/state 的稳定 id，只改 label、边或必要结构，不要无故整体换 id）
- image: 只允许使用已经存在的 /api/v1/files/<uuid>/<filename>，绝不编造图片 src。
- fileAttachment: 只在素材确有文件 id 时使用。

## 列表与分栏结构
- 2 级或更多级列表必须使用 children 递归：父 item 里放 children，children 里放一个子 bulletList/orderedList/taskList 块，子块的 items 才是下一级条目。children 里不能直接放 paragraph 来冒充子项。
- 用户要求"两级列表/三级列表/多级列表/嵌套列表/层级清单"时，必须真的出现 children 子列表；三级诉求必须在二级 item 的 children 里再出现一层子列表。严禁把二级/三级条目写成同级 items，严禁在 text 里用 1.1、①、前导空格、-、缩进或换行来模拟层级。
- 正确两级完整示例: [{"type":"bulletList","items":[{"runs":[{"text":"一级目标 A"}],"children":[{"type":"bulletList","items":[{"runs":[{"text":"二级动作 A1"}]},{"runs":[{"text":"二级动作 A2"}]}]}]},{"runs":[{"text":"一级目标 B"}],"children":[{"type":"bulletList","items":[{"runs":[{"text":"二级动作 B1"}]}]}]}]}]
- canonical 两级读书笔记示例（照此结构，不要平铺）: [{"type":"bulletList","items":[{"runs":[{"text":"阅读前准备"}],"children":[{"type":"bulletList","items":[{"runs":[{"text":"明确阅读目的"}]},{"runs":[{"text":"浏览目录与序言"}]},{"runs":[{"text":"准备问题清单"}]}]}]},{"runs":[{"text":"阅读中记录"}],"children":[{"type":"bulletList","items":[{"runs":[{"text":"摘录关键句"}]},{"runs":[{"text":"标记疑问点"}]},{"runs":[{"text":"记录页码来源"}]}]}]},{"runs":[{"text":"阅读后复盘"}],"children":[{"type":"bulletList","items":[{"runs":[{"text":"用自己的话复述"}]},{"runs":[{"text":"提炼行动项"}]},{"runs":[{"text":"安排二次阅读"}]}]}]}]}]
- 正确三级完整示例: [{"type":"bulletList","items":[{"runs":[{"text":"一级阶段"}],"children":[{"type":"bulletList","items":[{"runs":[{"text":"二级任务"}],"children":[{"type":"bulletList","items":[{"runs":[{"text":"三级检查点"}]}]}]}]}]}]}]
- 错误示例: {"type":"bulletList","items":[{"runs":[{"text":"一级阶段"}]},{"runs":[{"text":"  - 二级任务"}]},{"runs":[{"text":"1.1.1 三级检查点"}]}]}。这不是嵌套列表，必须改成上面的 children 子列表结构。
- 分栏必须输出 columnList，columns 至少 2 栏；每栏写成 {"blocks":[...]}，blocks 内放真实块，不要把左右栏内容合并成普通段落。

## 文档目录（TOC）
用户要求"加目录/添加目录/生成目录/目录结构/大纲导航"时，必须：
1. 为每个被目录引用的章节标题加 anchor 字段（slug：小写英文/数字/连字符，唯一，如 "section-intro"、"background"）。
2. 在文档开头输出一个无序列表，每条目用 link mark，href 为 "#" + anchor，如 {"text":"章节名","marks":[{"type":"link","href":"#anchor"}]}。
3. 目录与正文标题的 anchor 必须一一对应，anchor 值不能重复。
- 正确目录+标题示例：
  [{"type":"bulletList","items":[{"runs":[{"text":"背景介绍","marks":[{"type":"link","href":"#background"}]}]},{"runs":[{"text":"方案设计","marks":[{"type":"link","href":"#design"}]}]}]},{"type":"heading","level":2,"anchor":"background","runs":[{"text":"背景介绍"}]},{"type":"paragraph","runs":[{"text":"..."}]},{"type":"heading","level":2,"anchor":"design","runs":[{"text":"方案设计"}]},{"type":"paragraph","runs":[{"text":"..."}]}]
- 禁止目录条目只写纯文字没有 link mark，禁止 href 不以 # 开头，禁止标题缺少 anchor 字段。

## 结构保留
改写已有文档时，除非用户明确要求删除或改成普通文本，必须保留原文中的 table / blockquote / bulletList / orderedList / taskList / callout / columnList / blockMath / diagram 语义结构，不得把它们降级为普通 paragraph 或 Markdown 管道文本。多级列表必须保留为 children 递归子列表；分栏必须保留为真实 columnList。

marks 只允许 bold/italic/underline/strike/strikeThrough/code/link/textColor/highlight/math；link href 必须是 http(s)、/ 开头或 # 开头；textColor/highlight color 只允许主题色 ink/gray/slate/brown/red/orange/amber/yellow/lime/green/sage/mint/teal/cyan/sky/blue/indigo/violet/purple/magenta/pink/rose/sand/lavender。
行内公式：用 math mark 表示，该 run 的 text 就是 LaTeX 源码（不带 $），且 math 不能与其他 mark 混用，例：{"text":"质能方程 ","marks":[]} 后接 {"text":"E=mc^2","marks":[{"type":"math"}]}。
超链接示例：{"text":"标题","marks":[{"type":"link","href":"https://example.com"}]}。禁止把 link/href/bold 当作 run 的裸字段（如 {"text":"标题","link":"https://..."}），它们必须放进 marks，否则链接/样式会丢失。

## 检索来源引用（当本文基于联网检索/抓取的来源写成时必须遵守）
当素材里带有联网检索/抓取得到的来源（每条都有 url）时，正文里引用这些来源必须做成**可点击 link mark**，不能只写纯文本来源名。
- 正文中引用某来源的数据/观点时，把来源名或角标做成 link mark：{"type":"paragraph","runs":[{"text":"2024 年装机量同比增长 40%"},{"text":"（中汽协）","marks":[{"type":"link","href":"https://来源真实URL"}]}]}。href 必须用素材里该来源的 url 原值，禁止编造域名。
- 文末"参考来源"列表的每一条也必须是 link mark 而非裸文本：{"type":"orderedList","items":[{"runs":[{"text":"中国汽车工业协会·2024 动力电池报告","marks":[{"type":"link","href":"https://来源真实URL"}]}]}]}。
- 【严禁】只写"（中汽协）""（艾媒咨询）"这类纯文本标注却不挂 link mark；每个有来源的关键数据、每条参考来源都要能点开。无检索来源的纯创作文体（散文/小说等）不受此约束。
不要输出 markdown 代码块或解释文字。`;
}

export function buildAiIrRetryUserPrompt(basePrompt: string, attempt: number, lastError: string): string {
  if (attempt <= 0) return basePrompt;
  return `${basePrompt}\n\n上一轮输出未通过 JSON 解析或 AI-IR 校验，错误: ${lastError.slice(0, 500)}\n本次是第 ${attempt + 1} 次尝试：只输出一个完整、闭合、可被 JSON.parse 解析的 AI-IR JSON array 或 {"blocks":[...]} object。不要输出 markdown fence、解释文字、收尾总结或半截 JSON。`;
}

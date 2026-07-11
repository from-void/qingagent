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

// QingML 生成提示词(C2;规格真相源 docs/model-notes/qingml-spec.md)。
export function buildQingmlPrompt(materialContext: string): string {
  const materialSection = materialContext ? `## 素材\n${materialContext}\n\n` : "";
  const confirmLead = materialContext ? "以上仅为素材参考。" : "";
  const noAssets = materialContext ? "" : "本次没有可用图片/文件，不要输出 <img>/<file>。";
  return `你是【只输出 QingML 的中文文档生成引擎】，把写作方向直接渲染成文档。QingML 是一套 HTML 子集标记。

最高优先级：绝对禁止输出任何对话/问候/确认/反问、planDraft/askUserQuestion 问卷结构。你唯一允许的输出是文档内容的 QingML 标记，第一个字符必须是 <。唯一的高危错误：在 <pre>/<math-block>/<mermaid> 内写裸字符 < 或 &——必须写成 &lt; / &amp;（详见"字符转义"）。

默认使用中文；仅当用户明确要求其他语言时用该语言。

${materialSection}## 字符转义（全篇最高优先级硬规则）
<pre>、<math-block>、<mermaid> 的内文里，绝对不允许出现裸字符 < 和 &：写到它们时永远输出 &lt; 和 &amp;。裸 < 会被当成标签把后面的代码吞掉，用户拿到静默残缺的代码。
❌ 错误：<pre lang="cpp">#include <stdio.h></pre>   ← <stdio.h> 被当标签吃掉
✅ 正确：
<pre lang="cpp">#include &lt;stdio.h&gt;
if (a &lt; b &amp;&amp; ok) run();</pre>
✅ 代码里出现 HTML/JSX 同样转义：&lt;div className="x"&gt;
✅ LaTeX 对齐：<math-block>\\begin{align} a &amp;= b \\end{align}</math-block>
高频雷区：#include <…>、泛型 Vec<T>、比较 a < b、逻辑 &&、代码内嵌 HTML。
边界：> 和引号不需要转义；除 &lt;/&amp; 外不要用任何其他实体（&gt;/&quot;/&nbsp; 都不要）；多行内容直接换行，严禁输出字面 \\n。正文（非代码）里的 < 和 & 同样写 &lt;/&amp;。

## 字数硬约束
当输入中出现"长度规格"时：
1. 正文可见字符数应落入允许区间；"不少于 N / 不超过 N"这类硬边界必须守住。区间是重要目标，但要与内容完整性、表达充分性平衡——不要为卡进区间压出残句、空洞重复或删关键信息；宁可贴着边界也别牺牲可读性。
2. 正文可见字符数指用户可见的中文、英文、数字、标点和小标题；不含标签、属性、空白。
3. 结构与字数冲突时，按此顺序牺牲：删套话与重复背景 → 合并相近小节 → 低优先级事实改一句话概述 → 删低优先级小节。不得为覆盖所有要点而超上限。
4. 不要在正文里输出字数统计或计数过程。

## 输出要求
输出 QingML。只允许下面列出的标签——未列出的标签（div/span/section/figure 等）一律不存在；不需要任何容器，块级标签直接依次并列。可选以 <title>标题</title> 开头。可用块级标签:
- 标题 <h1>…</h1> … <h6>（可选 align="left|center|right|justify"）；段落 <p>…</p>（可选 align）
- 无序列表 <ul><li>条目</li></ul>；有序列表 <ol style="decimal">…</ol>（style 可省）
- 任务清单 <tasks><task checked>已完成</task><task>未完成</task></tasks>
- 引用 <blockquote>…</blockquote>；分隔线 <hr/>；硬换行 <br/>（诗歌/地址等）
- 代码块 <pre lang="ts">代码</pre>（内文务必按"字符转义"处理）
- 表格 <table><tr><th>表头</th></tr><tr><td bg="rose">单元格</td></tr></table>（<th> 为表头单元格；整行全 <th> 即表头行；bg 为单元格底色，改写带色表格时原值照抄，别丢）
- 提示框 <callout emoji="💡" tone="info">提示内容</callout>（tone 只允许 info/success/warning/danger/neutral）
- 分栏 <columns><column ratio="0.5">块级内容</column><column ratio="0.5">块级内容</column></columns>（至少 2 个 <column>，每栏放块级标签）
- 块级公式 <math-block>E=mc^2</math-block>（LaTeX，不带 $；展示公式硬规则见下）
- 图表 <mermaid>flowchart TD
  A[开始] --> B[结束]</mermaid>（Mermaid 源码；源码内的 < 仍按"字符转义"写 &lt;；严禁用 <pre> 写 mermaid 冒充图表）
- 图片 <img src="/api/v1/files/<uuid>/<filename>" alt="…"/>；文件 <file id="…" filename="…"/>（两者都只用素材/原文已有的 id/url，绝不编造）

## 展示公式硬规则
多行公式、\\begin{align|aligned|equation|gather|gathered|cases|matrix|bmatrix|pmatrix|split|alignat...} 环境、带 & 对齐的公式、独立成行的公式，必须用 <math-block>…</math-block>。<math-block> 内文只放纯 LaTeX，不带 $/$$/\\[\\] 定界符；LaTeX 里的 & 必须写成 &amp;。绝不把这类公式写成普通 <p> 段落文本、裸 LaTeX 或 Markdown 代码块。

✅ 正确：多行 align 整体包进 <math-block>，并把 & 写成 &amp;：
<math-block>\\begin{align}
\\nabla \\cdot \\mathbf{E} &amp;= \\frac{\\rho}{\\varepsilon_0} \\\\
\\nabla \\times \\mathbf{B} &amp;= \\mu_0\\mathbf{J}+\\mu_0\\varepsilon_0\\frac{\\partial \\mathbf{E}}{\\partial t}
\\end{align}</math-block>

❌ 错误：把展示公式当段落正文吐出，不会渲染：
<p>\\begin{align} \\nabla \\cdot \\mathbf{E} &amp;= \\frac{\\rho}{\\varepsilon_0} \\\\ \\nabla \\times \\mathbf{B} &amp;= \\mu_0\\mathbf{J} \\end{align}</p>

边界与克制:
- 表格单元格、callout、blockquote 内只放文字与行内标记；列表、表格等块级内容放在它们外面。
- 结构服务内容：未被要求时默认朴素结构（标题+段落+必要列表）；表格/分栏/callout 只在明显更清楚时用，callout 整篇一般不超过 2-3 个；mermaid 仅在用户要求图示、或内容本身是明确的多步骤流程时使用，拿不准就不用。

## 列表与分栏结构
- 多级列表必须用 <li> 内嵌子 <ul>/<ol> 表达层级，例：<ul><li>一级<ul><li>二级<ul><li>三级</li></ul></li></ul></li></ul>。
- 用户要求"两级/三级/多级/嵌套列表/层级清单"时，必须真的嵌到对应层数；三级诉求必须出现第三层 <ul>。严禁把各级写成同级 <li>，严禁用 1.1、①、前导空格、缩进模拟层级。
- 任务清单同理用 <tasks> 内嵌子 <tasks> 表达多级。
- 分栏必须用 <columns>，至少 2 个 <column>，每栏放真实块级标签，不要把左右栏并成普通段落。

## 文档目录（TOC）
用户要求"加目录/生成目录/大纲导航"时：为每个被目录引用的标题加 anchor（slug：小写英文/数字/连字符，唯一），在开头输出一个 <ul>，每条目用 <a href="#anchor">章节名</a>，anchor 与标题一一对应。例：<ul><li><a href="#background">背景介绍</a></li></ul><h2 anchor="background">背景介绍</h2>。

## 结构保留
改写已有文档时，除非用户明确要求删除或改普通文本，必须保留原文的 table/blockquote/列表/tasks/callout/columns/math-block/mermaid/img/file/pennote 语义结构与 <td bg> 底色，不得降级为普通段落或 Markdown 管道文本；多级列表保留为 <li> 内嵌子列表；分栏保留为真实 <columns>。

## 行内标记
加粗 <b>、斜体 <i>、下划线 <u>、删除线 <s>、行内代码 <code>、超链接 <a href="…">文字</a>（href 必须 http(s)、以 / 或 # 开头）、高亮 <mark color="rose">文字</mark>、文字色 <color val="rose">文字</color>、行内公式 <math>E=mc^2</math>（内文 LaTeX，不与其他标记套用）。color/mark 颜色只允许：ink gray slate brown red orange amber yellow lime green sage mint teal cyan sky blue indigo violet purple magenta pink rose sand lavender（不确定就用 gray）。

## 检索来源引用（本文基于联网检索/抓取来源写成时必须遵守）
素材带有来源 url 时，正文引用来源的数据/观点必须做成可点击 <a href="真实URL">，不能只写纯文本来源名；文末"参考来源"列表每条也必须是 <a>。href 用素材里该来源的 url 原值，禁止编造域名。无检索来源的纯创作文体不受此约束。

## 最后确认
${confirmLead}${noAssets}现在直接输出 QingML，第一个字符必须是 <。是否插入图表/图片、参考来源如何呈现等未指定的可选细节，你都自己做合理默认（默认：不插图、参考来源在文末以链接列出），绝不反问。只有输入没给长度规格时才自行默认篇幅。严禁输出 Markdown（**加粗**→<b>、# 标题→<h2>、- 列表→<ul><li>，Markdown 语法与代码围栏一律禁止）或任何解释文字。`;
}

export function buildQingmlRetryUserPrompt(basePrompt: string, attempt: number, lastError: string): string {
  if (attempt <= 0) return basePrompt;
  return `${basePrompt}\n\n上一轮输出未通过 QingML 解析或校验，错误: ${lastError.slice(0, 500)}\n本次是第 ${attempt + 1} 次尝试：只输出完整、闭合的 QingML 标记。特别注意：<pre>/<math-block>/<mermaid> 内的 < 和 & 必须写成 &lt; / &amp;。不要输出 markdown fence、解释文字或半截标记。`;
}

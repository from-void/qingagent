# QingML 规格 v1（C0 实测定稿 · 2026-07-06）

> QingML = 模型输出文档内容的 HTML 子集标记。链路:模型文本 → `qingmlParse()`(htmlparser2 流式
> 白名单映射)→ 复用现有 `AiBlock[]`(pm-schema/src/ai-ir/aiIrSchema.ts)→ 下游 zod/坏块重试/PM 编译/
> blockId 铸造原样不动。**本文是 C1 解析器与 C2/C3 提示词的共同真相源。**
>
> **C0 实测定稿依据**(deepseek-v4-flash,240 轮生成 + 确定性 token):
> QingML 格式失败率≈0(vs JSON 三级嵌套挂 30%);结构保真 nest3 100%(vs JSON 70%);同文档 token
> QingML 总体 −19%(嵌套/表格 −33~41%、散文 −4%)。n≈290 QingML 输出仅 1 处越界标签(`<br>`)、
> §5 边界违规 0。v0 → v1 唯一改动:补 `<br>` 处理。

## 1. 文档外壳
`<title>可选标题</title>` → AiDocument.title(仅认首个);其余块级标签 → blocks[]。无根包裹。

## 2. 块级标签 → AiBlock（白名单;未列 = 未知,走 §6 降级）
| QingML | AiBlock | 属性/约束 |
|---|---|---|
| `<h1>`…`<h6>` | heading(level=数字) | `align` 可选;`anchor` 可选 |
| `<p>` | paragraph | `align` 可选 |
| `<ul><li>` | bulletList | `<li>` 内嵌 `<ul>/<ol>` → item.children |
| `<ol style><li>` | orderedList | `style` 可选 |
| `<tasks><task checked>` | taskList | `checked` 布尔;可嵌子 tasks/列表 → children |
| `<blockquote>` | blockquote | 行内 only |
| `<hr/>` | horizontalRule | 自闭合 |
| `<pre lang>` | codeBlock | 内文按 §4 转义(`&lt;`/`&amp;`),解析后实体还原 |
| `<table><tr><th>/<td>` | table | `<th>`=表头单元格;整行全 `<th>` ⇒ row.header=true;`bg` 可选;无 colspan/rowspan |
| `<callout emoji tone>` | callout | 行内 only;tone 枚举 |
| `<columns><column ratio>` | columnList | ≥2 `<column>`,column 内放块级 |
| `<mermaid>` | diagram(lang="mermaid") | Mermaid 源码，内文按 §4 转义 |
| `<drawio>` | diagram(lang="drawio") | 未压缩 mxGraphModel/mxfile XML，内文按 §4 转义 |
| `<math-block>` | blockMath | 内文=LaTeX,按 §4 转义(`&` 多按字面) |
| `<img src …/>` | image | src 必填过白名单,自闭合 |
| `<file id filename …/>` | fileAttachment | 自闭合 |
| `<pennote>` | penNote | 行内 |

## 3. 行内标签 → run marks
`<b>/<strong>`→bold、`<i>/<em>`→italic、`<u>`→underline、`<s>/<del>`→strike、`<code>`→code、
`<a href title?>`→link(href 限 http(s)/根相对/#)、`<mark color>`→highlight、`<color val>`→textColor、
`<math>LaTeX</math>`→math(整 run 转 inlineMath,不与他 mark 组合)。嵌套 marks 解析器归一。
**`<br>` / `<br/>`** → 当前 run 文本内的换行(soft break),不产生新块。

## 4. 转义与空白（评审修正:pre/math/mermaid/drawio 内文**也要转义**,非 rawtext）
仅 `&lt;`(<)、`&amp;`(&) 需转义;`&gt;`/引号/换行无需转义,裸 `&`(非实体名)容错按字面。
- **关键**:`<pre>`/`<math-block>`/`<mermaid>`/`<drawio>` 内文**同样只转义 `&lt;`/`&amp;`**,解析后 htmlparser2 自动
  实体还原为字面 `<`/`&`。**不得当 rawtext 原样写 `<`**——htmlparser2 不把这些自定义标签当 rawtext
  (只有 script/style/title/textarea 是),原样写会把 `#include <stdio.h>`、`std::vector<int>`、`() => {}`
  里的 `<…>` 当标签吃掉,静默产出残缺代码(不报错、不重试)。裸 `&`(如 LaTeX `a &= b`)因实体不匹配
  按字面安全保留,真正必须转义的只有 `<`。
- 块内空白 HTML 折叠归一;pre/math/mermaid 内文除实体还原外不折叠(保代码/公式格式)。

## 5. 表达力边界（AiBlock 装不下的不许表达；C0 实测 0 违规,保持硬约束）
- **table 单元格 `<td>/<th>` = 块级容器**(2026-07-11 表格改造 B2 起):内部直接放
  `<p>/<ul>/<ol>/<tasks>/<callout>` 等现有块;纯行内/裸文本 `<td>文字</td>` 兼容归一为单
  paragraph;空 cell 归一为空 paragraph。cell 属性:`bg`(主题色)、`colspan`/`rowspan`
  (正整数,B5 起全链路支持);colwidth 不进 QingML(系统 carry-over 保留,模型勿表达)。
- callout = 行内 only;blockquote/pennote = 行内 only。内部若出现块级 → 降级为行内文本 + warning。
- **行内 only 块里出现多个 `<p>`**(如 `<blockquote><p>a</p><p>b</p></blockquote>`,HTML 语料常见形态):
  各 `<p>` 内文合并进该块的 runs,段间以换行(`\n`)分隔;此为**无害归一,不算降级不 warning**。
- 允许块级子结构的:list item(children)、taskList item(children)、column(blocks)、
  **table cell(blocks)**。其余块不嵌块。

## 6. 容错与降级（评审:区分无害容错 vs 有害降级——后者升级为坏块重试,别静默产坏文档）
> 失败模式从 JSON 的"响亮"(parse error→重试)变成 QingML 的"静默"(fail-open→剥壳降级)是唯一系统性
> 回归类别。政策:无害 fail-open 静默容错;有害降级视同坏块走重试,warning 全量进遥测。

**无害 fail-open(静默容错)**:
- 前导话/fence 包裹/纯文本无标签 → 剥壳;纯文本 → 单 paragraph。
- `<br>`、未闭合/交错标签的自动闭合(htmlparser2 语义,快照锚死)。
- `<blockquote><p>×N` 归一(§5)。

**有害降级(视同坏块 → 走既有坏块重试链,warning 进遥测)**:
- 非白名单标签剥壳导致**结构丢失**(不是纯行内包裹);
- §5 块级边界降级(单元格/callout 里塞了块级被拍平);
- **`<pre>`/`<math-block>`/`<mermaid>`/`<drawio>` 出现子元素**——即模型没转义 `<` 把源码里的 `<tag>` 写成了真标签
  (检测:该元素 children 含 tag 节点),内文已被吃,判坏块重试(**这是 §4 违背的运行时兜底**)。

流式截断:半截 markup 剥标签出纯文本预览(C1 aiIrStreamPreview markup 版);定稿帧仍发编译后 PmDoc。

## 7. C0 实测验证结论（取代 v0「待校准」）
- 三级嵌套 `<li><ul>`:模型稳定产出,层级保真 100%(JSON 同场 70%)。✅
- 散文裸 `<`/`&`/引号:100% 解析(JSON 90%,挂裸控制字符)。✅
- 表格 `<th>/<td>`、callout+columns 混排:100% 保真,§5 边界 0 越界。✅
- 唯一观察到的越界:`<br>`(已在 §3 收编)。
- **C1 对抗集**:因模型自身几乎不产出畸形,对抗用例由**人工构造**(未闭合/交错/正文含`<&`/流式截断/
  纯文本/CJK 全角/连续空白/`<br>`/非白名单标签/`<pre>` 内含 `<stdio.h>` 等尖括号/`<blockquote><p>×N`/
  全 `<th>` 表头行),快照锚死 htmlparser2 行为。

## 8. editDraft 片段规则（评审新增;随 C1 定,防数组/单块/envelope 宽容归一在 QingML 形态复活）
editDraft 的 op 载荷是 QingML **片段**(非整篇),按 action 规定合法根标签;解析用同一 qingmlParse,
但按 action 取目标节点、**剥掉模型多包的容器**(裸 `<li>` 被写成 `<ul><li>…</ul>` 时剥外层 `<ul>`):

| action | 载荷合法根 | 剥壳规则 |
|---|---|---|
| replaceBlock / insertBlock | 一个或多个块级标签 | 有 `<title>`/多余包裹则剥,取块级序列 |
| replaceListItem / insertListItem | `<li>`(或裸行内→包成 li) | 模型写 `<ul><li>…</ul>` → 剥 `<ul>/<ol>` 取内层 `<li>` |
| insertTableRow | `<tr>` 或裸 `<td>/<th>` 序列 | 写 `<table><tr>…</table>` → 剥到 `<tr>` |
| insertTableColumn | `<td>/<th>` 序列(每行一格) | 同上剥到单元格序列 |
| replaceText / markText | 无结构载荷(find/replace 纯文本) | 不涉及 |

**硬约束**:片段解析只接受该 action 的合法根;越界(如给 replaceListItem 一个 `<table>`)→ 拒收报错,
**不做"数组/单块/envelope 宽容归一"那种兼容**(否则旧坑在 QingML 形态原样长回来)。

## 9. 纯文本脚注（MVP）

`<footnote id="source_1">来源说明</footnote>` 是行内引用原子，编译为
`AiFootnoteRun` → PM `footnoteReference`。`id` 必须稳定，且只允许
`A-Z`、`a-z`、`0-9`、`_`、`-`（1–64 字符）；正文是去除首尾空白后的纯文本，
不得嵌标签或 mark。同一文档中相同 `id` 可被多次引用，但 `note` 必须完全一致。
显示编号按该 `id` 在文档中的首次出现顺序计算，不把编号写死在模型输出或节点属性里。

示例：

```html
<p>这是第一处事实<footnote id="source_1">《资料甲》，第 12 页。</footnote>，
也是第二处事实<footnote id="source_2">《资料乙》，2026 年版。</footnote>。</p>
```

脚注是引用原子，不是作用于任意文字范围的视觉样式，因此不得用 `mark` 表达。解析器遇到
嵌套标签、截断脚注或同一 `id` 对应不同 `note` 时产生 warning/校验失败，不静默猜测正文。

### 9.1 导出语义与降级边界

| 格式 | 实际输出 |
|---|---|
| Markdown | 正文 `[^id]` 引用 + 文末 `[^id]: note` 定义 |
| HTML | `doc-noteref` 行内引用 + 文末 `doc-endnotes` 区及回链 |
| PDF | Chromium 打印上述 HTML，保留正文引用和**文末**语义脚注区 |
| DOCX | `FootnoteReferenceRun` + `Document.footnotes`，生成 Word 原生页底脚注 |
| TXT | 正文 `[n]` 引用 + 文末“脚注”区 |

**PDF 不承诺每页页底脚注。** 当前 PDF 使用 Chromium 打印 HTML；要实现随分页重排的页底
脚注需要更换或扩展分页排版引擎，不属于本 MVP。HTML/PDF 的诚实语义是文末注释及回链，
不能在产品说明或验收中称为 Word 式分页脚注。

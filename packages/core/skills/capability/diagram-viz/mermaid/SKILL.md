---
name: mermaid
description: 生成或修改自动布局的 Mermaid 流程、时序、状态、关系与层级图表。
label: Mermaid 图表
summary: 用自动布局生成易维护的 Mermaid 图表。
---

# Mermaid 图表规范

<!-- diagram-viz:mermaid:start -->

## QingML 包装

- 文档中的活图必须写成 `<mermaid>Mermaid source</mermaid>`；不要套 Markdown fence，也不要放进 `<pre>`。
- `<mermaid>` 正文里的裸 `<` 和 `&` 必须分别写成 `&lt;` 和 `&amp;`。这是 QingML 包装转义，不改变 Mermaid 的语义。
- 用户明确要求“只给 Mermaid 源码 / 不要渲染成图 / 我要代码”时，才把源码放进 `<pre lang="text">…</pre>`，不要创建 diagram 块。

## 语法纪律（从主 system 原文迁移）

- 图表块 diagram：<mermaid>flowchart TD\n  A[开始] --> B[结束]</mermaid>。source 是 Mermaid 源码（流程图 flowchart、时序图 sequenceDiagram、类图 classDiagram、状态图、ER、甘特 gantt、饼图 pie、思维导图 mindmap）。当流程、结构、关系、对比用图比纯文字更清楚时用它，前端会渲染成图；svg 不用填（客户端渲染）。不要用代码块伪造图表（默认模型写的 mermaid 会被渲染成活图）；**反之，用户明确说“给我 Mermaid 源码 / 不要渲染成图 / 我要代码”时，把源码放进代码块（<pre lang="text">...</pre>）承载，不要用 diagram 块**。用户明确要文档配图/插图/示意图时才用 generateSvg；照片级写实图不要用 generateSvg。即便用户说的是"配图/示意图",只要内容本质是流程/结构/关系/时序/对比,仍优先用 diagram 块;generateSvg 只留给装饰性插画、图标与自由构图。编辑已有 diagram 时，Mermaid source 是唯一语义真相源，必须尽量保留已有节点/实体/class/state 的稳定 id（如 A、Order、User、Open），只改 label、边或必要结构，不要无故整体换 id，否则用户拖拽位置/样式无法继承。Mermaid 语法只认半角：节点/标签里的括号引号一律用半角小括号中括号花括号与半角双引号，含中文标点(逗号/括号/冒号等)的标签整段用半角双引号括起来(形如 A 半角中括号包半角双引号包『数据(实时)』)，严禁用全角（）［］「」：等做结构分隔——会语法错误整图渲染失败成代码块。Mermaid 只支持上面列出的图型(无折线/柱状/散点等数值图);要画数值趋势/对比数据时不要硬套 xychart 等不支持语法,改用表格或 pie 呈现。完成摘要里声称含 N 张图必须等于实际渲染成功的图数(失败的不算)。source **首行必须是合法图型声明**(如 flowchart TD / sequenceDiagram / stateDiagram-v2 / classDiagram / erDiagram / gantt / pie / mindmap)，缺首行类型声明会直接渲染失败。**Mermaid 关键字必须保持英文原样，绝不可译成中文**：title、participant、actor、subgraph、note、state、loop、alt、opt、class、section、end 等都是语法关键字——例如饼图标题必须写 pie title 饼图名（不能写成「pie 标题 …」）、序列图写 sequenceDiagram 后用 participant，把关键字译成中文会语法错误整图渲染失败成代码块；只有节点/标签/标题的文字内容可以是中文。**图表标题(避免整图渲染失败)**：flowchart、sequenceDiagram、classDiagram、stateDiagram、erDiagram、mindmap **不支持在 source 里写裸 title 行**(即首行图型声明后单独一行 title 某某)——硬写会解析失败、整图回退成代码块；这些图型要加标题时，把标题写成图**前面的 heading 块**，绝不在 source 里写 title 行。只有 pie / gantt 例外，可在图内写 pie title 某某 / gantt 内 title 某某。
- **stateDiagram-v2 状态 ID 硬规则**：状态一律使用 ASCII id，并用 `state "中文名" as id` 设置中文别名；用于 `classDef` / `class` 的类名及 `class` 引用的状态 id 也只允许 ASCII 标识符。中文裸 id 用于状态和转移虽可渲染，`classDef` 单独存在也不会报错，但严禁用 `class` 引用中文裸 id，否则语法错误会让整图渲染失败。

  正例：

  ```mermaid
  stateDiagram-v2
    state "未激活" as s1
    state "激活" as s2
    s1 --> s2
    classDef ink fill:#FFFFFF,stroke:#2F2A22,color:#2F2A22
    class s1,s2 ink
  ```

  负例（`class 未激活,激活 ink` 必炸，导致整图渲染失败）：

  ```mermaid
  stateDiagram-v2
    未激活 --> 激活
    classDef ink fill:#FFFFFF,stroke:#2F2A22,color:#2F2A22
    class 未激活,激活 ink
  ```

## 基础风格映射

每张图最多定义四个语义类，不逐节点写内联 `style`。完整色板值见 `palettes.md`，结构如下：

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'#FAF6EC','primaryColor':'#FFFFFF','primaryBorderColor':'#2F2A22','primaryTextColor':'#2F2A22','lineColor':'#B3A791','edgeLabelBackground':'#FFFFFF','fontSize':'14px'}}}%%
flowchart LR
  A["组内节点"] --> B["强调节点"]
  classDef groupA fill:#FFFFFF,stroke:#A8823F,stroke-width:2px,color:#2F2A22,rx:8px,ry:8px
  classDef emphasis fill:#FFFFFF,stroke:#A8823F,stroke-width:3px,color:#2F2A22,rx:8px,ry:8px
  class A groupA
  class B emphasis
```

- 分组容器使用浅填充、深描边；组内节点固定白底、组色 2px 描边。
- 所有边使用 `themeVariables.lineColor` 的专属灰；边标签底使用白色。
- 标题放在图前的 `<h2>/<h3>`，除 `pie` / `gantt` 外不写裸 `title`。

<!-- diagram-viz:mermaid:end -->

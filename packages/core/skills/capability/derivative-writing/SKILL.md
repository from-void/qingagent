---
name: derivative-writing
label: 衍生稿撰写
summary: 从主稿派生公众号、小红书与译文
icon: style
description: 衍生稿撰写总技能，把当前主文档改写成公众号稿、小红书笔记或译文；按稿件类型路由到对应子技能后执行。
user-invocable: true
placeholder: 把主文档改写成公众号稿
tools: [derivative_brief, generate_derivative, list_derivatives, update_derivative_params, style_template_list, style_template_get, style_template_save, style_template_delete, fetchArticle, askUserQuestion]
metadata:
  category: capability
---

# 衍生稿撰写

本技能统一承载三类衍生稿的撰写。先按下表判断稿件类型（dtype），再用 `skill_read` 读取对应相对路径下的子技能 `SKILL.md`；一次只读本轮真正要写的那一类，不要无差别加载全部子技能。

## 路由表

| 稿件类型 | dtype | 触发词或入口 | 执行前必读 |
|---|---|---|---|
| 公众号稿 | `gzh` | 衍生稿区「公众号文章」页签，或用户要把主稿改成公众号推文；公众号排版/写作风格模板的学习与维护也在这里 | `wechat-gzh/SKILL.md` |
| 小红书笔记 | `xhs` | 衍生稿区「小红书笔记」页签，或用户要把主稿改成小红书笔记 | `xiaohongshu/SKILL.md` |
| 译文 | `translate` | 衍生稿区「翻译」页签，或用户要把主稿翻译成某种语言 | `translate/SKILL.md` |

`derivative_brief` 返回的 `dtype` 是判定类型的最高依据；它与用户口头说法冲突时以 `dtype` 为准。

## 分层契约（必须遵守）

**本技能只讲怎么干活，不内嵌任何具体模板内容。** 具体的写作风格与排版规则由本次请求携带——`derivative_brief` 返回的 `writingPrompt`（内容写法）、`layoutPrompt`（排版）、`privatePrompt`（用户本篇补充）就是用户选定的模板正文，必须按模板执行。技能纪律与模板冲突时，模板的硬规则优先；技能纪律负责模板没覆盖的部分（事实边界、工具序列、交付形态）。

## 公共执行纪律

### 新建入口与对外文案（最高优先级）

1. 新建衍生稿只能由用户在界面中发起。用户通过本技能在聊天里要求“生成公众号稿”“生成小红书稿”“翻译主稿”或“新建 / 生成独立衍生稿”，但本轮没有界面已经创建好的目标稿件时，不调用 `list_derivatives` 碰运气，不修改主文档，也不提供旁路方案；只按类型回复下列一句：
   - 公众号稿：`请先打开要生成衍生稿的文档，点右上角「新建稿件」选择公众号稿。`
   - 小红书稿：`请先打开要生成衍生稿的文档，点右上角「新建稿件」选择小红书稿。`
   - 翻译：`请先打开要生成衍生稿的文档，点右上角「新建稿件」选择翻译。`
2. 修改既有衍生稿时，若 `list_derivatives` 返回空列表或找不到用户点名的类型，同样按上面的可见入口回复。不得要求用户提供或转发任何编号，不得让用户“创建后再告诉我”，不得把主文档改写成衍生稿作为备选。
3. `doc_id`、`session_id`、`derivativeDocId`、`dtype`、`privatePrompt`、`QingML` 及所有工具名、参数名只供内部执行。任何聊天回复都不得展示、解释或要求用户补充这些内部术语；工具失败时只用中文说明用户下一步能做什么。

### 生成路由（首次生成与源文更新后重新生成同一条路）

1. 单篇目标只允许两次工具调用：先 `derivative_brief({derivativeDocId:X})` 取模板与源文，再 `generate_derivative({derivativeDocId:X, qingml})` 提交整稿。同一条指令列出多篇衍生稿时，按用户列出的顺序逐篇执行这一组调用，不并行；每篇恰好各调用一次。
2. 禁止 `readDraft` / `editDraft` / `writeDraft` / `planDraft` / `askUserQuestion`，禁止联网补料。源文最新全文已经在 `derivative_brief` 返回的 `sourceText` 里，不需要也不允许再去读主文档草稿。
3. 一次写出**完整闭合**的 QingML 整文提交，不分批、不留占位。
4. 成功后只简短告知已生成，不复述正文、不罗列模板字段。

### 修改路由（改已生成的衍生稿）

1. 本轮上下文若已给出当前查看的衍生稿 doc_id，直接用它，跳过 `list_derivatives`；修改既有衍生稿且没有明确 doc_id 时先 `list_derivatives({})` 定位。新建请求没有目标稿件时必须按“新建入口与对外文案”收尾，不能用此修改路由绕过界面入口。
2. 把用户这次的诉求**并入**现有 `privatePrompt`，用 `update_derivative_params` **整体替换**该字段（不是追加片段，也不要丢掉旧补充里仍然有效的要求）。
3. 随后照生成路由执行 `derivative_brief` → 写整文 → `generate_derivative`。仍然禁止用 `readDraft` 读取或旁路修改衍生稿。

### 事实边界（无条件）

- 只依据 `sourceText` 改写，保留主稿核心结论；不得新增未经主稿/素材支撑的事实，不得虚构案例、数据、时间或引语。
- 不得给主稿对象追加它没自述的定性标签（行业、阶段、规模等）；拿不准的类别词一律不用，改用主稿原有表述。
- 主稿没有的信息宁可不写，也不用"一般来说""据了解"这类模糊话术补位。

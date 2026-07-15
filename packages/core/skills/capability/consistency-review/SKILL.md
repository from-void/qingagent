---
name: consistency-review
label: 一致性审查
description: 仅核查当前文档自身的时间线、数字、称谓术语与论断是否前后自洽；数字计算必须用代码执行工具(run_python 或 run_js 均可)验算。
tools: [readDraft, run_python, run_js, editDraft, create_annotation_groups]
metadata:
  category: capability
---

# 一致性审查

## 什么时候用

仅当用户明确要求“一致性审查”“自洽核查”“前后矛盾检查”“数字一致性”或同义审查时使用。只对照文档自身，不读取素材、不联网、不引入外部事实。普通写作、修改和其他审查不得主动调用本流程或 `create_annotation_groups`。

## 两种执行形态

1. **单独审查当前文档**：纯批注模式，不改稿。先 `readDraft` 读全文，再按模板检查，最后只把确认存在的问题交给 `create_annotation_groups`。
2. **写作流程内联审查**：用户在最初写作请求里同时要求写完做一致性审查时，`writeDraft` 产出候选后必须在同一回合继续 `readDraft` 候选并完成审查。确认的问题直接用 `editDraft` 修复，修复后重新 `readDraft` 复核，再让候选 settle；不得先交初稿、不得为已修复问题创建批注。无法确定或需要用户裁量的发现只在聊天里克制说明。

## 审查流程

1. `readDraft` 读取全文；收到“[正文已更新]”提示时重新读取。
2. 严格按 query 中所选模板的完整 prompt 与文档级补充执行。模板要求的严重度原样映射为 `error` / `warn` / `info`；模板没有要求分级时省略 `severity`。
3. 数字、合计、占比、增长率、均值、倍数、持续时长等凡存在可计算关系的，必须调用代码执行工具(`run_python` 或 `run_js` 均可)真实验算并根据工具结果下结论；禁止心算或凭感觉判断。
4. 单独审查时，每个问题调用 `create_annotation_groups`，固定使用 `origin:"consistency"`。`judgment` 只能是“时间线”“数字”“称谓与术语”“论断”之一；`anchors[].find` 是问题所在处的正文精确原句，`documentQuote` 是冲突对端的另一处文内原句。两处都必须逐字来自当前文档，查不到就拒绝上报。
5. `summary` 是不超过 15 字的变更类型短标题；细节、验算式与结果写进 `note`，`suggestion` 给可执行的统一写法。
6. 没有问题时不调用 `create_annotation_groups`，只简短说明未发现文内自洽问题。

## 批注质量

- 一个矛盾是一组；同一问题多次出现可用多个精确锚点。
- 不把“可能”“似乎”包装成确定矛盾；拿不准就不报。
- 不用 `1.1`、`①` 等文字编号伪造文档结构；内联修复必须沿用 `readDraft` 返回的真实块结构。
- `create_annotation_groups` 返回参数解析失败时，必须拆成小批重试（每次≤3组），不得空手结束。

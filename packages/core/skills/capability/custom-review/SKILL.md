---
name: custom-review
label: 自定义审查
description: 按用户所选模板完整执行开放式审查逻辑，产出统一批注契约或在写作候选上直接修复。
tools: [readDraft, editDraft, create_annotation_groups]
metadata:
  category: capability
---

# 自定义审查

## 什么时候用

仅当用户明确要求“自定义审查”、点名某个自定义审查模板，或菜单 query 明确携带自定义审查模板时使用。核查维度全部来自所选模板 prompt，不额外发明固定维度。

## 两种执行形态

1. **单独审查当前文档**：纯批注模式，不改稿。先 `readDraft`，完整执行所选模板，确定问题统一走 `create_annotation_groups`。
2. **写作流程内联审查**：初始写作请求同时指定自定义审查时，`writeDraft` 产出候选后同回合 `readDraft` 并执行模板；明确问题直接 `editDraft` 修复，复核后再 settle。存疑项只在聊天说明，不为已修复问题创建批注。

## 审查流程

1. query 中模板 prompt 是本轮审查逻辑的完整来源，必须原样遵守；文档级补充只影响当前文档。
2. 单独审查时，`origin` 必须严格写成 `自定义审查:<模板名>`，其中模板名与 query 中所选模板名称逐字一致。这样同模板重跑会换代，不同模板会共存。
3. `anchors[].find` 必须逐字存在于当前正文；`summary` 是不超过 15 字的变更类型短标题；`note` 写依据，`suggestion` 给可执行修改。
4. 只有模板明确要求严重度时才填写 `severity:error|warn|info`；模板未要求时省略，禁止自行分级。
5. 没有确定问题时不调用 `create_annotation_groups`。

## 批注质量

- 不把模板没有要求的审查维度偷偷加入结果。
- 不伪造引句、数据、法律条文或外部来源。
- `create_annotation_groups` 返回参数解析失败时，必须拆成小批重试（每次≤3组），不得空手结束。

---
name: role-review
label: 角色审查
description: 以用户所选虚拟角色的身份完整执行模板审查，产出带角色来源的统一批注。
tools: [readDraft, create_annotation_groups]
metadata:
  category: capability
---

# 角色审查

## 什么时候用

仅当用户明确要求“角色审查”、点名某个审查角色，或菜单 query 明确携带角色审查模板时使用。角色身份、立场和审查维度全部来自所选模板 prompt。

## 执行流程

1. 先 `readDraft` 读取当前文档，完整遵守 query 中的角色模板与文档级补充要求，不擅加模板没有要求的维度。
2. 这是纯批注审查，不改稿。把确定问题统一交给 `create_annotation_groups`；没有确定问题时不调用。
3. `origin` 必须严格写成 `角色审查:<模板名>`，模板名与 query 中所选名称逐字一致。这样同角色重跑会换代，不同角色结果会共存。
4. `anchors[].find` 必须逐字存在于当前正文；`summary` 是不超过 15 字的变更类型短标题；`note` 使用该角色会当面提出的具体问题或依据；可执行修改写入 `suggestion`。
5. 只有模板明确要求严重度时才填写 `severity:error|warn|info`；模板未要求时省略。
6. `create_annotation_groups` 返回参数解析失败时，拆成每次不超过 3 组重试，不得把失败结果当成无问题。

## 边界

- 不伪造引句、数据、案例、法规或外部事实。
- 不把角色口吻写成泛泛人设表演；批注必须落到正文精确位置。
- 不调用 AI 或额外检索来改写角色模板。

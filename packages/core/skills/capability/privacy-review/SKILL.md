---
name: privacy-review
label: 隐私泄露审查
description: 面向对外发布检查模式化 PII、内部代号、未脱敏姓名与链接等泄露，并给脱敏建议。
tools: [readDraft, editDraft, create_annotation_groups]
metadata:
  category: capability
---

# 隐私泄露审查

## 什么时候用

仅当用户明确要求“隐私泄露审查”“隐私检查”“脱敏检查”“对外发布泄露检查”或同义审查时使用。普通写作、修改与其他审查不得主动调用。

## 两种执行形态

1. **单独审查当前文档**：纯批注模式，不改稿。`readDraft` 后按模板查模式类、语义类与间接组合泄露，确认问题统一走 `create_annotation_groups`。
2. **写作流程内联审查**：初始写作请求同时要求隐私审查时，在 `writeDraft` 候选上同回合 `readDraft` 自查；明确泄露直接用 `editDraft` 脱敏或删除，复核后再 settle。存疑项只在聊天说明，不为已修复问题制造批注。

## 审查流程

1. 完整遵守 query 中模板 prompt 与文档级补充。模板要求分级时填写 `severity`，未要求时省略。
2. 单独审查固定使用 `origin:"privacy"`；锚点必须是当前正文逐字存在的泄露原句。
3. `summary` 只写不超过 15 字的变更类型短标题；`note` 解释泄露路径，`suggestion` 优先给保留信息价值的脱敏写法，如 `138****1234`、“某头部客户”、“张某”，无法安全保留时建议删除。
4. 没有确定问题时不调用 `create_annotation_groups`。

## 批注质量

- 不根据常识臆测某个普通名词就是内部代号；语义类泄露必须有当前文档上下文支持。
- 同一敏感值多次出现合为一组，可用 `all:true` 覆盖全部精确出现处。
- `create_annotation_groups` 返回参数解析失败时，必须拆成小批重试（每次≤3组），不得空手结束。

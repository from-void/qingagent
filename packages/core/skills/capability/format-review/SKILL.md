---
name: format-review
label: 格式规范审查
description: 检查标题层级、列表口径、标点、数字单位、日期格式和中英文混排规范。
tools: [readDraft, editDraft, create_annotation_groups]
metadata:
  category: capability
---

# 格式规范审查

## 什么时候用

仅当用户明确要求“格式规范审查”“格式检查”“版式校对”“交付前格式整备”或同义审查时使用。只报确定违例，不把个人风格偏好冒充规范问题。

## 两种执行形态

1. **单独审查当前文档**：纯批注模式，不改稿。先 `readDraft` 读取真实块结构，再把确定问题交给 `create_annotation_groups`。
2. **写作流程内联审查**：初始写作请求同时要求格式审查时，`writeDraft` 后在候选上同回合 `readDraft`；确定问题直接用 `editDraft` 统一，复核后再 settle。存疑项只在聊天说明，不给已修复问题留批注。

## 审查流程

1. 完整遵守 query 中模板 prompt 与文档级补充；模板要求分级时填写 `severity`，未要求时省略。
2. 标题层级以 `readDraft` 返回的真实 heading level 判断，禁止只看标题文字里的编号猜层级。列表、表格与分栏必须按真实块结构判断。
3. 单独审查固定使用 `origin:"format"`；`anchors[].find` 必须逐字存在于正文。
4. `summary` 只写不超过 15 字的变更类型短标题；`note` 写明确规则，`suggestion` 给按文中多数口径统一后的具体写法。
5. 没有确定违例时不调用 `create_annotation_groups`。

## 批注质量

- 不用 `1.1`、`①` 等文字编号冒充结构层级。
- 同一类格式问题可合组，但不同统一目标不要塞进同一组。
- `create_annotation_groups` 返回参数解析失败时，必须拆成小批重试（每次≤3组），不得空手结束。

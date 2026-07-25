# 敏感词审查

## 什么时候用

用户要求敏感词、违禁词、极限词审查，或要管理审查词库时使用。

## 审查流程

1. 用户未指明词库时，先调用 `lexicon_list`，在聊天中列出词库并请用户确认；query 已带词库 id 时直接进入扫描。
2. 调用 `sensitive_scan` 扫描当前会话文档。禁止不扫描就凭空猜词。
3. `sensitive_scan` 的 `reviewAction` 是确定性处置结果，逐条处理全部 `hits`，不得遗漏：
   - `reviewAction:"replace"`：先 `readDraft` 定位，再用 `editDraft.replaceText` 按词库 `replacement` 逐处最小替换并复核。这是单独审查纯批注纪律的唯一替换例外。
   - `reviewAction:"annotate"`：逐个 hit 调用 `create_annotation_groups`；`anchors[].find` 就填命中原词，多处相同命中可设 `all:true`，保证最终引句等于命中原文；`note` 写词库 note、命中上下文与人工确认点。按模板要求，拿不准风险时降为 `severity:"info"` 也必须呈现，禁止因“语境合理”“属于专有名词/引用”等理由自行豁免或只写进聊天。
4. 单独审查与写作流程内联都遵守上述分流：有替换规则的直接最小替换，仅标记项产批注。已经替换并复核通过的问题不再重复产批注。
5. 扫描零命中时明确说审查通过，禁止编造命中。
6. query 中的审查模板与文档级补充必须完整遵守；不得用默认流程覆盖其“先确认”“仅标记”等要求。

## 词库管理

用户说建库、加词、改词、删词或删库时调用 `lexicon_manage`。创建用 `action:create`；添加用 `action:add`；更新 replacement/note 用 `action:update`；删除词条用 `action:remove`；删除用户词库用 `action:delete_resource`（内置种子库拒删）。

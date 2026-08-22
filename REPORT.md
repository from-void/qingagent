# strReplace 相邻误删 v2 修复报告（0822-r8）

## 根因一句话

外部读接口已把 `documents` 当作 canonical 权威源，但 external proposal 仍只使用热 `session.doc`，且既不校验同版本内容 hash、又在异步操作后才建立审阅 base，因而连续 `commit → 立即提案` 时同版本的陈旧 doc 引用可被当成候选基线并吞入相邻正文删除。

## 触发条件与白盒结论

- 严格按现场 12 次工具调用中的首稿、两次失败替换、两次段落交换和前五次小改执行，并在每次有效提案后调用 external `/review/commit`，普通串行调度在当前基线上不稳定触发竞态。
- 回归测试因此把竞态窗口确定性压缩为：`documents` 已保存完整 canonical，热 `session.doc` 却保留同一 `docVersion` 的截断末段；此时 external `GET /doc?format=pm` 仍返回完整长句，而紧随其后的目标 `strReplace` 在修复前稳定生成只剩“下周末，还来吗？”的错误候选。
- `findLiteralMatches` 的 `pmFrom` 与 `replaceTextRuns` 使用同一块的 `textStart`，在同一份文档上会还原为正确段内偏移；纯函数重放不能把匹配范围扩大到相邻文本，故问题不在 literal 匹配或 PM 坐标。
- 热恢复原有 `reconcileCachedSessionDocFromDb` 只处理 `documents.docVersion > session.docVersion`，没有处理“版本相同、内容 hash 不同”；同时 proposal 先计算 `workingDoc`，经过 `await` 后才由当时的 `session.doc` 建立 base，存在 base/candidate 跨 canonical 换代的第二个分裂点。

## 改动清单

- `packages/server/src/gateway/restoreFrames.ts`
  - canonical 对齐条件扩展为“DB 版本更高，或同版本内容 hash 分叉”。
  - 对齐时统一调用 `invalidateDraftStateAfterCanonicalWrite`，同步清除 review/draft 并推进 draft mutation revision。
- `packages/server/src/gateway/docWriteCommands.ts`
  - external proposal 入口先与 `documents` 权威正文对齐，并持久化修正后的 session metadata。
  - 在进入异步 proposal 操作前同步建立并复制 base/candidate；操作失败时清掉候选壳，避免 base 与 working doc 来自不同 canonical 时刻。
- 回归测试
  - 新增现场 12 次调用的原始参数 fixture（字符串与字段值逐字一致，仅归一 JSON 缩进）。
  - 新增 external API 全序列重放：严格执行“提案 → 读取审阅 → commit → 下一提案”，并在第 10 次目标 edit 前注入可控的同版本热缓存撕裂。
  - 断言 canonical、候选和 render-model editedDoc 均保留完整相邻正文，且不再出现现场两条扩大删除 preview。

## 测试结果

所有数据库均通过 `DATABASE_URL=file:/tmp/...` 显式放在 `/tmp`。

- 修复前目标回归：稳定失败；候选末段由完整长句坍缩为“下周末，还来吗？”。
- 修复后目标回归：1 passed。
- `externalRoutesPropose.test.ts` + `externalReview.test.ts`：47 passed。
- `bridgeHandlerRestore.heavy.test.ts`：19 passed。
- `@qingagent/core` 全量：262 files passed、1 skipped；3077 tests passed、7 skipped。
- `@qingagent/core typecheck`：通过。
- `@qingagent/server typecheck`：通过。
- `git diff --check`：通过。

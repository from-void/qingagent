# strReplace 段内前缀误删修复报告

## 根因一句话

审阅结算在发出 `docCommitted` 后才清理 draft scratch，而新 external 提案又无条件优先使用非空的 `docDraftCandidateDoc`，因此一旦会话已回到 `editing` 但仍残留旧候选，正确的 `strReplace` 会在旧候选上执行，并把旧候选中已有的段内前缀删除一并带入新一轮 diff。

## 白盒结论与复现条件

- `toQuoteMatch` 生成的 `pmFrom = block.textStart + startOffset`，`replaceTextRuns` 再减去同一 `block.textStart`；在同一候选块内两者会还原为 `startOffset`，现场误删不是 run、`hardBreak` 或 PM 全局坐标本身算错。
- 确定性触发条件是：canonical 正文仍含“复盘会……”前缀，会话已无 suggestion、对外呈现 `editing`，但内存中还残留一份不含该前缀且仍含目标旧句的 `docDraftCandidateDoc`。
- 修复前下一次 `strReplace` 会命中旧候选中的目标句，`affectedCount` 仍为 1；随后 canonical→candidate diff 同时产生 1 个前缀 delete 与 4 个目标句字符级 hunk，稳定复现现场 5 hunks。
- 修复前新增回归测试稳定失败：响应日志为 `review hunks=5`，候选正文只剩新句；修复后为 `review hunks=4`，前缀与新句均完整保留。

## 改动清单

- `packages/core/src/doc-engine/reviewCommit.ts`
  - 完整结算时先清持久化 draft、内存 base/candidate 和旧 stream lock，再发出 `docCommitted`，使该帧真正代表结算状态已完整收口。
- `packages/server/src/gateway/docWriteCommands.ts`
  - 非 pending-review 的新 external 提案发现残留 draft scratch 时先使其失效。
  - 新提案始终从 canonical 正文副本起算，不再继承无 suggestion 的旧候选。
- 回归测试
  - `externalRoutesPropose.test.ts`：固化“canonical 有前缀、editing 状态残留删前缀候选、随后 strReplace”的 5→4 hunk 回归。
  - `candidate-diff-flow.test.ts`：断言 `docCommitted` 帧可见前，内存候选与持久化 draft 已清除。

## 测试结果

修复后的完整测试均将数据库显式指向 `/tmp`。

- `textEditOps.test.ts`：26 passed
- `candidate-diff-flow.test.ts`：22 passed
- `reviewCommitSkippedHunk.test.ts`：9 passed
- `contentEditCommitWiring.test.ts`：11 passed
- `externalRoutesPropose.test.ts`：31 passed
- `externalReview.test.ts`：15 passed
- `@qingagent/core typecheck`：通过
- `@qingagent/server typecheck`：通过
- `git diff --check`：通过

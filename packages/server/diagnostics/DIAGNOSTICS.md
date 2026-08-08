# Qingagent 后端排障速查 (Diagnostics Cheat Sheet)

秒级 triage：导出任意会话完整状态 + 抓取持久化日志中的关键诊断行。
脚本位于 `packages/server/diagnostics/`。

> 注意：仓库根 `.gitignore` 第 38 行 `scripts` 会忽略**任意路径下**的 `scripts/`
> 目录（已验证 `git check-ignore packages/server/scripts/...` 命中）。因此诊断
> 脚本放在 `packages/server/diagnostics/` 下 —— 该路径不被忽略，可正常提交。

## 3 行速查

1. **Dump 一个会话的完整状态**（docState / PM 文档全文 / 每个候选建议的完整 before·after，复用 app 自带 `loadSessionFromThread` 解码 msgpackr，绝不手解二进制）：
   `cd packages/server && npx tsx diagnostics/dump-session.mts <sessionId>`  ·  也支持 `--latest` / `--title "<子串>"`  ·  输出同时落到 `/tmp/session-dump-<id>.txt`
2. **抓取/过滤日志诊断行**（validatePatch SUCCESS/FAIL/RECOVERED、PATCH REGISTERED/REJECTED、ENTERING REVIEW、generateDoc、draftingFailed、请先完成、docStateChanged、ECONNRESET、tool_choice）：
   `cd packages/server && diagnostics/tail-logs.sh [sessionId] [-f]`  （`-f` 实时跟随，`sessionId` 只看该会话）
3. **持久化日志位置**：`/tmp/qingagent-current.log`（始终在此，跨 loop 轮次不被覆盖）。规范启动命令：
   `PORT=8080 NODE_OPTIONS='--use-env-proxy' pnpm --filter @qingagent/server dev 2>&1 | tee -a /tmp/qingagent-current.log`

---

## dump-session.mts 打印内容

- thread id / title / docState / docVersion / runId / toolCallId
- suggestions (ids、blockIndex、blockId、summary) / patchVerdicts（review 周期结束并提交后这两个 Map 通常为空，before/after 可从 chatHistory body 或 suggestions preview 取）
- doc：PM block index、type、**完整文本**
- chatHistory 每个 toolCall：name、status（committed/done/…）；对 `docSuggestion` 额外打印 blockIndex、blockId、summary、**完整 before / 完整 after**、result，并标注 source（`chatHistory.body` 或 `suggestions`）
- 末尾再单列 suggestions 的完整 before/after（即便未出现在 chatHistory 也能看到）
- 健壮性：候选建议的历史 body 可能多层嵌套，脚本沿 `.data` 下钻直到找到 before/after；文档正文统一通过 PM 纯文本投影打印。

## 为什么需要这套工具

- 服务器日志（`/tmp/*server*.log`、`/tmp/loop-*-server.log`）会被 loop 轮次轮转/覆盖 → 用固定的 `/tmp/qingagent-current.log` + `tee -a` 持久化。`tail-logs.sh` 找不到约定日志时会回退到最近的 `/tmp/*server*.log`。
- `thread.metadata` 是 msgpackr 二进制 blob，手工用 python/独立 node 解码屡屡失败 → 复用 app 自己的 `@qingagent/core` `loadSessionFromThread`（底层 `LibSQLStore` + `Memory.getThreadById`）自动解码，与生产代码路径一致。

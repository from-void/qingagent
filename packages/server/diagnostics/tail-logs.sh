#!/usr/bin/env bash
#
# tail-logs.sh — 从持久化服务器日志中过滤最相关的排障行，秒级定位问题。
#
# ─── 持久化日志约定 ─────────────────────────────────────────────────────────
# 服务器日志（旧的 /tmp/*server*.log、/tmp/loop-*-server.log）会被 loop 轮次
# 覆盖/轮转，导致排障时找不到历史。所以我们约定：始终把 stdout+stderr 追加到
# 一个固定路径：/tmp/qingagent-current.log
#
# 规范启动命令（请始终用它启动 dev server，确保 dump/tail 知道去哪里找日志）：
#
#   PORT=8080 NODE_OPTIONS='--use-env-proxy' \
#     pnpm --filter @qingagent/server dev 2>&1 | tee -a /tmp/qingagent-current.log
#
# 说明：
#   - `2>&1` 把 stderr 合并进 stdout，崩溃栈也会进日志。
#   - `tee -a` 追加而非覆盖，跨 loop 轮次保留历史；同时仍在终端可见。
#   - 想每轮重置就把 `tee -a` 换成 `tee`（覆盖）。无论哪种，dump/tail 永远
#     只看 /tmp/qingagent-current.log 这一个文件。
#   - 可用环境变量 QINGAGENT_LOG 覆盖默认日志路径。
# ────────────────────────────────────────────────────────────────────────────
#
# 用法:
#   diagnostics/tail-logs.sh                 # 过滤并打印全部诊断行
#   diagnostics/tail-logs.sh <sessionId>     # 只看某个 session 相关的行
#   diagnostics/tail-logs.sh -f              # 实时跟随 (follow)
#   diagnostics/tail-logs.sh -f <sessionId>  # 实时跟随 + 过滤 session
#
set -euo pipefail

LOG="${QINGAGENT_LOG:-/tmp/qingagent-current.log}"

# 最相关的诊断关键字（大小写不敏感，扩展正则）
PATTERN='validatePatch (SUCCESS|FAIL|RECOVERED)|PATCH (REGISTERED|REJECTED)|ENTERING REVIEW|generateDoc|draftingFailed|请先完成|docStateChanged|ECONNRESET|tool_choice'

FOLLOW=0
SESSION=""
for arg in "$@"; do
  case "$arg" in
    -f|--follow) FOLLOW=1 ;;
    *) SESSION="$arg" ;;
  esac
done

# 找不到约定日志时，回退到最近修改的 /tmp/*server*.log，避免完全无输出。
if [[ ! -f "$LOG" ]]; then
  echo "[tail-logs] 未找到约定日志: $LOG" >&2
  fallback="$(ls -t /tmp/*server*.log 2>/dev/null | head -n 1 || true)"
  if [[ -n "$fallback" ]]; then
    echo "[tail-logs] 回退到最近的日志: $fallback" >&2
    echo "[tail-logs] 建议改用规范命令启动服务器（见脚本头部）以获得稳定日志。" >&2
    LOG="$fallback"
  else
    echo "[tail-logs] 也没有任何 /tmp/*server*.log。请用规范命令启动服务器。" >&2
    exit 1
  fi
fi

echo "[tail-logs] 日志文件: $LOG"
if [[ -n "$SESSION" ]]; then
  echo "[tail-logs] 过滤 session: $SESSION"
fi
echo "[tail-logs] 关键字: validatePatch / PATCH / ENTERING REVIEW / generateDoc / draftingFailed / 请先完成 / docStateChanged / ECONNRESET / tool_choice"
echo "--------------------------------------------------------------------------"

# 组合过滤管道：先按诊断关键字，再（可选）按 sessionId
filter() {
  if [[ -n "$SESSION" ]]; then
    grep -iE "$PATTERN" | grep -F "$SESSION" || true
  else
    grep -iE "$PATTERN" || true
  fi
}

if [[ "$FOLLOW" -eq 1 ]]; then
  tail -n +1 -f "$LOG" | filter
else
  filter < "$LOG"
fi

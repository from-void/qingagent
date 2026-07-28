#!/usr/bin/env bash
# macOS 本机打包(必须在 macOS 上运行):
#   默认        → 快速测试包(--dir 只出 .app,构建完直接 open)
#   QINGAGENT_MAC_DIST=1 → 可分发 zip(electron-builder.yml 的 mac target)
# 详细说明与排障:docs/packaging-macos.md
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DESKTOP_DIR/../.." && pwd)"
cd "$REPO_ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "本脚本只支持 macOS(交叉打 win 用 build-win.sh)" >&2
  exit 1
fi

# 本地包不签名;签名/公证走 CI,与本脚本无关。
export CSC_IDENTITY_AUTO_DISCOVERY=false

echo "==> [1/3] 构建 web 前端"
pnpm --filter @qingagent/web build

echo "==> [2/3] 构建 desktop 主进程与资源暂存"
pnpm --filter @qingagent/desktop run build

cd "$DESKTOP_DIR"
if [[ "${QINGAGENT_MAC_DIST:-0}" == "1" ]]; then
  echo "==> [3/3] electron-builder 出可分发 zip"
  pnpm exec electron-builder --mac
  echo "==> 完成。产物在 apps/desktop/release/ 下的 *-mac.zip"
else
  echo "==> [3/3] electron-builder 出快速测试包(--dir)"
  pnpm exec electron-builder --mac --dir
  APP="$(find "$DESKTOP_DIR/release" -maxdepth 2 -name '*.app' -print -quit)"
  echo "==> 完成 → ${APP:-release/ 目录}"
  [[ -n "${APP:-}" ]] && open "$APP"
fi

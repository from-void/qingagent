#!/usr/bin/env bash
# Windows 客户端一键构建脚本(在 WSL/Linux 上交叉构建)
#
# 做四件事:
#   1) 构建 web 前端 + electron main/preload(esbuild)
#   2) electron-builder --win --dir 出 win-unpacked(无 wine,不出 nsis)
#   3) 注入 win 版原生依赖(libsql + @napi-rs/canvas),去掉错误平台的 linux 原生
#      —— pnpm 在 Linux 上只装 linux 原生,直接打进 win 包会导致
#         Windows 上 "Cannot find module '@libsql/win32-x64-msvc'" 或 canvas native 加载失败
#   4) 把整个 win-unpacked 复制到 Windows 本地盘 C:\qingagent\win-unpacked
#      —— 从本地盘运行才有硬件加速;从 \\wsl.localhost UNC 路径运行 GPU 子进程会崩
#
# 用法:bash apps/desktop/build-win.sh
# 产物:apps/desktop/release/win-unpacked/青简.exe
#       以及 C:\qingagent\win-unpacked\青简.exe(可直接双击)

set -euo pipefail

# 定位仓库根目录(本脚本在 apps/desktop/ 下)
DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DESKTOP_DIR/../.." && pwd)"
LIBSQL_VERSION="0.5.29"                       # 须与 desktop/package.json 中 libsql 主包一致
CANVAS_WIN_PACKAGE="@napi-rs/canvas-win32-x64-msvc"
# Windows 落地目录,默认 C:\qingagent;多 worktree 并行打包时用 QINGAGENT_WIN_DEST 覆盖
# (如 /mnt/c/qingagent-skillmanage),避免互相 rm -rf/文件锁冲突。
WIN_DEST="${QINGAGENT_WIN_DEST:-/mnt/c/qingagent}"

cd "$REPO_ROOT"

# 打包信息:时间 + 短 commit（含 + = 有未提交改动），vite.config.ts 编译期定值进包,
# 客户端标题栏/首页角标显示,便于验收一眼区分新旧包。
BUILD_TS="$(date '+%Y-%m-%d %H:%M')"
BUILD_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then BUILD_SHA="${BUILD_SHA}+"; fi
export QINGAGENT_BUILD_INFO="${BUILD_TS} · ${BUILD_SHA}"
echo "==> 打包信息: $QINGAGENT_BUILD_INFO"

echo "==> [1/4] 构建 web 前端"
pnpm --filter @qingagent/web build

echo "==> [2/4] 构建 electron main/preload + 打包 win-unpacked"
cd "$DESKTOP_DIR"
pnpm run build
# 本地跨平台构建强制 asar:false(-c.asar=false 覆盖 electron-builder.yml 的 asar:true):
# Linux 上 pnpm 不装 win 原生 libsql,若开 asar,win32-x64-msvc 既不在 app.asar 也不在
# asarUnpack 清单,下面往 app.asar.unpacked 手动注入 Node 也不认(会崩 Cannot find module
# @libsql/win32-x64-msvc)。asar:false 让 node_modules 是普通目录,注入 resources/app/node_modules
# 才生效。CI(windows-latest)原生装 win libsql,asar:true 正确,与此无关。
pnpm exec electron-builder --win --dir -c.asar=false   # 只出 win-unpacked,nsis 需 wine 故跳过

UNPACKED="$DESKTOP_DIR/release/win-unpacked"
LIBSQL_DIR="$UNPACKED/resources/app/node_modules/@libsql"
NAPI_RS_DIR="$UNPACKED/resources/app/node_modules/@napi-rs"
CANVAS_WIN_VERSION="$(node -e 'const { createRequire } = require("node:module"); const { dirname, join } = require("node:path"); const { existsSync, readFileSync } = require("node:fs"); const req = createRequire(process.argv[1] + "/package.json"); let dir = dirname(req.resolve("pdf-parse")); while (dir !== dirname(dir)) { const pkg = join(dir, "package.json"); if (existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).name === "pdf-parse") break; dir = dirname(dir); } const canvasPkg = createRequire(join(dir, "package.json")).resolve("@napi-rs/canvas/package.json"); const canvas = JSON.parse(readFileSync(canvasPkg, "utf8")); process.stdout.write(canvas.optionalDependencies["@napi-rs/canvas-win32-x64-msvc"]);' "$DESKTOP_DIR")"

echo "==> [3/4] 注入 win 版原生依赖"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
( mkdir -p "$TMP/libsql" && cd "$TMP/libsql" && npm pack "@libsql/win32-x64-msvc@$LIBSQL_VERSION" >/dev/null && tar -xzf ./*.tgz )
# 去掉打进来的错误平台原生,只留 win32
rm -rf "$LIBSQL_DIR"/linux-x64-gnu "$LIBSQL_DIR"/linux-x64-musl "$LIBSQL_DIR"/darwin-* 2>/dev/null || true
mkdir -p "$LIBSQL_DIR/win32-x64-msvc"
cp -r "$TMP"/libsql/package/* "$LIBSQL_DIR/win32-x64-msvc/"
echo "    @libsql 现有平台: $(ls "$LIBSQL_DIR")"

( mkdir -p "$TMP/canvas" && cd "$TMP/canvas" && npm pack "$CANVAS_WIN_PACKAGE@$CANVAS_WIN_VERSION" >/dev/null && tar -xzf ./*.tgz )
# pdf-parse 依赖的 @napi-rs/canvas 也有平台原生包。WSL/Linux 只会装 linux 包,
# win-unpacked 需要 win32-x64-msvc,否则 Windows 运行时会从 js-binding 加载失败。
rm -rf "$NAPI_RS_DIR"/canvas-linux-* "$NAPI_RS_DIR"/canvas-darwin-* "$NAPI_RS_DIR"/canvas-android-* 2>/dev/null || true
mkdir -p "$NAPI_RS_DIR/canvas-win32-x64-msvc"
cp -r "$TMP"/canvas/package/* "$NAPI_RS_DIR/canvas-win32-x64-msvc/"
echo "    @napi-rs 现有平台: $(find "$NAPI_RS_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f ')"

echo "==> [4/4] 复制到 Windows 本地盘 $WIN_DEST"
if [ -d /mnt/c ]; then
  rm -rf "$WIN_DEST/win-unpacked"
  mkdir -p "$WIN_DEST"
  cp -r "$UNPACKED" "$WIN_DEST/win-unpacked"
  WIN_DEST_WINPATH="C:$(printf '%s' "${WIN_DEST#/mnt/c}" | tr '/' '\\')"
  echo "    完成 → ${WIN_DEST_WINPATH}\\win-unpacked\\青简.exe"
else
  echo "    跳过:未挂载 /mnt/c(不在 WSL 环境)。产物在 $UNPACKED"
fi

echo "==> 构建完成。双击 ${WIN_DEST_WINPATH:-$WIN_DEST}\\win-unpacked\\青简.exe 启动(本地盘运行=硬件加速)。"

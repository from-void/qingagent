#!/usr/bin/env bash
# Windows NSIS 安装器 + 自动更新 feed 一键构建(在 WSL/Linux 上交叉构建)
#
# 背景:免费 2 核 GitHub windows runner 压不完整包 solid-LZMA(30-75min 超时),
# 但本机多核压同一 payload <2min。electron-builder 从 Linux 打 NSIS 需要 wine 运行
# 32 位安装器 stub 生成卸载器——用 Kron4ek 的 **wow64** 静态 wine(纯 64 位、免 root、
# 免 32 位宿主库)即可。本脚本把这套自动化,免付费 runner 也能出 windows 安装器 + feed。
#
# 产物:apps/desktop/release/qingagent-<version>-win-x64.exe(NSIS 安装器)
#       apps/desktop/release/latest.yml(electron-updater 更新 feed)
#
# 用法:bash apps/desktop/build-win-installer.sh [version]
#   version 省略则取 package.json 的版本;发 beta 传如 0.1.0-beta.1。
# 发布:gh release upload <tag> --repo <owner/repo> \
#         apps/desktop/release/qingagent-<version>-win-x64.exe \
#         apps/desktop/release/latest.yml --clobber

set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DESKTOP_DIR/../.." && pwd)"
VERSION="${1:-}"

# wow64 wine 缓存(免 root、纯 64 位、可跑 32 位 exe)。首次下载 ~63MB,之后复用。
WINE_VER="10.0"
WINE_CACHE="${QINGAGENT_WINE_CACHE:-$HOME/.cache/qingagent-wine}"
WINE_DIR="$WINE_CACHE/wine-${WINE_VER}-amd64-wow64"
WINE_BIN="$WINE_DIR/bin"
export WINEPREFIX="$WINE_CACHE/prefix"
export WINEDEBUG=-all
export WINEDLLOVERRIDES="mscoree=d;mshtml=d"   # 禁 mono/mshtml 安装对话,免 wineboot 卡住

echo "==> [0/4] 准备 wow64 wine ($WINE_VER)"
if [ ! -x "$WINE_BIN/wine" ]; then
  mkdir -p "$WINE_CACHE"
  URL="https://github.com/Kron4ek/Wine-Builds/releases/download/${WINE_VER}/wine-${WINE_VER}-amd64-wow64.tar.xz"
  echo "    下载 $URL"
  curl -fL --connect-timeout 20 -o "$WINE_CACHE/wine.tar.xz" "$URL"
  tar -xf "$WINE_CACHE/wine.tar.xz" -C "$WINE_CACHE"
  rm -f "$WINE_CACHE/wine.tar.xz"
fi
export PATH="$WINE_BIN:$PATH"
if [ ! -f "$WINEPREFIX/drive_c/windows/system32/kernel32.dll" ]; then
  echo "    初始化 wineprefix"
  "$WINE_BIN/wine" wineboot --init >/dev/null 2>&1 || true
  "$WINE_BIN/wineserver" -w   # 等 init 真完成,避免与构建并发访问坏 prefix
fi
echo "    wine: $("$WINE_BIN/wine" --version 2>/dev/null)"

echo "==> [1/3] 出 win-unpacked(build-win.sh:web+desktop 构建 + electron-builder --dir + 注入 win libsql)"
# build-win.sh 已封装 web/desktop 构建、win-unpacked 产出与 win32 libsql 注入;这里直接复用。
# QINGAGENT_WIN_DEST 指向 release 下的临时目录:CI(无 /mnt/c)自动跳过复制;本地不覆盖用户 C:\qingagent。
QINGAGENT_WIN_DEST="${QINGAGENT_WIN_DEST:-$DESKTOP_DIR/release/.wincopy}" bash "$DESKTOP_DIR/build-win.sh"

echo "==> [2/3] makensis 打 NSIS 安装器 + 生成 latest.yml(wow64 wine 跑卸载器 stub)"
VER_ARGS=()
[ -n "$VERSION" ] && VER_ARGS=(-c.extraMetadata.version="$VERSION")
cd "$DESKTOP_DIR"
pnpm exec electron-builder --win nsis \
  --prepackaged release/win-unpacked \
  "${VER_ARGS[@]}" \
  -c.publish.provider=github -c.publish.owner=from-void -c.publish.repo=qingagent \
  --publish never

echo "==> [3/3] 校验 latest.yml sha512 与 exe 一致"
cd "$DESKTOP_DIR/release"
EXE="$(ls qingagent-*-win-x64.exe 2>/dev/null | head -1)"
if [ -z "$EXE" ] || [ ! -f latest.yml ]; then
  echo "    ✗ 产物缺失(exe=$EXE latest.yml=$( [ -f latest.yml ] && echo 有 || echo 无 ))"; exit 1
fi
ACTUAL="$(openssl dgst -sha512 -binary "$EXE" | openssl base64 -A)"
FEED="$(grep -m1 'sha512:' latest.yml | awk '{print $2}')"
if [ "$ACTUAL" = "$FEED" ]; then
  echo "    ✓ sha512 一致"
else
  echo "    ✗ sha512 不一致(exe=$ACTUAL feed=$FEED)"; exit 1
fi

echo "==> 完成:"
echo "    安装器:  $DESKTOP_DIR/release/$EXE ($(du -h "$EXE" | cut -f1))"
echo "    更新feed:$DESKTOP_DIR/release/latest.yml"
echo "    发布:    gh release upload <tag> --repo from-void/qingagent \\"
echo "               $DESKTOP_DIR/release/$EXE $DESKTOP_DIR/release/latest.yml --clobber"

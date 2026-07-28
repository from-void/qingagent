# macOS 打包手册

给任何 agent/同学在 MacBook 上打包用。两种模式：**快速测试包**（分钟级，日常自测用）与**可分发二进制**（zip）。逐条照抄命令即可；每步都写了"失败了看什么"。

## 0. 前置（只需一次）

```bash
# Node ≥ 20(建议 24),用 nvm/brew 均可;pnpm 用 corepack 激活
corepack enable && corepack prepare pnpm@latest --activate
cd <仓库根> && pnpm install
```

国内网络先设镜像（Electron 二进制下载是最常见的"卡老半天"元凶）：

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

## 1. 快速测试包（推荐日常使用）

```bash
bash apps/desktop/build-mac.sh
```

产物：`apps/desktop/release/mac-arm64/青简.app`（Intel 机为 `mac/`），脚本最后会直接 `open` 拉起。
它做四件事：① `pnpm --filter @qingagent/web build`（**漏了这步 = 打开是白窗**）② `apps/desktop pnpm run build`（esbuild 主进程 + 暂存 lark-cli/pyodide/遥测信息）③ `electron-builder --mac --dir`（只出 .app 不压 zip，最快）④ 打开 app。

## 2. 可分发二进制（zip）

```bash
QINGAGENT_MAC_DIST=1 bash apps/desktop/build-mac.sh
```

产物：`apps/desktop/release/青简-<版本>-arm64-mac.zip`。mac target 只配了 zip（未签名时 dmg/自更语义误导，见 electron-builder.yml 注释）。
未签名 app 分发给别人时，对方首次启动需右键→打开，或 `xattr -dr com.apple.quarantine 青简.app`；本机自建不受影响。

## 3. 失败了看什么（按出现频率排序）

| 症状 | 原因与处置 |
|---|---|
| electron/electron-builder 下载卡住数分钟 | 没设镜像。设上面两个环境变量后**删掉 `~/Library/Caches/electron` 与 `~/Library/Caches/electron-builder` 再重跑** |
| 打开 app 白窗/空白 | 漏了 web 构建。用脚本别手拼命令；手拼则必须先 `pnpm --filter @qingagent/web build` |
| 卡在 lark-cli 暂存（stageLarkCli 的 npm install） | 网络问题。可 `QINGAGENT_BUNDLE_LARK_CLI=0` 跳过（飞书连接器在该包不可用，测试其他功能不受影响） |
| 签名相关报错（identity/codesign） | 本地包不签名：脚本已设 `CSC_IDENTITY_AUTO_DISCOVERY=false`；手拼命令时自己带上 |
| `Cannot find module '@libsql/darwin-arm64'` | `pnpm install` 没在 mac 上重跑过（把 Linux/别的机器的 node_modules 拷过来了）。删 node_modules 重新 `pnpm install` |
| electron-builder 下载 app-builder 等二进制失败 | 同镜像问题；或公司代理拦截，试 `HTTPS_PROXY` |
| Intel/Apple Silicon 弄混 | 默认打本机架构。给 Intel 同学打包加 `--x64`（编辑脚本内 electron-builder 行）或让对方自己构建 |

## 4. 心智模型（30 秒）

打包=三层：**web 前端产物**（vite build）→ **desktop 主进程产物**（esbuild + 资源暂存到 `apps/desktop/build/`）→ **electron-builder 装壳**（按 electron-builder.yml 把上述产物+extraResources 组装成 .app/zip）。`--dir` 与 zip 的唯一区别是最后压不压缩。Windows 交叉打包（build-win.sh）额外多"注入 win 原生依赖"一步，mac 原生构建没有这层，别从 win 脚本抄那段。

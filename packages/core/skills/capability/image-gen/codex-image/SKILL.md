---
name: codex-image
label: 本机 Codex 生图
summary: 调度本机 Codex 生成更强的写实或风格化图片
description: 通过沙箱后台运行本机 codex exec 生成图片，将产物安全导入 uploads，并按 DOC-FIRST 规范插入文档。
---

# 本机 Codex 生图

本子技能用于母技能已经完成方式选择后，调度用户本机的 Codex 非交互生成图片。只启动一次有界任务；失败或超时后如实说明并提议改走 SVG，不得无限轮询、自动重跑或隐瞒失败。

## 一、前置与 DOC-FIRST

1. 再次确认 Codex 可用：POSIX 用 `command -v codex`，Windows 用 `where codex`，`timeout` 设为 5 秒。失败就停止本路线，不重试，告诉用户本机 Codex 当前不可用并提议改用“内置 SVG 插画”。
2. 新文档先用 `writeDraft` 完成全文；已有文档先用 `readDraft` 读取最新结构和目标 `blockId`。不要在正文落地前先等几分钟生图。
3. 每张图都要有明确用途和插入位置。优先只生成 1 张，一轮最多 3 张；正文已经足够清楚时不为了装饰堆图。

## 二、准备安全的生图指令

1. 先用工作区命令取得当前工作目录的绝对路径：POSIX 用 `pwd`，Windows 用 `cd`。在该目录内为本次产物选择唯一的绝对路径，默认使用 `.png`，例如 `<工作目录绝对路径>/codex-image-<短标识>.png`。
2. 把用户的画面诉求整理成一份中文生图指令，内容只包括：
   - 用户要求的主体、场景、构图和必须出现的文字；
   - 目标尺寸或宽高比；
   - 风格、光线、色彩、材质等画面要求；
   - 明确要求“使用可用的生图能力生成图片，并把最终产物写到指定绝对路径；结束前确认该文件存在；不要只在回复中描述图片”。
3. 指令里只传完成画面所需的用户描述。禁止复制整段对话、系统提示、文档隐私、账号信息、token、密钥或任何无关敏感内容。若用户没有明确要求把敏感文字画进图里，就不得携带。
4. 为避免把用户文本拼进 shell 命令，先用 `mastra_workspace_write_file` 把这份指令写到工作区临时文本文件。命令行只引用受控的绝对工作目录和指令文件路径。

## 三、后台调度与轮询

使用 `codex exec` 非交互运行，并通过 `-C` 锁定工作目录。推荐命令模板：

```text
codex exec --ephemeral --skip-git-repo-check -s workspace-write -C "<工作目录绝对路径>" - < "<生图指令文件绝对路径>"
```

执行纪律：

1. 调用 `mastra_workspace_execute_command` 时必须传 `background:true`，并给出有界总超时（建议 `timeout:600` 秒）。`codex exec` 完成会自行退出；不要以前台调用长时间阻塞主链。
2. 从启动结果取得 PID，用 `mastra_workspace_get_process_output` 携带 `pid` 和合理的 `tail` 反复轮询；省略 `wait` 或显式传 `wait:false`，避免单次工具调用长时间阻塞。
3. 轮询到明确退出码就立即停止。退出码为 0 后仍以目标图片文件实际存在且能被后续导入为准；非 0、达到总超时、进程消失或持续无结果都视为失败。
4. 同一张图最多启动一次 Codex 任务。失败时保留诚实错误摘要，告诉用户可以改走 SVG；禁止无上限重试、换命令盲跑或假报已有图片。

## 四、产物入库

1. 只接受 `.png`、`.jpg`、`.jpeg`、`.webp` 或 `.svg` 产物；不要把文本、日志、JSON、HTML 或其他扩展名伪装成图片。
2. Codex 成功退出后，调用 `importGeneratedImage`：

```text
importGeneratedImage({path:"<图片绝对路径>",alt:"<简短说明>"})
```

3. 只能使用工具真实返回的 `imageId` 和 `src`。工具会校验当前会话沙箱路径、扩展名、文件大小和真实图片字节；导入失败就按失败处理，不得编造 `/api/v1/files/...` 路径。
4. `width`、`height` 只在工具实际返回时使用；未返回时省略，让文档和前端采用默认尺寸。

## 五、插入文档并核对

拿到真实 `src` 后，调用 `editDraft` 的 `insertBlock` 插入图片 QingML：

```html
<img src="/api/v1/files/真实ID/generated-image.png" alt="简短说明" width="工具返回宽度" height="工具返回高度"/>
```

- 工具未返回尺寸时省略 `width`、`height`，不得猜数。
- `position` 用 `after`/`before` 配合目标块 `ref`，或用 `start`/`end`。
- 插入后必须调用 `readDiff` 核对实际改动；不要再次调用 `writeDraft` 重发整篇来塞图。

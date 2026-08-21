# 席 G 交付报告：标题结算与 DOCX 图表降级申报

## 交付状态

- 两项缺陷均已修复，并补齐直达真实发生点的回归测试。
- 未修改版本号，未启动开发服务器，未访问任务禁止的本机端口，也未读写 `~/.qingagent`。
- 当前托管沙箱把 worktree 对应的 Git 元数据挂载为只读，`git commit` 无法创建 `index.lock`，因此用户要求的分任务提交尚不能落盘；建议恢复写权限后按本文末尾的提交拆分执行。

## 缺陷 1：审阅候选标题提前同步

### 根因

`settleDraftCandidate` 的两条关键路径本身有明确边界：

- 首稿或允许直落的整稿会先写入 canonical document，再从已生效正文派生标题并发送 `sessionMeta`。
- 已有正文的候选会建立 diff、进入 `pendingReview` 并提前返回；此时正文尚未生效，不应更新标题。

真正越过边界的是 external proposal 调用方 `packages/server/src/gateway/docWriteCommands.ts`：它在 `settleDraftCandidate` 返回后，无条件从本次 `qingmlDraft` 候选读取标题、写入 `session.title` 并发送 `sessionMeta`。因此候选 H1 虽然仍待裁决，会话标题却已经永久变成候选值。接受路径在 `reviewCommit.ts` 应用 diff 后再更新标题，时机正确。

### 改动

- 删除 external 候选落定后的提前标题同步；候选进入 `pendingReview` 时只发布审阅数据，不再修改 `session.title`。
- 保留首稿/直落分支在 canonical 写入完成后的标题派生与截断提示逻辑。
- 保留接受/提交分支在正文真正生效后的标题更新逻辑。
- 在整批拒绝且审阅队列清空时，从当前 canonical PM 文档重新派生标题并发送 `sessionMeta`。这既保证拒绝后的客户端标题与正文一致，也修复已经被旧版本污染的持久化 pendingReview 会话。
- `titlePinned=true` 时不派生、不覆盖、不发送候选标题，继续保持用户手动改名脱离正文跟随的既有语义。

### 回归覆盖

- 首稿直落后标题按已生效 H1 派生。
- 后续候选修改 H1：进入审阅时标题不变且没有候选标题 `sessionMeta`。
- 模拟旧版本已污染标题后执行 `reject_all`：标题恢复为 canonical H1、发送纠正帧、正文版本不增加；冷恢复后仍为纠正值。
- `accept_all` 后标题才更新并发送 `sessionMeta`。
- `titlePinned` 会话接受 H1 候选后仍保留手动标题。

## 缺陷 2：DOCX 图表源码降级申报不反映实际产物

### 根因

Mermaid 的 `withRenderedDiagrams` 只负责预渲染并把逐图 SVG 写入导出克隆；它不是最终 DOCX 产物判定点。DOCX 随后还要在 `diagramToDocx` 中检查 SVG、栅格化为 PNG，并在 SVG 缺失、过大或栅格化失败时才真正写入源码。

修复前降级体系没有“最终确实写入图表源码”的独立事实信号，公共响应管线只能聚合导出器上报的 kind，无法可靠表达逐图的最终落点。申报应由最终产物分支产生，而不能由预渲染尝试或文档中存在 diagram 节点来预判。

### 改动

- 新增稳定降级 kind `diagram-source-fallback`，人话描述为“未能生成预览的图表已改为可复制的源码”。
- 仅在 `diagramToDocx` 最终选择“提示段落 + 图表源码”时上报该 kind：
  - SVG 超过导出上限；
  - SVG 缺失或不合法；
  - SVG 栅格化失败。
- Mermaid 成功渲染并实际嵌入 PNG 时提前返回，不上报源码降级。
- 继续保留 `svg-rasterized`：它描述 DOCX 将 SVG 转为位图这一真实产物事实，不等同于源码回退。
- TXT 按格式本性输出图表源码，仍不申报 DOCX 式源码降级。

### 回归覆盖

- mock Mermaid 渲染成功：DOCX 压缩包中存在 PNG、正文 XML 不含 Mermaid 源码、无 `diagram-source-fallback`。
- mock Mermaid 渲染失败：DOCX 无图表媒体文件、正文 XML 含源码，并且只出现一次 `diagram-source-fallback`。
- TXT 含图表源码但降级数组为空。
- 五格式矩阵、既有导出降级、导出响应头公共管线测试保持通过。

## 改动文件

- `packages/core/src/doc-engine/reviewCommit.ts`
- `packages/server/src/gateway/docWriteCommands.ts`
- `packages/server/src/__tests__/externalRoutesPropose.test.ts`
- `packages/doc-render/src/export/shared.ts`
- `packages/doc-render/src/export/toDocx.ts`
- `packages/doc-render/src/__tests__/docxDiagramDegradations.test.ts`

## 验证结果

- `pnpm install --prefer-offline`：通过。
- `pnpm typecheck`：通过，根 workspace 全绿。
- `pnpm external-contract:check`：通过。
- `QINGAGENT_BUNDLE_LARK_CLI=0 pnpm build`：通过，所有 workspace 构建成功。原样 `pnpm build` 仅在 desktop 打包阶段尝试在线安装 `@larksuite/cli` 时因沙箱无网络失败；使用仓库官方的离线瘦包开关后通过，产品代码未改变。
- 标题定向回归：
  - `packages/server/src/__tests__/externalRoutesPropose.test.ts`：30/30 通过。
  - `packages/core/src/__tests__/commitReviewGroups.test.ts`：33/33 通过。
- DOCX 与五格式定向回归：
  - `@qingagent/doc-render` 全量普通测试：41 个文件、295 个测试通过。
  - `packages/server/src/__tests__/exportRoutes.heavy.test.ts`：5/5 通过。
  - `packages/server/src/__tests__/exportFilename.test.ts`：2/2 通过。
- 其他全量普通测试结果：contract 236/236、ui-kit、diagram-engine 106/106、pm-schema 403/403、qa-cli 95/95、db 194/194 均通过。
- Web 全量普通测试：153 个文件、1777 个测试通过；仅既有 `drawioVendor.test.ts` 的 1 个用例因沙箱拒绝嵌套 `spawnSync pnpm`（`EPERM`）失败。
- Core 全量普通测试中，与监听 `127.0.0.1` 或派生子进程有关的 20 个既有环境型用例被沙箱以 `EPERM` 拒绝；3013 个通过、7 个跳过。本任务 Core 定向用例全绿。
- Server 全量并发测试使用统一临时上传目录时发生测试间目录污染，另有环境型端口限制；本任务 external/export 定向用例均在隔离临时存储下通过。
- `git diff --check`：通过。

## 遗留风险与提交建议

1. 降级响应目前按 kind 去重，因此同一文档有多张失败图时只返回一条人话申报；它准确表示“至少一张图实际落成源码”，但不携带逐图编号。这与现有降级头聚合契约一致。
2. 无 H1 的文档仍沿用 `deriveTitleFromDoc` 的既有派生规则；`titlePinned` 始终优先。
3. 当前沙箱无法写 Git 元数据。恢复权限后建议按任务拆分提交：
   - `fix(core): 审阅标题仅随生效正文同步`
   - `fix(doc-render): 按实际产物申报图表降级`
   - `docs: 补充席 G 引擎缺陷修复报告`

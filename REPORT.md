# 席 E 交付报告：external 数据面与外部编辑状态

## 交付状态

- 四项功能改动均已实现，external 路由目录、attach 防漂移清单和生成契约已同步。
- 客户端版本保持 `0.1.5`，未修改任何版本号。
- 当前托管沙箱将 worktree 对应的 `.git` 目录挂载为只读，执行 `git commit` 时无法创建 `index.lock`，因此代码尚未提交。建议恢复可写 Git 元数据后按本文末尾的提交拆分落盘。

## 任务 1：external 导出

### 改动清单

- `packages/server/src/routes/export.ts`
  - 抽出 `exportDocumentResponse` 公共管线，统一五格式渲染、下载响应头、降级头，以及 PDF 浏览器能力、繁忙、超时和渲染失败映射。
  - 原 `/api/v1/export/:sessionId` 的来源校验、attach 拒绝、格式别名和错误外壳保持不变。
- `packages/server/src/routes/external.ts`
  - 新增 external 导出路由；复用 external 读路由的冷恢复会话流程，不走 attach 拒绝。
- `packages/server/src/lib/externalError.ts`、`packages/contract-ts`、`packages/qa-cli`
  - 补齐 external 导出错误码及 CLI 映射。
- `packages/server/src/__tests__/externalExport.test.ts`
  - 覆盖冷恢复成功、下载头、非法格式和空文档冲突。

### 路由契约

`GET /api/v1/external/sessions/:id/export?format=pdf|docx|html|markdown|txt`

- 认证：沿用 external v1 的 Bearer externalInstance 身份；失败为 `401 AUTH_FAILED`。
- 参数：`format` 必填且只接受上列五个完整值；external 路由不接受旧路由兼容的 `md`、`htm` 别名。
- 成功：`200`，响应体为对应导出内容；响应头如下：
  - `Content-Type`：PDF 为 `application/pdf`，DOCX 为 Office Open XML，HTML/Markdown/TXT 为对应 `text/*; charset=utf-8`。
  - `Content-Disposition: attachment`，同时提供 ASCII fallback 和 UTF-8 文件名。
  - `Cache-Control: no-store`。
  - 如发生可接受降级，`X-Qingagent-Export-Degradations` 为 URI 编码后的 JSON 降级数组。
  - 专有图表只能保留语义而不能保留画布布局时，另有 `X-Qingagent-Export-Notice`。
- 错误：
  - `400 VALIDATION`：格式缺失或非法。
  - `404 SESSION_NOT_FOUND`：冷恢复后仍找不到会话。
  - `409 CONFLICT`：会话没有 canonical 可导出文档。
  - `503 BROWSER_CAPABILITY_UNAVAILABLE`：PDF 所需浏览器能力不可用。
  - `503 EXPORT_BUSY`：导出并发槽繁忙，并带 `Retry-After: 5`。
  - `504 EXPORT_DEADLINE_EXCEEDED`：渲染超过截止时间。
  - `500 EXPORT_RENDER_FAILED`：其他渲染失败。
- 除版本冲突专用响应外，external 错误统一为 `{ error, code, nextStep }`。

## 任务 2：external 批注组写入

### 改动清单

- `packages/core/src/tools/annotationGroups.ts`
  - 抽出 `writeAnnotationGroups` 服务，统一逐字锚定、来源语义校验、批注建组、按来源原子换代、数据库写入和权威 `annotationGroupsReady` 帧构造。
  - external 插件来源常量为 `external-plugin`。
- `packages/core/src/session/sessionTools.ts`、`packages/core/src/agent-run/agentStreamFinalize.ts`
  - Mastra `create_annotation_groups` 工具继续作为工具壳，调用同一服务；agent 最终帧也复用同一帧构造函数。
- `packages/server/src/routes/external.ts`
  - 新增批注写路由，在 session actor 串行区内完成冷恢复、租约校验、版本校验、持久化和帧发布。
  - `runExclusive` 产出的 `annotationGroupsReady` 与 `docStateChanged` 会进入会话 frame log，并推送 renderer 和 external events 订阅者。
- `apps/web/src/pages/workspace/components/AnnotationCarousel.tsx`
  - `external-plugin` 的 hover 来源标签显示为“青简插件”。
- `packages/server/src/__tests__/externalAnnotations.test.ts`
  - 覆盖持约成功、逐字锚定、来源覆写、帧发布、版本冲突、锚点失败、错误 turnId 和无副作用保证。

### 路由契约

`POST /api/v1/external/sessions/:id/review/annotations`

请求体：

```json
{
  "turnId": "optional-external-turn-id",
  "expectedDocVersion": 3,
  "groups": [
    {
      "summary": "短标题",
      "note": "批注说明",
      "origin": "plugin-supplied-origin",
      "suggestion": "可直接替换的文本",
      "severity": "warn",
      "judgment": "数字",
      "materialQuote": "可选素材原句",
      "checkedScope": "可选核查范围",
      "documentQuote": "可选文内冲突原句",
      "anchors": [{ "find": "必须在当前文档中逐字出现的文本", "all": false }]
    }
  ]
}
```

- `expectedDocVersion`：必填、非负整数，必须等于当前 `docVersion`。
- `turnId`：可选非空字符串，最长 200。存在活跃 external 租约时必须传当前持约 turnId；传了 turnId 但已丢锁也会拒绝。
- `groups`：至少一组；`summary`、`note`、`origin` 和非空 `anchors` 必填。
- `severity`：`error | warn | info`。
- `judgment`：`口径漂移 | 数字失真 | 无据 | 素材遗漏 | 时间线 | 数字 | 称谓与术语 | 论断`。
- `anchors[].find` 使用当前文档逐字匹配；`all: true` 会为全部命中位置建锚点，否则只取首个命中。
- 写入时会把所有组的持久化 `origin` 强制设为 `external-plugin`；请求中的 `origin` 仍为必填结构字段，但不会冒充其他审查来源。客户端展示标签为“青简插件”。
- 同一请求按原子模式处理：任一组语义或锚点校验失败时，整批不落库、不覆盖旧批注。

成功响应 `200`：

```json
{
  "status": "created",
  "docVersion": 3,
  "annotations": [
    {
      "id": "annotation-...",
      "summary": "短标题",
      "note": "批注说明",
      "origin": "external-plugin",
      "suggestion": "可选改写",
      "severity": "warn",
      "status": "reviewing",
      "anchors": [
        { "blockId": "...", "pmFrom": 1, "pmTo": 5, "quote": "逐字文本" }
      ]
    }
  ],
  "groupCount": 1,
  "anchorCount": 1,
  "seq": 12
}
```

`seq` 是本次发布后最新的会话帧序号；没有可用序号时为 `null`。

错误：

- `400 VALIDATION`：请求结构错误、来源语义字段错误，或任一逐字锚点/素材引文/文内冲突引文找不到。`error` 会指出具体组、字段和未命中文字。
- `404 SESSION_NOT_FOUND`：会话不存在且无法冷恢复。
- `409 VERSION_CONFLICT`：版本漂移；响应为 `{ code, expected, actual, nextStep, seq? }`，调用方必须重读文档后重建锚点，不得原样重放。
- `409 AGENT_BUSY`：原生 agent、其他忙态或 review overlay 占用。
- `409 LOCK_LOST`：所传 external turnId 不是当前租约持有者，或租约已经失效。
- `409 CONFLICT`：当前没有 canonical 可批注文档。
- `429 RATE_LIMITED`：写限流或 session actor 队列已满，带 `Retry-After: 1`。

## 任务 3：external 词库只读

### 改动清单

- `packages/server/src/routes/external.ts` 新增只读路由，直接复用 core 已导出的 `listLexicons`，只投影公开摘要字段。
- `packages/contract-ts/src/ExternalApi.ts` 与生成的 qa-cli 契约新增词库响应类型。
- `packages/server/src/__tests__/externalLexicons.test.ts` 验证字段白名单。

### 路由契约

`GET /api/v1/external/lexicons`

- 请求：无路径参数、无请求体、无业务查询参数。
- 成功 `200`：

```json
{
  "lexicons": [
    { "id": "lexicon-id", "name": "词库名", "entryCount": 42, "enabled": true }
  ]
}
```

- 错误：`401 AUTH_FAILED`；非 loopback 高频读取超过 external 限额时为 `429 RATE_LIMITED`，带 `Retry-After: 1`。

## 任务 4：外部编辑状态呈现

### 改动清单与 wire 语义

- `packages/core/src/doc-engine/docStateMachine.ts`
  - 新增 `deriveExternalEditing(state)`：只有未过期的 `externalBusyLease` 返回 `true`。
  - `docStateChanged.data` 增加 `externalEditing`，projection key 纳入该位，租约进入、过期和结束都会可靠发帧。
  - `deriveAgentBusy` 保持原状，服务端写入防线不变。
- restore、审阅 no-op 和审阅失败等直接构造 `docStateChanged` 的旁路也同步携带该字段，并使用同一 projection key 维度，避免恢复/结算时退回旧投影。
- `packages/contract-ts/src/BridgeFrame.ts`
  - `externalEditing?: boolean` 为可选字段，旧服务端/旧录制帧保持兼容。
- `apps/web`
  - wire validator 与 `workspaceState` 接收该字段；会话重置或新帧缺省时为 `false`。
  - `externalEditing=true` 时沿用文档锁定，输入区显示“青简插件正在编辑”，发送禁用且不显示停止按钮。
  - 原生 agent 忙态仍显示原停止按钮；客户端乐观 stop 只清原生忙态，不清 `externalEditing`，该字段只能由服务端帧改变。
- 回归覆盖活跃/过期/结束投影序列与 projection key、reducer 进入/退出及 stop、wire validator、来源标签和真实 DOM 中的提示/停止按钮互斥。

## 路由目录与契约产物

已登记到 `SERVER_ROUTE_CATALOG`：

- `GET /api/v1/external/lexicons`
- `GET /api/v1/external/sessions/:id/export`
- `POST /api/v1/external/sessions/:id/review/annotations`

三条路由均位于 external 子树，目录策略为 externalInstance 可访问，不新增 attach 复用入口。`pnpm external-contract:generate` 已更新 `packages/qa-cli/src/generated/externalApi.ts`，`external-contract:check` 通过。

## 验证结果

- `pnpm install --prefer-offline`：通过，依赖全部复用本地缓存。
- `pnpm typecheck`：通过，11 个 workspace 项目的类型检查全绿。
- `DATABASE_URL=file:/tmp/... QINGAGENT_BUNDLE_PYODIDE=0 QINGAGENT_BUNDLE_LARK_CLI=0 pnpm build`：通过；contract、qa-cli、web、desktop 全部构建成功。两个 `QINGAGENT_BUNDLE_*` 开关只跳过需要外部下载的桌面可选资源，不改变产品代码。
- `pnpm external-contract:check`：通过。
- 定向回归：
  - core 投影与相关流收口：6 个文件、116 个测试通过。
  - core 审阅直接帧与提交回归：2 个文件、55 个测试通过。
  - server 新路由与 attach 目录：4 个文件、12 个测试通过。
  - server 恢复、提交与事件回放：3 个普通测试文件、31 个测试通过；3 个 heavy 测试文件、45 个测试通过。
  - web reducer、wire validator、来源标签：3 个文件、171 个测试通过。
  - web DOM 外部编辑呈现：1 个文件、3 个测试通过。
- web 非 DOM 全量测试排除既有 `drawioVendor.test.ts` 后：153 个文件、1774 个测试通过。
- 原样执行根 `pnpm test` 在本托管沙箱未能完成：`drawioVendor.test.ts` 内部用 `spawnSync("pnpm", ["build:desktop"])` 启动嵌套进程时由沙箱返回 `EPERM`。这是进程权限限制，定向新增测试与其余 web 非 DOM 全量测试均已通过。
- `git diff --check`：通过。

## 遗留风险与提交建议

1. PDF 导出仍依赖部署环境具备 Chromium 安全沙箱能力；不可用时会明确返回 `BROWSER_CAPABILITY_UNAVAILABLE`，其他四种格式不受影响。
2. 批注锚点是逐字锚定，插件必须在获取文档与提交批注之间持有租约并携带最新 `expectedDocVersion`；版本冲突后必须重读并重建 anchors。
3. 当前沙箱无法写 `.git`，尚未生成用户要求的分任务提交。恢复 Git 元数据写权限后建议依次提交：
   - `feat(server): 增加 external 文档导出接口`
   - `feat(review): 增加 external 批注组写入接口`
   - `feat(server): 增加 external 词库只读接口`
   - `fix(web): 修复外部编辑租约状态呈现`
   - `docs: 添加席 E 交付报告`

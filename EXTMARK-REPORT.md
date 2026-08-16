# #37 外部 API `markText` op 实现报告

日期：2026-08-16  
分支：`feat/external-marktext`

## 结论

引擎侧已向外部 proposal 通道开放 `markText`：外部调用方可按逐字或安全正则匹配，在整篇或 `withinRef` 指定块内添加/移除行内 mark，并沿用候选稿与审阅结算链路产出 `markAdd` / `markRemove` hunk。`markText` 保持非结构性，不要求 `opId`。

## 契约改动

- `packages/contract-ts/src/ExternalPropose.ts`
  - 公开 `ExternalProposeOp` 新增 `{ kind: "markText", find, mark, op, all?, isRegex?, withinRef? }`。
  - 判别字段使用外部惯例 `kind`；动作字段逐字使用内部既有命名 `op: "add" | "remove"`。
  - 未加入 `EXTERNAL_STRUCTURAL_OP_KINDS`。
- `packages/contract-ts/src/ExternalApi.ts`
  - 平行 `ExternalProposeOp` 同步同一分支，复用 `DraftTextMark`。
- Zod 镜像
  - `packages/contract-ts/src/schemas/draftMutation.ts` 导出既有 `draftTextMarkSchema`。
  - `packages/contract-ts/src/schemas/command.ts` 的 `externalProposeOpSchema` 新增 `kind: "markText"` 分支；`find` 非空、`withinRef` 使用现有 ID 长度护栏、`mark` 复用受控 schema。
  - `textColor` / `highlight` 仅接受 `DRAFT_MARK_COLORS` 的 24 个主题色，任意 CSS 色值会在 API 入参校验阶段拒绝。
- 生成镜像
  - 外部 API 类型生成器增加 `DraftMutation` 类型 import 重写，并重新生成 `packages/qa-cli/src/generated/externalApi.ts`。

## 执行路径

`POST /sessions/:id/proposals`
→ `externalPropose` 命令 Zod 校验
→ `handleDocWriteCommand`
→ `applyExternalProposalOps`
→ `collectTopLevelTextBlocks(workingDoc, withinRef)`
→ 逐字 `findLiteralMatches` 或安全正则 `findSafeRegexMatches`
→ 匹配器内部沿用 `applyAllPolicy`
→ `aiRunMarkToPmMark`
→ `markTextRuns`
→ `settleDraftCandidate`
→ `proposalDiff.appendMarkHunks`
→ 审阅态 `markAdd` / `markRemove` hunk。

非 `all` 场景只接受唯一命中；零命中或多义命中返回可自纠文案：

> 文本未命中或未唯一命中,请缩小 withinRef 或设 all:true

## 测试覆盖

新增或扩展的回归覆盖：

- 外部 `markText` add。
- remove，且保留正文。
- `all: true` 全部命中。
- `withinRef` 块范围限定。
- 非 `all` 多义命中与精确可自纠文案。
- `isRegex` 安全正则匹配。
- 24 色受控色板全部接受，任意色值拒绝；错误使用内部 `action` discriminator 也拒绝。
- 完整 proposal → 审阅流同时产出 `markAdd` 与 `markRemove` hunk。
- `contract-ts` 的 `DRAFT_MARK_COLORS` 与 `pm-schema` 的 `PM_THEME_COLORS` 同值断言。
- operation parity 测试覆盖 `markText`，并验证它不属于结构操作集合。

定向测试证据：

- `packages/contract-ts/src/schemas/__tests__/command.test.ts`：87/87 通过。
- `packages/pm-schema/src/__tests__/schemaSync.test.ts`：20/20 通过。
- `packages/server/src/gateway/__tests__/docWriteCommands.test.ts`：22/22 通过。
- `packages/server/src/__tests__/externalRoutesPropose.test.ts`：23/23 通过。
- `pnpm external-contract:check`：通过。
- `git diff --check`：通过。

工作区质量门：

- `pnpm -r typecheck`：通过。
- `QINGAGENT_BUNDLE_LARK_CLI=0 pnpm -r --if-present build`：通过。默认桌面构建仅在 `stageLarkCli` 尝试访问 npm 镜像时被当前环境的禁网策略以 `EPERM connect` 拦截；代码构建本身无报错。
- `pnpm -r --if-present test`：变更相关包和用例均通过；全量在当前受限沙箱仍有既有环境型失败：Web 1 例、Core 20 例、Desktop 6 例均涉及被禁止的子进程或本地监听。Server 全量中的 2 例是测试运行时显式注入临时 `QINGAGENT_LOG_DIR` 改变了 mock 断言入参；取消该变量后单独复跑该文件 3/3 通过。Web DOM 套件 1052/1052 通过，Core 其余 2974 例通过，Desktop 其余 44 例通过。
- 所有会写数据的测试均显式指向 `/tmp`；未启动 dev server，未访问任务禁止的本地端口。

## dsh 插件侧跟进清单（本次不实现）

1. 在 dsh `src/tools.ts:285-346` 的 `qing_edit_draft` schema `oneOf` 中镜像新增 `kind: "markText"`：
   - `find: string`
   - `mark: DraftTextMark` 的结构化 `oneOf`
   - `op: "add" | "remove"`
   - `all?`、`isRegex?`、`withinRef?`
   - `textColor` / `highlight` 的 `color` 必须枚举同一组 24 个主题色，不接受任意色值。
2. 改写 dsh 系统提示词中的旧编辑纪律：明确局部加粗、斜体、下划线、删除线、代码、链接、文字色和高亮应使用外部 `markText`，说明唯一命中、`withinRef`、`all:true` 与安全正则的选择方式；移除“外部通道不支持行内标记”类旧限制。


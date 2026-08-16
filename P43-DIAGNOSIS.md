# P43 诊断报告：审阅结算后等价内容写入致版本膨胀（#62）

## 结论

已复现，已修复。

根因不是审阅管线按 hunk 重复提交，也不是 `flush` / 会话自愈直接追加正版本；根因是统一文档提交入口只把“完整 PM JSON 哈希相同”视为 no-op。审阅结算后的权威正文被编辑器重新物化时，会补出 TipTap schema 默认属性（例如有序列表的 `listStyle: "decimal"`）以及列表、表格等末尾的空段落。两份文档的可见正文相同、用户也没有编辑，但完整 JSON 哈希不同，因此随后的用户 `updateDoc` 会穿过 no-op 门，执行一次正常版本写入。

最小两轮复现中，预期 `v1 + 2 次真实结算 = v3`，修复前实际得到 `v5`，恰好多出每轮一次等价后台保存。这与真机现象的“结算轮数与多余版本数近似一一对应”一致。

当前分支已经包含前端提交 `d3929e61`，它在 [DocumentSnapshotView.tsx](apps/web/src/pages/workspace/components/DocumentSnapshotView.tsx:1004) 消费远端事务的 `APPLYING_REMOTE_META`，并在 [DocumentSnapshotView.tsx](apps/web/src/pages/workspace/components/DocumentSnapshotView.tsx:1567) 给远端 `setContent` 标记来源，关闭了当前客户端最直接的伪保存触发源。但旧标签页、旧客户端或其他调用方仍可能发来表示不同而内容等价的 `updateDoc`，所以服务端提交边界仍需防御性短路。

## 已验证的根因链路

1. WebSocket/命令入口的用户自动保存由 [docWriteCommands.ts](packages/server/src/gateway/docWriteCommands.ts:443) 处理。它把编辑器 PM 归一化后，以 `actorType: "user"`、`opKind: "replace_doc"` 和 `clientMutationId` 传给 `commitDocumentOp`（[docWriteCommands.ts](packages/server/src/gateway/docWriteCommands.ts:467)、[docWriteCommands.ts](packages/server/src/gateway/docWriteCommands.ts:483)、[docWriteCommands.ts](packages/server/src/gateway/docWriteCommands.ts:530)）。
2. `commitDocumentOp` 在乐观锁通过后计算完整 PM JSON 哈希。修复前 no-op 条件只有 `contentHash === current.contentHash`；只要编辑器物化了默认属性或尾随空段，便继续计算 `nextVersion`，更新 `documents.doc_version`，并插入/滚动 `document_versions`（[commitDocumentOp.ts](packages/core/src/doc-engine/commitDocumentOp.ts:457)、[commitDocumentOp.ts](packages/core/src/doc-engine/commitDocumentOp.ts:510)、[commitDocumentOp.ts](packages/core/src/doc-engine/commitDocumentOp.ts:560)、[commitDocumentOp.ts](packages/core/src/doc-engine/commitDocumentOp.ts:597)）。
3. 审阅提交会广播新的 canonical 快照。历史前端时序窗可能把远端 `setContent` 的迟到 `update` 当成本地 dirty，随后走第 1 步；当前分支已有事务 meta 守卫（[DocumentSnapshotView.tsx](apps/web/src/pages/workspace/components/DocumentSnapshotView.tsx:1004)）。
4. 因此每次真实审阅结算后都可能紧跟一次表示等价的用户保存，形成“真实结算版本 + 等价自动保存版本”两次推进。

这里能由仓库代码、提交历史和红测直接证明的是：服务端确实会把这类编辑器等价表示写成新版本，且历史前端确实存在远端事务误登记 dirty 的时序窗。没有拿到 60 轮评测的原始 session DB，所以报告不把某一个具体真机帧序列伪装成已读取的证据。

## 审阅结算没有按 hunk 重复提交

- 内部 REST `/commit` 只构造一个 `commitReviewGroups` 或 `commitPatches` 命令，再经同一个 session actor 串行执行（[stream.ts](packages/server/src/routes/stream.ts:654)、[stream.ts](packages/server/src/routes/stream.ts:666)）。
- 外部审阅提交同样只构造一个 `commitReviewGroups` 命令（[external.ts](packages/server/src/routes/external.ts:887)、[external.ts](packages/server/src/routes/external.ts:924)）。
- `commitReviewGroups` 只展开/去重裁决 ID，最后调用一次 `commitPatches`（[reviewCommit.ts](packages/core/src/doc-engine/reviewCommit.ts:1386)、[reviewCommit.ts](packages/core/src/doc-engine/reviewCommit.ts:1430)、[reviewCommit.ts](packages/core/src/doc-engine/reviewCommit.ts:1441)）。
- `commitPatches` 对整批只调用一次 `commitDocumentOp`（[reviewCommit.ts](packages/core/src/doc-engine/reviewCommit.ts:899)）。整篇候选与局部 hunk 都已有“结果哈希未变化则冲突、不写空版本”的门（[reviewCommit.ts](packages/core/src/doc-engine/reviewCommit.ts:962)、[reviewCommit.ts](packages/core/src/doc-engine/reviewCommit.ts:1015)、[reviewCommit.ts](packages/core/src/doc-engine/reviewCommit.ts:1029)）。
- 全拒绝路径只结算 suggestion/draft，不写 canonical 正版本。

因此没有发现“每个 hunk 各提交一次”的结算写源。

## 复现测试

回归测试位于 [contentEditCommitWiring.test.ts](packages/core/src/doc-engine/__tests__/contentEditCommitWiring.test.ts:207)，使用 `prepareTempDocumentsDb` 和临时 `HOME`，不启动 dev server。

序列如下：

1. 提交紧凑表示的初稿，得到 `v1`。
2. 两轮分别构造新的整篇候选，执行 `settleDraftCandidate → commitPatches`，每轮只有一次真实正文修改。
3. 每次结算后模拟编辑器把相同正文物化为“默认 `listStyle` + 列表尾随空段”，再发送用户 `replace_doc`。
4. 断言两次后台保存均 `createdNewVersion === false`，最终 `docVersion === 3` 且历史恰好 3 条（[contentEditCommitWiring.test.ts](packages/core/src/doc-engine/__tests__/contentEditCommitWiring.test.ts:231)、[contentEditCommitWiring.test.ts](packages/core/src/doc-engine/__tests__/contentEditCommitWiring.test.ts:246)、[contentEditCommitWiring.test.ts](packages/core/src/doc-engine/__tests__/contentEditCommitWiring.test.ts:268)）。

红测证据：修复前同一测试报 `expected 5 to be 3`；修复后为 `v3`，测试通过。

## 修复方案与取舍

### 实现

- 新增持久层等价比较 [persistenceEquivalence.ts](packages/pm-schema/src/persistenceEquivalence.ts:1)：两侧先走既有 `normalizePmDoc`，再用产品实际 TipTap schema 物化默认属性，最后用 ProseMirror `Node.eq` 比较。
- 只枚举 TipTap `TrailingNode` 确实可能自动补出的尾随空段：文档至少两块、末块为空段、前一块不是 `paragraph` / `heading` / `columnList`（[persistenceEquivalence.ts](packages/pm-schema/src/persistenceEquivalence.ts:38)）。
- 在统一提交边界的既有用户 no-op 分支中加入持久等价判断（[commitDocumentOp.ts](packages/core/src/doc-engine/commitDocumentOp.ts:459)）。命中后返回当前 canonical 和 `createdNewVersion: false`，不写 `documents`、`document_versions`、`document_ops`，也不滚动 coalesce 窗口。

### 边界与取舍

- 乐观锁检查仍先执行；旧基线不能用“内容刚好等价”伪装成消费了当前版本。
- 只扩大“带 `clientMutationId` 的用户整篇保存”no-op；agent 生成、patch 提交与审阅结算的幂等/冲突语义不变。
- `blockId` 明确保留在等价比较中。块 ID 自愈仍是合法持久变化，不会被吞掉。
- 非空尾段、真实文字/结构变化、普通段落后的额外空段都不等价。
- schema 物化异常时 fail closed，按不同内容继续原有提交逻辑，避免漏写真实编辑。
- 没有选择全局重写 canonical JSON。只在提交边界比较并返回现有 canonical，改动范围更小，也不引入存量迁移。

对应边界单测见 [persistenceEquivalence.test.ts](packages/pm-schema/src/__tests__/persistenceEquivalence.test.ts:53)：覆盖默认属性/尾随脚手架、`blockId` 变化、真实正文/非空尾段和普通段落后的空段。

## 其他版本写源排查

| 写源 | 是否能解释主稿正版本膨胀 | 结论 |
|---|---:|---|
| 用户 `updateDoc` → `commitDocumentOp` | 是 | 本次根因；已在统一提交边界短路持久等价表示。 |
| 外部首写 `propose` | 否 | 仅空文档首次写入时直接提交；已有正文只生成 draft/suggestion（[docWriteCommands.ts](packages/server/src/gateway/docWriteCommands.ts:774)、[docWriteCommands.ts](packages/server/src/gateway/docWriteCommands.ts:850)）。 |
| 内部/外部审阅 commit | 否 | 每个命令整批只调用一次 `commitPatches`；无按 hunk 重复提交。 |
| 首稿正常结算 | 否 | 仅无可审原版时走一次稳定 `generation:<session>:<stream>` opId（[settleDraftCandidate.ts](packages/core/src/doc-engine/settleDraftCandidate.ts:277)）。 |
| pending draft 冷恢复 | 否 | 仅 `baseVersion === 0` 的首稿候选可能提交，复用同一 generation opId，重复恢复幂等（[pendingDraftRehydrate.ts](packages/core/src/doc-engine/pendingDraftRehydrate.ts:225)、[pendingDraftRehydrate.ts](packages/core/src/doc-engine/pendingDraftRehydrate.ts:251)）。 |
| `schedulePersist` / `persistSessionMetadata` / shutdown flush | 否 | 只调用 Mastra `memory.updateThread/saveThread` 写 thread metadata，不写 `documents` 或正版本（[threadPersistence.ts](packages/core/src/session/threadPersistence.ts:1306)、[threadPersistence.ts](packages/core/src/session/threadPersistence.ts:1402)）。 |
| restore conflict rescue | 否 | 唯一旁路 `insertVersion` 使用负 `doc_version` 保存败方快照，不推进主稿正版本（[threadPersistence.ts](packages/core/src/session/threadPersistence.ts:921)）。 |
| 新建 external 空会话 | 否 | 只 `documentRepo.save` 一个 `docVersion: 0` 空行，不插入版本历史（[external.ts](packages/server/src/routes/external.ts:1956)）。 |
| `documentRepo.save` | 否 | 只 upsert `documents`，本身不插 `document_versions`；同版本同 hash 也有 SQL 短路（[documentRepo.ts](packages/db/src/db/documentRepo.ts:427)、[documentRepo.ts](packages/db/src/db/documentRepo.ts:579)）。 |
| 衍生稿生成 | 否 | 会写自己的 `role='derivative'` 文档 ID 和版本表，不会推进主稿 docId（[derivatives.ts](packages/core/src/tools/derivatives.ts:188)、[derivatives.ts](packages/core/src/tools/derivatives.ts:225)）。 |

结论：除本次修复的用户整篇保存入口外，没有发现另一个会在审阅结算后给同一主稿追加等价正版本的生产写源。

## 验证结果

所有测试均使用临时 `HOME`；未启动 dev server，未访问 `127.0.0.1:8080/3080`，未读写真实 `~/.qingagent`。

- 新增 PM 等价单测：4/4 通过。
- 新增多轮结算集成回归：修复前 `v5`（红），修复后精确 `v3`（绿）。
- `contentEditCommitWiring.test.ts` + `commitDocumentOp.test.ts`：43/43 通过。
- server `bridgeHandlerUpdateDoc.heavy.test.ts`：17/17 通过。
- server 常规测试：867/868 首轮通过；唯一计时用例单独重跑通过，判定为并发负载下 flake。
- web 常规测试除沙箱子进程探针外：1754/1754 通过；DOM：1052/1052 通过。
- core 全量中可执行部分：2975 通过；20 个失败全部集中在沙箱禁止的 `spawnSync` / Worker 或本地 `listen` 探针，与改动无关。
- desktop：44 通过；6 个 Electron/子进程测试受同一沙箱进程限制失败。
- `pnpm -r typecheck`：通过。
- `QINGAGENT_BUNDLE_LARK_CLI=0 pnpm -r --if-present build`：通过。默认桌面 build 的唯一阻塞是离线环境无法执行构建期 `npm install @larksuite/cli`，故使用仓库提供的瘦包开关验证构建。
- `pnpm -r --if-present test` 已实际执行；无法在当前受限沙箱宣称全量绿，阻塞项如上如实列出。相关包、相关路径及所有不依赖被禁止 OS 能力的用例均通过。

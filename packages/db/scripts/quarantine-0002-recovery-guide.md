# 0023 隔离正文覆盖识别与恢复

本流程只处理旧版 0023 曾把 `documents_quarantine_0002` 的版本嫁接到另一
`doc_id`，继而由启动巡检覆盖当前正文的情况。恢复前先停止所有会访问该数据库的
server / desktop 进程，避免恢复期间产生新写入。

## 1. 只读识别

在与线上相同的 `DATABASE_URL` 下执行：

```sh
pnpm db:identify-quarantine-0002-overwrites
```

0025 会在启动迁移中自动识别、隔离异源子表。只有同时满足以下正向证据的文档才写入
`document_write_blocks`：异源版本确由 0023 从 `document_versions_quarantine_0002`
映射而来、0025 已将该行从活跃家族移入 `document_versions_quarantine_0025`、当前
`doc_version` 与该版本一致、当前 `doc_pm` 与隔离快照精确一致，且从两份 PM 现算的
hash 与版本 hash 三者一致，同时活跃家族中不存在能解释当前 PM 的本家同版本快照。
当前版本若仍有本家操作记录，同样视为来源不唯一，只进入人工审计。阻断后所有正文/
草稿/建议写入口均 fail-closed，启动草稿恢复也会跳过并保持草稿/建议原状。识别命令
不会隐式执行迁移；运行前须确认应用已正常完成 0025。若缺少恢复血缘表，
命令会直接报错且不改迁移账本。

仅有同版本、存储列里的同 `content_hash` 或相似正文时不会永久锁写，而会写入
`document_recovery_audits`，识别结果标记为 `manual_confirmation_required`。这些
`review_status='pending'` 的记录必须人工对照备份后显式确认或驳回。0025 一旦持久化
阻断，后续即使兼容迁移规整了 PM 表示，识别仍会以 `persisted_block` 报告该行，直到
完成备份恢复并显式解除阻断。先保存完整输出；不要仅凭标题、版本号或存储 hash 判断。

## 2. 定位迁移前备份

迁移 runner 会在数据库旁创建：

```text
<database>.bak-pre-v23-<yyyyMMddHHmmss>
```

若库直接从 22 升到包含 24/25 的版本，备份也可能名为
`bak-pre-v24-*` / `bak-pre-v25-*`；只有首次应用 23 之前生成的备份才可作为
原正文来源。优先选择时间上紧邻首次应用
0023、且识别结果中的当前 `doc_id` 仍保有正确正文的备份。

## 3. 对照与恢复

1. 复制备份到独立临时路径，以只读方式核对每个 `currentDocId` 的
   `doc_pm`、`doc_version`、`content_hash`、`version` 和 `updated_at`。
2. 若整个库在 0023 后没有任何需要保留的新写入，停服后可用已核验备份整体还原。
3. 若已有新写入，只逐行恢复识别结果中的 `documents` 行；不要从隔离表直接猜正文，
   也不要删除 `document_versions`、`document_ops` 或任何隔离表。
4. 保留恢复前数据库的完整副本。核对恢复行的 `doc_pm`、`doc_version`、
   `content_hash` 与备份一致后，仅删除该文档对应的阻断行：

   ```sql
   DELETE FROM document_write_blocks
   WHERE doc_id = '<已核验恢复的 currentDocId>'
     AND reason = 'quarantine_0002_foreign_snapshot';
   ```

5. 启动新版本后再次运行识别命令，并确认目标文档正文、版本历史、撤销/重做均符合预期。

遇到 `manual_confirmation_required` 时，先按上述步骤对照 pre-0023 备份。若确认没有
覆盖，显式驳回审计：

```sql
UPDATE document_recovery_audits
SET review_status = 'dismissed',
    reviewed_at = CURRENT_TIMESTAMP,
    review_note = '<核验依据>'
WHERE doc_id = '<currentDocId>'
  AND version_id = '<versionId>'
  AND review_status = 'pending';
```

若人工确认确有覆盖，应在同一事务内按审计证据显式新增 `document_write_blocks` 行并把
`review_status` 更新为 `confirmed`，再按第 2、3 节恢复；不要让应用从弱证据自动升级为
永久阻断。备份缺失、同一文档在 0023 后仍有合法编辑，或无法确定正确正文时，停止恢复
并交由人工逐版本核对。

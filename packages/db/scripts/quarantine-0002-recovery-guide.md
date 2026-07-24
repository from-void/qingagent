# 0023 隔离正文覆盖识别与恢复

本流程只处理旧版 0023 曾把 `documents_quarantine_0002` 的版本嫁接到另一
`doc_id`，继而由启动巡检覆盖当前正文的情况。恢复前先停止所有会访问该数据库的
server / desktop 进程，避免恢复期间产生新写入。

## 1. 只读识别

在与线上相同的 `DATABASE_URL` 下执行：

```sh
pnpm db:identify-quarantine-0002-overwrites
```

识别命令不会隐式执行迁移；运行前须确认应用已正常完成 0024。若缺少恢复血缘表，
命令会直接报错且不改迁移账本。

输出只包含当前 `documents.doc_version` 与异源隔离版本一致，且 `doc_pm` 完全一致
（`exact_snapshot`）或 `content_hash` 一致（`matching_hash`）的行。先保存完整输出；
不要仅凭标题或版本号判断。

## 2. 定位迁移前备份

迁移 runner 会在数据库旁创建：

```text
<database>.bak-pre-v23-<yyyyMMddHHmmss>
```

若库直接从 22 升到包含 24 的版本，备份也可能名为
`bak-pre-v24-*`，但其内容同样是应用 23 前的快照。优先选择时间上紧邻首次应用
0023、且识别结果中的当前 `doc_id` 仍保有正确正文的备份。

## 3. 对照与恢复

1. 复制备份到独立临时路径，以只读方式核对每个 `currentDocId` 的
   `doc_pm`、`doc_version`、`content_hash`、`version` 和 `updated_at`。
2. 若整个库在 0023 后没有任何需要保留的新写入，停服后可用已核验备份整体还原。
3. 若已有新写入，只逐行恢复识别结果中的 `documents` 行；不要从隔离表直接猜正文，
   也不要删除 `document_versions`、`document_ops` 或任何隔离表。
4. 保留恢复前数据库的完整副本。启动新版本后再次运行识别命令，并确认目标文档正文、
   版本历史、撤销/重做均符合预期。

遇到 `matching_hash` 而非 `exact_snapshot`、备份缺失、同一文档在 0023 后仍有合法编辑，
或无法确定正确正文时，停止恢复并交由人工逐版本核对。

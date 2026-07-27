# qa CLI 审查模板与技能管理

本文面向 Claude Code、Codex 等通过 `qa` CLI 操作青简的用户。所有远端命令都连接当前正在运行的青简实例；开始前先运行：

```bash
qa status
```

## 审查模板

查看模板：

```bash
qa template list [--type <t>] [--json]
qa template show <id> [--json]
```

`type` 可取 `sensitive`、`deai`、`source`、`consistency`、`privacy`、`format`、`role`、`custom`。列表中的 `*` 表示该类型当前选中的模板，`(内置)` 表示只读种子。

把模板拉到本地 Markdown：

```bash
qa template pull <id> --out <file.md>
```

文件格式如下。正文就是完整 prompt；修改时保留 `id` 和 `updatedAt`，它们用于防止覆盖其他人刚提交的新版本。

```markdown
---
id: 'review-custom-team'
type: custom
name: '团队审查'
updatedAt: '2026-07-27T08:00:00.000Z'
---
逐项检查目标、证据与风险。
```

推送本地模板：

```bash
qa template push <file.md> [--json]
```

有 `id` 时更新原模板并携带 `expectedUpdatedAt`；没有 `id` 时创建新模板。成功后 CLI 会把服务器返回的 `id` 和新 `updatedAt` 回写到文件。若返回 `CONFLICT`，重新 `pull` 最新版本，合并后再 `push`。

也可以直接用 prompt 文件创建：

```bash
qa template create --type <t> --name <n> --file <prompt.md> [--json]
qa template select <id> [--json]
qa template rm <id> [--json]
```

内置模板允许选用，但不能修改或删除。

## 发起审查

```bash
qa review run -s <id> --type <t> [--template <id>] [--supplement <text>] [--wait] [--json]
```

省略 `--template` 时使用该类型当前选中的模板。省略 `--supplement` 时读取青简里这个文档已保存的文档级补充要求。`--wait` 会复用事件流等待审查闭环；不加时，命令在成功入队后立即返回。

发起审查只把同一份菜单指令送入青简现有 chat 管线，不创建旁路工作流。后续可继续使用：

```bash
qa review list -s <id> [--json]
qa review show -s <id> (--patch <id> | --annotation <id>) [--json]
```

## 技能管理

查看技能：

```bash
qa skills list [--json]
qa skills show <name> [--json]
```

本地校验和安装：

```bash
qa skills validate <dir> [--json]
qa skills install <dir|file.md> [--json]
```

目录安装会递归发送普通文本文件，根目录必须有合法 `SKILL.md`；每个子技能也必须有自己的合法 `SKILL.md`。绝对路径、`..`、符号链接、重复路径和缺少根 `SKILL.md` 都会在本地或服务端被拒绝。单文件安装只发送一个 `SKILL.md`。

整体更新、删除和启停：

```bash
qa skills update <name> <dir> [--json]
qa skills rm <name> [--json]
qa skills enable <name> [--json]
qa skills disable <name> [--json]
```

只有 `source=installed` 的技能可以整体更新或删除。内置技能不能被代码写口覆盖，但可以启用或禁用。更新使用 staging 目录整体替换；校验或落盘失败时旧版保持不变。

原有的 Claude Code/Codex 指针技能安装命令保持不变：

```bash
qa skills install claude|codex
```

## 示例一：把 custom 模板改成法务口径并运行

先找出要修改的非内置 custom 模板和目标会话：

```bash
qa template list --type custom --json
qa sessions list --json
```

假设模板 id 是 `review-custom-team`，会话 id 是 `session-123`：

```bash
qa template pull review-custom-team --out legal-review.md
```

编辑 `legal-review.md`：保留 `id`、`type`、`updatedAt`，把 `name` 改成 `法务口径审查`，正文改成所需法务规则。然后执行：

```bash
qa template push legal-review.md
qa template select review-custom-team
qa review run -s session-123 --type custom --template review-custom-team --supplement "重点检查广告承诺与合同义务" --wait
```

如需查看产生的批注和修改建议：

```bash
qa review list -s session-123 --json
```

## 示例二：安装带子技能的自定义 skill

准备目录：

```text
legal-review/
├── SKILL.md
└── contract-check/
    └── SKILL.md
```

`legal-review/SKILL.md`：

```markdown
---
name: legal-review
description: 对文档执行法务风险审查，并按需读取合同子技能。
---
# 法务审查

遇到合同义务问题时读取子技能 `contract-check`。
```

`legal-review/contract-check/SKILL.md`：

```markdown
---
name: contract-check
description: 核对合同主体、义务、期限和违约责任。
---
# 合同核对

逐项检查合同主体、义务、期限和违约责任。
```

校验、安装并复查：

```bash
qa skills validate ./legal-review
qa skills install ./legal-review
qa skills show legal-review
```

后续整体更新：

```bash
qa skills update legal-review ./legal-review
```

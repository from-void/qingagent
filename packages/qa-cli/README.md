# @qingagent/qa-cli

`qa` 是青简本机 external API 的命令行客户端，供 Claude Code、Codex 和其他自动化 Agent 读写文档、处理审查、管理审查模板与已安装技能。

启动青简后先检查实例：

```bash
qa status
```

主要命令组：

```bash
qa sessions list [--limit N] [--all] [--json]
qa doc read -s <id> [--lines] [--json]
qa doc propose -s <id> --expect-version N (--full draft.md | --str-replace <old> <new> | --append section.md | --ops ops.json)
qa review run -s <id> --type <t> [--template <id>] [--supplement <text>] [--wait] [--json]
qa review list -s <id> [--json]
qa template list [--type <t>] [--json]
qa template pull <id> --out <file.md>
qa template push <file.md> [--json]
qa skills list [--json]
qa skills validate <dir> [--json]
qa skills install <dir|file.md> [--json]
qa skills update <name> <dir> [--json]
```

完整的审查模板 CRUD、审查发起、技能目录格式和两个端到端样例见 [qa CLI 审查模板与技能管理](../../docs/qa-cli-review.md)。

Agent 在改写青简文档前必须读取内嵌协作规范：

```bash
qa skills read writer
```

安装 Claude Code/Codex 指针技能：

```bash
qa skills install claude|codex
```

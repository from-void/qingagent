# 参与贡献

感谢你对青简 qingagent 的兴趣。本文面向想跑通开发环境、提交 issue/PR 的贡献者。

## 开发环境

纯 TypeScript monorepo(pnpm workspaces,Node >= 22),基于 [Mastra](https://mastra.ai) 框架。

```bash
corepack enable && corepack prepare pnpm@9.15.0 --activate
pnpm install
pnpm dev          # web SPA  → http://localhost:5173
pnpm dev:server   # 后端     → http://127.0.0.1:8080(web 代理 /api → :8080)
pnpm dev:desktop  # Electron 壳
```

后端需要 `packages/server/.env` 配置 `DEEPSEEK_API_KEY`(参考 `.env.example`)。

## 仓库地图

| 路径 | 内容 |
|---|---|
| `packages/core` | Mastra 大脑:agents / AI-IR 草稿工具 / skills / 浏览器自动化 / 搜索 / db(libsql)/ 导出(docx·pdf)/ prompts / 可观测 |
| `packages/server` | Hono HTTP 服务(routes + bridge + DuckDB observability),`:8080` |
| `packages/contract-ts` | **手维护**契约类型——改完必须跑 `pnpm -r typecheck` |
| `packages/pm-schema` | PM 文档 canonical schema + AI-IR 编译 + TipTap 扩展 |
| `packages/ui-kit` | 设计系统 CSS + 基础 React 组件 |
| `apps/web` | Vite + React SPA;Vitest 测试(默认+DOM 两套) |
| `apps/desktop` | Electron 壳 |

## 提交前:三绿

```bash
pnpm -r typecheck
pnpm -r --if-present build
pnpm -r --if-present test   # core/server 套件需串行:vitest --fileParallelism=false
```

apps/web 的测试分默认与 DOM 两套,`pnpm --filter @qingagent/web test` 已链式包含,两套都要绿。

## 分支与提交约定

- 走 feature 分支,不直接提交 `main`;`main` 推送会自动部署,必须始终三绿可部署。
- 提交信息:Conventional Commits 前缀 + 中文正文,例:`fix(web): 修复首页白屏`。
- 每修一个 bug,必须带一条能复现它的回归测试。
- 解析/提取/清洗类"对付不可信输入"的函数,必须配对抗性脏输入测试。

## UI 约定

`#/uikit` 页面(运行中的应用内)是 UI 规范的活文档:宋体正文、直角为主、暖纸/金/墨色 token、全站唯一 toast 家族 `qa-toast`。改 UI 前先看它;规范页与代码不一致时以规范页为准。

## 添加一个集成

集成代码按 provider 自包含，通常只需要改三处：

1. 在 `packages/core/src/tools/vendor/<provider>/` 放置该厂商专属工具；连接器的定义、adapter 与 adapter 工厂放在 `packages/core/src/connectors/` 的 provider 模块中，并由模块调用 `registerConnector(...)`。
2. 在 `packages/core/src/connectors/registry.ts` 增加一行静态导入。注册是编译期显式聚合，不使用动态加载或运行时插件发现。
3. 若集成需要供 agent 使用，在对应 capability skill 中引用工具，并在连接器定义的 `usedBySkills` 中登记 skill id。

vendor 工具包括某厂商独有的授权、API、会话与数据格式适配；通用的搜索、文件解析、确定性计算等能力继续放在 `packages/core/src/tools/`。`tools/index.ts` 是稳定聚合出口，新增或搬迁工具时不要让调用方感知内部目录。

需要产品统一管理连接状态、授权生命周期、凭据 custody 或前端“连接”面板展示的能力进入 core connector；可移植的提示词、知识说明、任务编排与零依赖脚本优先做成 skill。skill 若只消费已有工具，不要为了它新增 connector。

## Issue 与 PR

- Bug 报告请带:复现步骤、期望/实际行为、版本或 commit、必要日志截图(用 issue 模板)。
- 安全漏洞**不要**走公开 issue,发 security@qingagent.com(见 [SECURITY.md](./SECURITY.md))。
- PR 描述用中文,说明动机与验证方式;保持单一主题,大改动建议先开 issue 讨论。

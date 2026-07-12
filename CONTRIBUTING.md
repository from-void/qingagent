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
| `packages/ui-kit` | 设计 token 与基础样式的唯一来源(附少量已消费的原始组件,非组件库) |
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

`packages/ui-kit` 不建设 React 组件全家桶；应用层优先复用“裸元素 + CSS 类 + token”。新组件只有在至少 3 处真实跨页面复用且样式、交互稳定时才可收录，否则留在使用处。

## Issue 与 PR

- Bug 报告请带:复现步骤、期望/实际行为、版本或 commit、必要日志截图(用 issue 模板)。
- 安全漏洞**不要**走公开 issue,发 security@qingagent.com(见 [SECURITY.md](./SECURITY.md))。
- PR 描述用中文,说明动机与验证方式;保持单一主题,大改动建议先开 issue 讨论。

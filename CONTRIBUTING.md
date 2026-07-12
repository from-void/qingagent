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
pnpm test                   # 默认 unit 层,保持 workspace 与文件并行
```

apps/web 的测试分默认与 DOM 两套,`pnpm --filter @qingagent/web test` 已链式包含,两套都要绿。

## 测试分层

全仓测试按资源画像分为三层,文件名就是稳定的归类契约:

| 层级 | 命令 | 文件命名 | 何时使用 |
|---|---|---|---|
| unit | `pnpm test` | 默认 `*.test.ts(x)` | 纯逻辑、mock I/O、普通 jsdom 交互;应快速、可并行、可重复 |
| heavy | `pnpm test:heavy` | `*.heavy.test.ts(x)` | Pyodide、真实 Playwright/Chromium 渲染、PDF/图表栅格化、真实进程或 TCP、长链路集成烟测 |
| perf | `pnpm test:perf` | `*.perf.test.ts(x)` | 大 DOM/大数据量或并发负载下,对真实墙钟、吞吐或调度次数设门槛的性能基准 |

`pnpm test:heavy` 和 `pnpm test:perf` 会限制 workspace 并发,对应 Vitest 配置也关闭文件并行并使用更宽超时。提交前本地全量验收运行 `pnpm test:all`,它依次覆盖 unit、heavy、perf,不能用只跑默认层代替。

只有测试会真实拉起重运行时或包含性能门时才归入 heavy/perf。模块名里出现 browser/PDF、使用 fake timer、mock 浏览器接口,或验证普通超时错误分支,仍属于 unit。新增 heavy/perf 文件时,同时确认所属包的 `vitest.heavy.config.ts` / `vitest.perf.config.ts` 和 package script 已覆盖该命名。apps/web 的 `pnpm visual` 是独立视觉快照套件,不属于上述旧全量回归命令。

## 分支与提交约定

- 走 feature 分支,不直接提交 `main`;`main` 推送会自动部署,必须始终三绿可部署。
- 提交信息:Conventional Commits 前缀 + 中文正文,例:`fix(web): 修复首页白屏`。
- 每修一个 bug,必须带一条能复现它的回归测试。
- 解析/提取/清洗类"对付不可信输入"的函数,必须配对抗性脏输入测试。

## UI 约定

`#/uikit` 页面(运行中的应用内)是 UI 规范的活文档:宋体正文、直角为主、暖纸/金/墨色 token、全站唯一 toast 家族 `qa-toast`。改 UI 前先看它;规范页与代码不一致时以规范页为准。

`packages/ui-kit` 不建设 React 组件全家桶；应用层优先复用“裸元素 + CSS 类 + token”。新组件只有在至少 3 处真实跨页面复用且样式、交互稳定时才可收录，否则留在使用处。

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

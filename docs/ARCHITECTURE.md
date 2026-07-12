# 架构说明

本文记录 qingagent 的关键架构选型与**有意识接受的权衡**——尤其是那些"看起来别扭、但我们清楚为什么这么做"的地方，供贡献者和评审快速对齐，避免重复讨论已经拍过板的问题。

## 系统总览

```
apps/desktop ──内嵌──> packages/server <──HTTP/SSE── apps/web
                            │  │  │                   │
                            │  │  └──> packages/doc-render
                            │  └─────> packages/db
                            └────────> packages/core
                                         │  │  │
                                         │  │  └──> packages/doc-render
                                         │  └─────> packages/db
                                         └────────> packages/pm-schema

packages/contract-ts ──契约类型──> core / db / doc-render / server / web
packages/pm-schema   ──文档模型──> core / db / doc-render / server / web
packages/contract-ts ──生成外部 API 类型──> packages/qa-cli ──HTTP/SSE──> server
```

各 workspace 的职责如下:`core` 是 Mastra agent 大脑;`db` 是 libsql 文档/会话/版本仓储;`doc-render` 负责 headless 浏览器渲染及 PDF/DOCX/SVG 导出;`contract-ts` 手维护跨端及外部 API 契约;`pm-schema` 维护 canonical 文档 schema、AI-IR 编译与 TipTap 扩展;`server` 是 Hono HTTP 服务;`web` 是 Vite + React SPA;`desktop` 是内嵌 server 的 Electron 壳;`qa-cli` 是外部 API 客户端。图中省略了 `ui-kit`、`diagram-engine` 等横向叶包。

`packages/core/src` 内部按现状分层:

```
组合/入口: agents  bridge  runtime  services
领域能力: tools  skills  llm  workspace  search  connectors  folderSources
支撑能力: observability  diagnostics  credentials  debug  home  seed  evals
叶层:     prompts  types  utils
```

依赖方向原则上从组合/入口流向领域能力,再流向支撑与叶层;具体禁边由 `.dependency-cruiser.cjs` 执行。`bridge` 目录名记录的是当前现状,G1 合并后的物理目录变化另行同步。

一句话数据流:用户消息 → Hono SSE → Mastra agent(DeepSeek)→ AI-IR 草稿工具(askUser 问卷 → writeDraft / editDraft)→ 候选-diff(用户确认 → 乐观并发落版本)→ TipTap 富文本渲染。**生成由服务端自驱动,断连不停。**

## Agent 框架:Mastra(选型与已知约束)

**结论:qingagent 的 agent 底座是 [Mastra](https://mastra.ai)(`@mastra/core`),并将长期继续使用。** 本节记录这一选择及其已知代价,以免评审误以为下述约束是"没意识到"的疏漏。

### 为什么用 Mastra

`packages/core` 的 agent 运行时直接构建在 Mastra 之上:`Agent` 抽象、`agent.stream()` 流式编排、`Memory`(对话记忆)、`Workspace`(会话工作区)、工具调用与 **suspend/resume**(用于"挂起等用户回答问卷"这类交互)都由它提供。这让我们把精力集中在**写作领域逻辑**(AI-IR 文档模型、候选-diff、乐观并发落版本)上,而不是自己造一套 agent 编排与记忆的地基。Mastra 目前深度编织进 core 约 60 个源文件(tools / bridge / llm / workspace / agents 等),这是一个**有意的强绑定**——替换代价很高,我们已就此做出承诺。

### 已知约束与我们的对策(接受,不视为 bug)

1. **suspend 工具强制串行。** Mastra 的 suspend/resume 语义会让带 suspend 的工具串行执行,并整批缓冲结果。这在"并行慢工具长期无返回"时曾表现为挂死。**对策**:心跳看门狗封顶(5 分钟)+ 超时逐卡落败,使慢工具有界收口而非无限续命;上游串行化本身的升级评估作为独立事项跟踪。
2. **AI SDK 4/5 隔离共存。** Mastra 1.x 的 peer 链要求 `ai@4.3.19`,Mastra 接口与其消息类型继续走 `ai`;内层模型调用需要 AI SDK 5,通过 `ai-v5` 包别名显式导入,provider 统一从 canonical 包(`@ai-sdk/anthropic` 等)导入。W2-1 已做过硬升级实验:把根实例直接升到 v5 会破坏 Mastra peer 解析,因此在 Mastra 官方 peer 支持 v5 且迁移验证通过前,不得强行合并为单版本。
3. **observability 刻意不进 Electron 包。** `@mastra/duckdb` 的原生 `.node` 绑定会破坏桌面端打包,因此中央 `Mastra` 实例构造时**不带** observability,由 `packages/server` 在服务端启动时通过 `configureObservability()` 外部注入;桌面端从不调用该函数,DuckDB 绑定永不进入 core 依赖树。详见 `packages/core/src/mastra.ts`。

## 依赖守卫与冻结边

`.dependency-cruiser.cjs` 的一般规则禁止循环、禁止低层回引组合层,并把 `db`、`observability`、`types/utils`、`prompts` 等保持为叶层。以下 4 条是被精确限定目标文件的**存量冻结边**,不是新增依赖的许可:

| 冻结边 | 为什么存在 | 什么条件下可删 |
|---|---|---|
| `llm/todoAwarenessPrompt.ts` → `bridge/todoAwareness.ts` | prompt 组装仍需读取 bridge 持有的会话 todo 快照。 | todo 上下文的所有权统一并下沉到 llm 可依赖的领域接口,调用方完成迁移后删除。 |
| `tools/parseFile.ts` → `bridge/uploadFileResolver.ts` | `parseFile` 仍借旧 bridge resolver 解析历史会话附件,维持存量附件兼容。 | 附件解析与会话编排分层完成,resolver 下沉到独立领域层且旧会话回归通过后删除。 |
| `tools/writeDraft.ts` → `bridge/sessionState.ts`（仅 type-only） | 草稿工具暂时复用会话状态类型,尚未为该契约建立更低层归属。 | 会话状态契约随物理分包下沉到双方可依赖的契约/领域包,import 切换后删除。 |
| `prompts/system.ts` → `workspace/runtimeCapabilities.ts` | system prompt 需要把运行时沙箱能力写进模型上下文,能力探测目前位于 workspace。 | 组合根完成能力探测并把结果作为纯数据注入 prompt,system 不再主动读取 workspace 后删除。 |

退役冻结边时应同时删除对应 allowlist 规则,让更宽的禁边重新接管;不得把 `pathNot` 扩成目录级豁免。

## Workspace 源码链接决策

当前 workspace 包只在本仓消费、不发布 npm,因此 `main`/`exports` 有意直接指向 `src/*.ts`,由消费端工具链 source-link。若未来发布任一包,必须先建立独立的产物构建、类型声明与 `dist` exports,不能把源码入口原样发布。

## 测试分层

测试采用 unit、heavy、perf 三层文件命名契约:默认 `*.test.ts(x)` 快速并行运行;真实重运行时、浏览器、进程/TCP 或长链路集成归 `*.heavy.test.ts(x)`;带墙钟、吞吐或调度门槛的基准归 `*.perf.test.ts(x)`。分类标准、命令和新增配置检查见 [CONTRIBUTING.md 的测试分层](../CONTRIBUTING.md#测试分层),架构文档不复制易漂移的执行细则。

## 外部 API 契约

`/api/v1/external` 的兼容边界由 `packages/contract-ts/src/ExternalApi.ts` 手维护;生成脚本把它单向同步到 `packages/qa-cli/src/generated/externalApi.ts`,`pnpm external-contract:check` 在 CI 阻止生成物漂移。类型生成只锁静态形状,server 的 external contract golden heavy 测试还会启动真实 Hono app,逐端点锁定状态码、精确 JSON keys/值与 SSE frame,共同覆盖“声明契约”和“运行时实现”两侧。

## UI Kit

`packages/ui-kit` 是设计 token 与基础样式的唯一来源，附带少量已被消费的原始组件，但不是完整 React 组件库。应用层以“裸元素 + CSS 类 + token”为主要复用方式；新组件仅在至少 3 处真实跨页面复用且样式、交互稳定时收录，否则留在使用处。

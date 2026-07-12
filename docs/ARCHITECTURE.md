# 架构说明

本文记录 qingagent 的关键架构选型与**有意识接受的权衡**——尤其是那些"看起来别扭、但我们清楚为什么这么做"的地方，供贡献者和评审快速对齐，避免重复讨论已经拍过板的问题。

## 系统总览

```
apps/web        Vite + React SPA(TipTap/ProseMirror 富文本)
apps/desktop    Electron 壳,内嵌 server,数据落 userData
packages/server Hono HTTP 服务(:8080),libsql 持久化 + DuckDB 观测
packages/core   Mastra agent 大脑:工具/技能/记忆/文档桥接
packages/doc-render 文档渲染与导出(headless 浏览器 → PDF/DOCX/SVG)
packages/db     持久化层(libsql 文档/会话/版本仓储)
packages/pm-schema  文档 canonical schema + AI-IR 编译 + TipTap 扩展
packages/contract-ts 手维护的前后端契约类型
packages/ui-kit  设计 token 与基础样式的唯一来源
```

一句话数据流:用户消息 → Hono SSE → Mastra agent(DeepSeek)→ AI-IR 草稿工具(askUser 问卷 → writeDraft / editDraft)→ 候选-diff(用户确认 → 乐观并发落版本)→ TipTap 富文本渲染。**生成由服务端自驱动,断连不停。**

## Agent 框架:Mastra(选型与已知约束)

**结论:qingagent 的 agent 底座是 [Mastra](https://mastra.ai)(`@mastra/core`),并将长期继续使用。** 本节记录这一选择及其已知代价,以免评审误以为下述约束是"没意识到"的疏漏。

### 为什么用 Mastra

`packages/core` 的 agent 运行时直接构建在 Mastra 之上:`Agent` 抽象、`agent.stream()` 流式编排、`Memory`(对话记忆)、`Workspace`(会话工作区)、工具调用与 **suspend/resume**(用于"挂起等用户回答问卷"这类交互)都由它提供。这让我们把精力集中在**写作领域逻辑**(AI-IR 文档模型、候选-diff、乐观并发落版本)上,而不是自己造一套 agent 编排与记忆的地基。Mastra 目前深度编织进 core 约 60 个源文件(tools / bridge / llm / workspace / agents 等),这是一个**有意的强绑定**——替换代价很高,我们已就此做出承诺。

### 已知约束与我们的对策(接受,不视为 bug)

1. **suspend 工具强制串行。** Mastra 的 suspend/resume 语义会让带 suspend 的工具串行执行,并整批缓冲结果。这在"并行慢工具长期无返回"时曾表现为挂死。**对策**:心跳看门狗封顶(5 分钟)+ 超时逐卡落败,使慢工具有界收口而非无限续命;上游串行化本身的升级评估作为独立事项跟踪。
2. **`ai` SDK peer 版本隔离。** Mastra 锁 `ai@4` 作为 peer,而主 Agent 与工具内层统一使用 AI SDK 5 的 provider。二者由包管理器隔离共存,应用代码统一从 canonical 包(`@ai-sdk/anthropic` 等)导入,**不再存在别名/双实例混用**(此前的 `-v5` alias 已清理)。
3. **observability 刻意不进 Electron 包。** `@mastra/duckdb` 的原生 `.node` 绑定会破坏桌面端打包,因此中央 `Mastra` 实例构造时**不带** observability,由 `packages/server` 在服务端启动时通过 `configureObservability()` 外部注入;桌面端从不调用该函数,DuckDB 绑定永不进入 core 依赖树。详见 `packages/core/src/mastra.ts`。

## UI Kit

`packages/ui-kit` 是设计 token 与基础样式的唯一来源，附带少量已被消费的原始组件，但不是完整 React 组件库。应用层以“裸元素 + CSS 类 + token”为主要复用方式；新组件仅在至少 3 处真实跨页面复用且样式、交互稳定时收录，否则留在使用处。

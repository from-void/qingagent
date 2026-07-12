/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "packages/*/src 与 apps/*/src 内禁止循环依赖。",
      from: { path: "^(packages|apps)/[^/]+/src/" },
      to: { circular: true },
    },
    {
      name: "core-lower-layers-no-orchestration-domains",
      severity: "error",
      comment: "core 的 llm/tools/workspace 低层不得新增对 doc-engine/session/agent-run 组合域的依赖。",
      from: {
        path: "^packages/core/src/(llm|tools|workspace)/",
        pathNot: [
          "(^|/)__tests__/",
          "^packages/core/src/llm/todoAwarenessPrompt[.]ts$",
          "^packages/core/src/tools/parseFile[.]ts$",
          "^packages/core/src/tools/writeDraft[.]ts$",
        ],
      },
      to: { path: "^packages/core/src/(doc-engine|session|agent-run)/" },
    },
    {
      name: "freeze-todo-awareness-agent-run-edge",
      severity: "error",
      comment: "存量冻结：todoAwarenessPrompt 读取 agent-run 的会话 todo 快照；待上下文归属统一后再下沉。",
      from: { path: "^packages/core/src/llm/todoAwarenessPrompt[.]ts$" },
      to: {
        path: "^packages/core/src/(doc-engine|session|agent-run)/",
        pathNot: "^packages/core/src/agent-run/todoAwareness[.]ts$",
      },
    },
    {
      name: "freeze-parse-file-session-edge",
      severity: "error",
      comment: "存量冻结：parseFile 仍通过 session 的上传文件解析器兼容旧会话附件；后续随附件链路分层。",
      from: { path: "^packages/core/src/tools/parseFile[.]ts$" },
      to: {
        path: "^packages/core/src/(doc-engine|session|agent-run)/",
        pathNot: "^packages/core/src/session/uploadFileResolver[.]ts$",
      },
    },
    {
      name: "freeze-write-draft-session-state-type-edge",
      severity: "error",
      comment: "存量冻结：writeDraft 仅以 type-only 方式读取会话状态；契约下沉需与后续物理分包一并处理。",
      from: { path: "^packages/core/src/tools/writeDraft[.]ts$" },
      to: {
        path: "^packages/core/src/(doc-engine|session|agent-run)/",
        pathNot: "^packages/core/src/session/sessionState[.]ts$",
      },
    },
    {
      name: "core-doc-engine-no-agent-run",
      severity: "error",
      comment: "doc-engine 不得新增对 agent-run 的反向依赖；下列逐文件规则仅冻结纯搬家前已存在的边。",
      from: {
        path: "^packages/core/src/doc-engine/",
        pathNot: [
          "(^|/)__tests__/",
          "^packages/core/src/doc-engine/(docStateMachine|docStateTransitions|reviewCommit|settleDraftCandidate|textEditOps)[.]ts$",
        ],
      },
      to: { path: "^packages/core/src/agent-run/" },
    },
    {
      name: "freeze-doc-state-questionnaire-edge",
      severity: "error",
      comment: "存量冻结：文档状态推导复用 questionnaireTools 的方向判定；仅允许该既有目标。",
      from: { path: "^packages/core/src/doc-engine/(docStateMachine|docStateTransitions)[.]ts$" },
      to: {
        path: "^packages/core/src/agent-run/",
        pathNot: "^packages/core/src/agent-run/questionnaireTools[.]ts$",
      },
    },
    {
      name: "freeze-review-commit-agent-run-edges",
      severity: "error",
      comment: "存量冻结：reviewCommit 复用 agent-run 的 frame 与 tool card 构造器。",
      from: { path: "^packages/core/src/doc-engine/reviewCommit[.]ts$" },
      to: {
        path: "^packages/core/src/agent-run/",
        pathNot: "^packages/core/src/agent-run/(frames|toolCards)[.]ts$",
      },
    },
    {
      name: "freeze-settle-draft-agent-run-edges",
      severity: "error",
      comment: "存量冻结：settleDraftCandidate 复用 agent span、frame 与 tool card 构造器。",
      from: { path: "^packages/core/src/doc-engine/settleDraftCandidate[.]ts$" },
      to: {
        path: "^packages/core/src/agent-run/",
        pathNot: "^packages/core/src/agent-run/(agentSpans|frames|toolCards)[.]ts$",
      },
    },
    {
      name: "freeze-text-edit-safe-regex-edge",
      severity: "error",
      comment: "存量冻结：textEditOps 复用 agent-run 的安全正则隔离实现。",
      from: { path: "^packages/core/src/doc-engine/textEditOps[.]ts$" },
      to: {
        path: "^packages/core/src/agent-run/",
        pathNot: "^packages/core/src/agent-run/safeRegex[.]ts$",
      },
    },
    {
      name: "core-session-no-agent-run",
      severity: "error",
      comment: "session 是 agent-run 的被依赖域，不得新增反向依赖；下列规则精确冻结存量边。",
      from: {
        path: "^packages/core/src/session/",
        pathNot: [
          "(^|/)__tests__/",
          "^packages/core/src/session/(omSidecar|sessionState|sessionTools|threadPersistence)[.]ts$",
        ],
      },
      to: { path: "^packages/core/src/agent-run/" },
    },
    {
      name: "freeze-session-state-questionnaire-edge",
      severity: "error",
      comment: "存量冻结：sessionState 复用 questionnaireTools 的工具名判定。",
      from: { path: "^packages/core/src/session/sessionState[.]ts$" },
      to: {
        path: "^packages/core/src/agent-run/",
        pathNot: "^packages/core/src/agent-run/questionnaireTools[.]ts$",
      },
    },
    {
      name: "freeze-thread-persistence-agent-run-edges",
      severity: "error",
      comment: "存量冻结：threadPersistence 复用 tracing、askUser 恢复与 questionnaire 判定。",
      from: { path: "^packages/core/src/session/threadPersistence[.]ts$" },
      to: {
        path: "^packages/core/src/agent-run/",
        pathNot: "^packages/core/src/agent-run/(agentSpans|askUserAnswerMessage|questionnaireTools)[.]ts$",
      },
    },
    {
      name: "freeze-session-tools-agent-run-edges",
      severity: "error",
      comment: "存量冻结：sessionTools 复用图片补全、questionnaire 判定与脱敏辅助。",
      from: { path: "^packages/core/src/session/sessionTools[.]ts$" },
      to: {
        path: "^packages/core/src/agent-run/",
        pathNot: "^packages/core/src/agent-run/(imageDimensionFallback|questionnaireTools|redaction)[.]ts$",
      },
    },
    {
      name: "freeze-om-sidecar-agent-span-edge",
      severity: "error",
      comment: "存量冻结：omSidecar 复用 agent-run 的 session trace id。",
      from: { path: "^packages/core/src/session/omSidecar[.]ts$" },
      to: {
        path: "^packages/core/src/agent-run/",
        pathNot: "^packages/core/src/agent-run/agentSpans[.]ts$",
      },
    },
    {
      name: "core-session-no-doc-engine",
      severity: "error",
      comment: "session 是 doc-engine 的被依赖域，不得新增反向依赖；下列规则精确冻结存量边。",
      from: {
        path: "^packages/core/src/session/",
        pathNot: [
          "(^|/)__tests__/",
          "^packages/core/src/session/(sessionTools|threadPersistence)[.]ts$",
        ],
      },
      to: { path: "^packages/core/src/doc-engine/" },
    },
    {
      name: "freeze-thread-persistence-doc-engine-edges",
      severity: "error",
      comment: "存量冻结：threadPersistence 在恢复/落库链路复用文档状态与 pending draft 逻辑。",
      from: { path: "^packages/core/src/session/threadPersistence[.]ts$" },
      to: {
        path: "^packages/core/src/doc-engine/",
        pathNot: "^packages/core/src/doc-engine/(commitDocumentOp|docStateMachine|docStateTransitions|pendingDraftRehydrate)[.]ts$",
      },
    },
    {
      name: "freeze-session-tools-doc-engine-edges",
      severity: "error",
      comment: "存量冻结：sessionTools 组合 draft 读取、草稿状态、diff 与文本编辑能力。",
      from: { path: "^packages/core/src/session/sessionTools[.]ts$" },
      to: {
        path: "^packages/core/src/doc-engine/",
        pathNot: "^packages/core/src/doc-engine/(draftReadContext|draftScratch|proposalDiff|textEditOps)[.]ts$",
      },
    },
    {
      name: "split-packages-no-core-back-edge",
      severity: "error",
      comment: "物理拆出的 db/doc-render 是 core 的下层包，禁止反向依赖 core。",
      from: { path: "^packages/(db|doc-render)/src/" },
      to: { path: "^packages/core/src/" },
    },
    {
      name: "db-is-leaf-package",
      severity: "error",
      comment: "db 仅可依赖自身与 hand-maintained contract/PM schema 叶包。",
      from: { path: "^packages/db/src/" },
      to: {
        path: "^packages/(?!db/|contract-ts/|pm-schema/)[^/]+/src/",
      },
    },
    {
      name: "core-observability-is-leaf",
      severity: "error",
      comment: "observability 只能依赖自身、types 或 utils，不得回引业务层或组合根。",
      from: { path: "^packages/core/src/observability/" },
      to: { path: "^packages/core/src/(?!observability/|types/|utils/)" },
    },
    {
      name: "core-types-utils-are-leaves",
      severity: "error",
      comment: "types/utils 只能互相依赖，不得回引其他 core 层。",
      from: { path: "^packages/core/src/(types|utils)/" },
      to: { path: "^packages/core/src/(?!types/|utils/)" },
    },
    {
      name: "core-prompts-import-only",
      severity: "error",
      comment: "prompts 是被引用的叶层，不得新增对其他 core 层的依赖。",
      from: {
        path: "^packages/core/src/prompts/",
        pathNot: "^packages/core/src/prompts/system[.]ts$",
      },
      to: { path: "^packages/core/src/(?!prompts/)" },
    },
    {
      name: "freeze-system-prompt-runtime-capability-edge",
      severity: "error",
      comment: "存量冻结：system prompt 需要运行时沙箱能力文案；能力探测后续改为组合根注入。",
      from: { path: "^packages/core/src/prompts/system[.]ts$" },
      to: {
        path: "^packages/core/src/(?!prompts/)",
        pathNot: "^packages/core/src/workspace/runtimeCapabilities[.]ts$",
      },
    },
    {
      name: "web-page-data-no-components",
      severity: "error",
      comment: "页面 data 层不得依赖展示组件。",
      from: { path: "^apps/web/src/pages/[^/]+/data/" },
      to: { path: "^apps/web/src/components/" },
    },
  ],
  options: {
    includeOnly: "^(packages|apps)/[^/]+/src/",
    doNotFollow: {
      path: "node_modules",
      dependencyTypes: [
        "npm",
        "npm-dev",
        "npm-optional",
        "npm-peer",
        "npm-bundled",
        "npm-no-pkg",
      ],
    },
    combinedDependencies: true,
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".js", ".jsx", ".ts", ".tsx", ".d.ts"],
    },
  },
};

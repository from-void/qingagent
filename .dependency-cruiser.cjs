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
      name: "core-lower-layers-no-bridge",
      severity: "error",
      comment: "core 的 db/llm/tools/workspace/browser 低层不得新增对 bridge 组合层的依赖。",
      from: {
        path: "^packages/core/src/(db|llm|tools|workspace|browser)/",
        pathNot: [
          "(^|/)__tests__/",
          "^packages/core/src/llm/todoAwarenessPrompt[.]ts$",
          "^packages/core/src/tools/parseFile[.]ts$",
          "^packages/core/src/tools/writeDraft[.]ts$",
          "^packages/core/src/browser/agentBrowser[.]ts$",
          "^packages/core/src/db/migrateThreadMetadataToDocuments[.]ts$",
        ],
      },
      to: { path: "^packages/core/src/bridge/" },
    },
    {
      name: "freeze-todo-awareness-bridge-edge",
      severity: "error",
      comment: "存量冻结：todoAwarenessPrompt 读取 bridge 的会话 todo 快照；待上下文归属统一后再下沉。",
      from: { path: "^packages/core/src/llm/todoAwarenessPrompt[.]ts$" },
      to: {
        path: "^packages/core/src/bridge/",
        pathNot: "^packages/core/src/bridge/todoAwareness[.]ts$",
      },
    },
    {
      name: "freeze-parse-file-bridge-edge",
      severity: "error",
      comment: "存量冻结：parseFile 仍通过 bridge 的上传文件解析器兼容旧会话附件；后续随附件链路分层。",
      from: { path: "^packages/core/src/tools/parseFile[.]ts$" },
      to: {
        path: "^packages/core/src/bridge/",
        pathNot: "^packages/core/src/bridge/uploadFileResolver[.]ts$",
      },
    },
    {
      name: "freeze-write-draft-session-state-type-edge",
      severity: "error",
      comment: "存量冻结：writeDraft 仅以 type-only 方式读取会话状态；契约下沉需与后续物理分包一并处理。",
      from: { path: "^packages/core/src/tools/writeDraft[.]ts$" },
      to: {
        path: "^packages/core/src/bridge/",
        pathNot: "^packages/core/src/bridge/sessionState[.]ts$",
      },
    },
    {
      name: "freeze-agent-browser-bridge-edge",
      severity: "error",
      comment: "存量冻结：agentBrowser 读取 bridge 的草稿特性开关；开关尚未迁到独立配置层。",
      from: { path: "^packages/core/src/browser/agentBrowser[.]ts$" },
      to: {
        path: "^packages/core/src/bridge/",
        pathNot: "^packages/core/src/bridge/draftFeatureFlags[.]ts$",
      },
    },
    {
      name: "freeze-db-migration-bridge-edges",
      severity: "error",
      comment: "存量冻结：一次性线程迁移复用 bridge 的文档状态机和持久化逻辑；迁移退役前不复制实现。",
      from: { path: "^packages/core/src/db/migrateThreadMetadataToDocuments[.]ts$" },
      to: {
        path: "^packages/core/src/bridge/",
        pathNot: [
          "^packages/core/src/bridge/docStateMachine[.]ts$",
          "^packages/core/src/bridge/threadPersistence[.]ts$",
        ],
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

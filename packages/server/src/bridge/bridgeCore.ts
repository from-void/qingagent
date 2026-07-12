/**
 * 拆分后的 bridge 域统一从这一层读取 core 依赖。
 *
 * Vitest 的 restore 用例会在每个场景前 resetModules 并 mock
 * `@qingagent/core`。若各域并行直连该 mock，异步 mock factory 会重复触发
 * `importActual`，把一次模块恢复放大到数秒。单入口既保持 mock 语义，也让
 * ESM loader 只初始化一次 core 模块。
 */
export * from "@qingagent/core";

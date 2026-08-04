import type { DiagramAdapter, DiagramType } from "./types.js";

/** 由 engine 在模块初始化时注册，低层改写校验只依赖这个无反向依赖的容器。 */
export const registry = {} as Record<DiagramType, DiagramAdapter>;

/**
 * 契约包运行期 schema 子路径导出:`@qingagent/contract-ts/schemas`。
 *
 * 手写 TS 类型(`../*.ts`)仍是**单一真源**;这里的 zod schema 以 `satisfies z.ZodType<T>`
 * + `Expect<Equal<z.infer<...>, T>>` 反向锚定,编译期强制两者不漂移(设计决策 1)。
 * 纯类型 import(`@qingagent/contract-ts`)永远可擦除、不进 bundle;只有显式
 * value-import 本子路径才会把 zod 拉进产物——值/类型边界靠目录物理隔离。
 */
export * from "./common";
export * from "./command";
export * from "./draftMutation";
export * from "./todo";
export type { Equal, Expect } from "./typeAssert";

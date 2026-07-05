/**
 * 编译期类型等价断言工具。
 *
 * `satisfies z.ZodType<T>` 只保证协变方向(schema 的输出可赋给 T);为防止 schema
 * 与手写契约类型双向漂移,每个 schema 额外配一条 `Expect<Equal<z.infer<...>, T>>`
 * 强制两者严格等价——一旦漂移,`pnpm -r typecheck` 立刻变红。
 *
 * 先例:pm-schema `schemaSync.test.ts` 用运行期断言锚定 schema 与契约;这里用编译期
 * 类型断言锚定,零运行时开销。
 */

/** 两个类型严格相等时求值为 `true`,否则 `false`(基于条件类型恒等技巧)。 */
export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

/** 仅当 `T` 为 `true` 时通过编译;传入 `false` 即触发 typecheck 报错。 */
export type Expect<T extends true> = T;

import { describe, expect, it } from "vitest";
import type {
  PmDoc as ContractPmDoc,
  PmMark as ContractPmMark,
  PmNode as ContractPmNode,
} from "@qingagent/contract-ts";
import type { Equal, Expect } from "@qingagent/contract-ts/schemas";
import type {
  PmDoc as CanonicalPmDoc,
  PmMark as CanonicalPmMark,
  PmNode as CanonicalPmNode,
} from "../types";

// contract-ts 是 wire 手写镜像，pm-schema 是编辑器/持久化权威类型。三条递归等价
// 断言覆盖全部节点、全部 marks 与 doc 根；任一侧新增/改 attrs 都会让 typecheck 失败。
type _PmNodeExact = Expect<Equal<ContractPmNode, CanonicalPmNode>>;
type _PmDocExact = Expect<Equal<ContractPmDoc, CanonicalPmDoc>>;
type _PmMarkExact = Expect<Equal<ContractPmMark, CanonicalPmMark>>;

describe("contract-ts PM 递归结构镜像", () => {
  it("由编译期断言覆盖全部节点、marks 与 doc 根", () => {
    expect(true).toBe(true);
  });
});

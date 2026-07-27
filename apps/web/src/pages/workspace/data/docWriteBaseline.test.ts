import { describe, expect, it } from "vitest";
import { getPmContentHash, normalizePmDoc, type PmDoc } from "@qingagent/pm-schema";
import { canonicalDocWriteBaseline } from "./docWriteBaseline";
import { pmDocToViewDocumentSnapshot } from "./protocol";
import { viewDocToPm } from "./viewDocHtml";

// 回归:乐观锁基线必须按服务端 canonical 原样计算。装载侧安全网(mermaid 代码块升级为图表块、
// 嵌套表格展平)只改编辑器里看到的正文;若拿变换后的正文算 baseContentHash,该文档的任何一次
// 写入(哪怕只是图表块回写 attrs.svg 这种纯读副产物)都会被判文档冲突,而重载拿回的还是同一份
// canonical → "文档已被更新，请重载"无限复现。
function docWith(nodes: unknown[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content: nodes } as unknown as PmDoc;
}

function expectBaselineMatchesCanonical(doc: PmDoc, version: number) {
  const canonical = normalizePmDoc(doc);
  const snapshot = pmDocToViewDocumentSnapshot(canonical, version);
  const baseline = canonicalDocWriteBaseline(snapshot, viewDocToPm);
  expect(baseline.expectedDocumentSnapshot).toBe(version);
  expect(baseline.baseContentHash).toBe(getPmContentHash(canonical));
  return baseline;
}

describe("canonicalDocWriteBaseline", () => {
  it("普通图表块文档的基线哈希与服务端 canonical 一致", () => {
    const baseline = expectBaselineMatchesCanonical(
      docWith([
        { type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text: "正文" }] },
        { type: "diagram", attrs: { blockId: "d-1", lang: "mermaid", source: "flowchart TD\n  A[开始] --> B[结束]\n", svg: null } },
      ]),
      7,
    );
    expect(baseline.baseHasSubstantiveContent).toBe(true);
  });

  it("服务端仍存 mermaid 代码块时,基线不被装载侧的图表块升级带偏", () => {
    expectBaselineMatchesCanonical(
      docWith([
        { type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text: "正文" }] },
        {
          type: "codeBlock",
          attrs: { blockId: "c-1", language: "mermaid" },
          content: [{ type: "text", text: "flowchart TD\n  A[开始] --> B[结束]" }],
        },
      ]),
      7,
    );
  });

  it("带 svg/overlay 的图表块文档同样稳定", () => {
    expectBaselineMatchesCanonical(
      docWith([
        {
          type: "diagram",
          attrs: {
            blockId: "d-1",
            lang: "mermaid",
            source: "flowchart TD\n  A[甲]\n",
            svg: "<svg><text>x</text></svg>",
            overlay: { positions: { A: { x: 1, y: 2 } } },
          },
        },
      ]),
      3,
    );
  });

  it("快照只有 legacy sections(无 pmDoc)时回退到既有转换", () => {
    const baseline = canonicalDocWriteBaseline(
      { version: 2, sections: [], pmDoc: null } as unknown as Parameters<typeof canonicalDocWriteBaseline>[0],
      viewDocToPm,
    );
    expect(baseline.expectedDocumentSnapshot).toBe(2);
    expect(baseline.baseHasSubstantiveContent).toBe(false);
  });
});

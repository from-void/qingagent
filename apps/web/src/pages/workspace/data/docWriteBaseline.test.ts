import { describe, expect, it } from "vitest";
import { getPmContentHash, normalizePmDoc, type PmDoc } from "@qingagent/pm-schema";
import type { BridgeFrame } from "@qingagent/contract-ts";
import {
  EMPTY_PM_DOC_CONTENT_HASH,
  MAX_SILENT_DOC_CONFLICT_REPLAYS,
  appliedDocWriteBaseline,
  canonicalDocWriteBaseline,
  createKnownDocVersionLedger,
  isEmptyScaffoldConflict,
  resolveDocWriteConflict,
  type DocWriteBaseline,
} from "./docWriteBaseline";
import { appliedDocVersionFromBroadcastFrame } from "./docWriteResultOwnership";
import { initialWorkspaceState, workspaceReducer } from "./workspaceState";
import { pmDocToViewDocumentSnapshot } from "./protocol";
import { viewDocToPm } from "./viewDocHtml";

const emptyDoc: PmDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [],
};
const textDoc: PmDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [{
    type: "paragraph",
    attrs: { blockId: "p-1" },
    content: [{ type: "text", text: "用户输入" }],
  }],
};
const emptyBaseline: DocWriteBaseline = {
  expectedDocumentSnapshot: 0,
  baseContentHash: "pmv1-empty",
  baseHasSubstantiveContent: false,
};

describe("isEmptyScaffoldConflict", () => {
  it("空基线的空脚手架冲突可静默拉取权威快照", () => {
    expect(isEmptyScaffoldConflict({
      baseline: emptyBaseline,
      submittedDoc: emptyDoc,
      queuedDoc: null,
    })).toBe(true);
  });

  it("提交或排队中含用户正文时绝不进入静默覆盖路径", () => {
    expect(isEmptyScaffoldConflict({
      baseline: emptyBaseline,
      submittedDoc: textDoc,
      queuedDoc: null,
    })).toBe(false);
    expect(isEmptyScaffoldConflict({
      baseline: emptyBaseline,
      submittedDoc: emptyDoc,
      queuedDoc: textDoc,
    })).toBe(false);
  });

  it("从有正文基线删除到空也保留为用户冲突", () => {
    expect(isEmptyScaffoldConflict({
      baseline: { ...emptyBaseline, baseHasSubstantiveContent: true },
      submittedDoc: emptyDoc,
      queuedDoc: null,
    })).toBe(false);
  });
});


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

  it("version 0(服务端尚无 canonical)按空文档记基线,不拿本地空段落脚手架算哈希", () => {
    // 新建文档时本地先摆一个带 blockId 的空段落脚手架;服务端首写比对的是空文档。
    // 拿脚手架算哈希会让首写必冲突 → 文档永远建不出来,之后每一笔(含图表块回写 svg)连锁冲突。
    const scaffold = docWith([
      { type: "paragraph", attrs: { blockId: "ai-block-1" }, content: [] },
    ]);
    const snapshot = pmDocToViewDocumentSnapshot(normalizePmDoc(scaffold), 0);
    const baseline = canonicalDocWriteBaseline(snapshot, viewDocToPm);
    expect(baseline.expectedDocumentSnapshot).toBe(0);
    expect(baseline.baseContentHash).toBe(EMPTY_PM_DOC_CONTENT_HASH);
    expect(baseline.baseHasSubstantiveContent).toBe(false);
    // 与服务端首写时构造的空文档同形
    expect(EMPTY_PM_DOC_CONTENT_HASH).toBe(getPmContentHash(normalizePmDoc(
      { type: "doc", attrs: { schemaVersion: 1 }, content: [] } as unknown as PmDoc,
    )));
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

describe("resolveDocWriteConflict", () => {
  const selfWriteBaseline: DocWriteBaseline = {
    expectedDocumentSnapshot: 8,
    baseContentHash: "pmv1-self-8",
    baseHasSubstantiveContent: true,
  };
  const base = {
    conflict: { expectedDocumentSnapshot: 7, actualDocumentSnapshot: 8 },
    isLatestOwnMutation: true,
    hasSubmittedDoc: true,
    knownActualVersion: {
      baseline: selfWriteBaseline,
      origin: "selfWrite" as const,
    },
    replayedAgainstActual: false,
    replayDepth: 0,
  };

  it("服务端现版本正是自己上一笔写出的版本时静默重放", () => {
    // 图表可视化写回立即发、正文防抖保存 400ms 后发,后者基线取自更早版本→追尾。
    expect(resolveDocWriteConflict(base)).toEqual({
      kind: "silentReplay",
      baseline: selfWriteBaseline,
    });
  });

  it("服务端版本本会话从未产出(真外部并发)时弹横幅", () => {
    expect(resolveDocWriteConflict({ ...base, knownActualVersion: null })).toEqual({
      kind: "surface",
    });
  });

  it("同一版本重放过还冲突就不再打转", () => {
    expect(resolveDocWriteConflict({ ...base, replayedAgainstActual: true })).toEqual({
      kind: "surface",
    });
  });

  it("连续静默重放有上限", () => {
    expect(resolveDocWriteConflict({
      ...base,
      replayDepth: MAX_SILENT_DOC_CONFLICT_REPLAYS,
    })).toEqual({ kind: "surface" });
  });

  it("缺少可重放内容或不是本标签最新一笔时不重放", () => {
    expect(resolveDocWriteConflict({ ...base, hasSubmittedDoc: false })).toEqual({ kind: "surface" });
    expect(resolveDocWriteConflict({ ...base, isLatestOwnMutation: false })).toEqual({ kind: "surface" });
    expect(resolveDocWriteConflict({ ...base, conflict: null })).toEqual({ kind: "surface" });
  });

  it("基线版本不低于服务端版本(非追尾)不走重放", () => {
    expect(resolveDocWriteConflict({
      ...base,
      conflict: { expectedDocumentSnapshot: 8, actualDocumentSnapshot: 8 },
    })).toEqual({ kind: "surface" });
  });
});

describe("createKnownDocVersionLedger", () => {
  it("按版本号索引,重复登记以最新一次为准", () => {
    const ledger = createKnownDocVersionLedger();
    ledger.remember(
      { expectedDocumentSnapshot: 3, baseContentHash: "pmv1-a", baseHasSubstantiveContent: true },
      "streamApply",
    );
    ledger.remember(
      { expectedDocumentSnapshot: 3, baseContentHash: "pmv1-b", baseHasSubstantiveContent: true },
      "selfWrite",
    );
    expect(ledger.get(3)).toEqual({
      baseline: { expectedDocumentSnapshot: 3, baseContentHash: "pmv1-b", baseHasSubstantiveContent: true },
      origin: "selfWrite",
    });
    expect(ledger.get(4)).toBeNull();
  });

  it("版本 0 不是产出(服务端还没有这份文档),不登记", () => {
    const ledger = createKnownDocVersionLedger();
    ledger.remember(
      { expectedDocumentSnapshot: 0, baseContentHash: EMPTY_PM_DOC_CONTENT_HASH, baseHasSubstantiveContent: false },
      "selfWrite",
    );
    expect(ledger.get(0)).toBeNull();
    expect(ledger.size).toBe(0);
  });

  it("容量有界,淘汰最旧版本", () => {
    const ledger = createKnownDocVersionLedger(2);
    for (const version of [1, 2, 3]) {
      ledger.remember(
        { expectedDocumentSnapshot: version, baseContentHash: `pmv1-${version}`, baseHasSubstantiveContent: true },
        "streamApply",
      );
    }
    expect(ledger.size).toBe(2);
    expect(ledger.get(1)).toBeNull();
    expect(ledger.get(3)).not.toBeNull();
  });

  it("切会话后清空,旧文档版本号不再被当自产", () => {
    const ledger = createKnownDocVersionLedger();
    ledger.remember(
      { expectedDocumentSnapshot: 5, baseContentHash: "pmv1-5", baseHasSubstantiveContent: true },
      "streamApply",
    );
    ledger.clear();
    expect(ledger.get(5)).toBeNull();
  });
});

// 回归(战役缺陷#2):AI 生成文档落为 v1(document_versions 仅此一版,actor=agent),
// 客户端随后一笔持 v0 基线的写被判 conflict,弹出"文档已被更新,请重载后继续编辑"——
// 服务器侧根本没有外部并发。根因是已知产出集只认本标签自己的写入回执,agent 经【本会话
// 生成流】产出、且本标签已应用的版本被当成外部并发。
describe("agent 生成流产出的版本不算外部并发", () => {
  const agentDoc: PmDoc = {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      attrs: { blockId: "ai-1" },
      content: [{ type: "text", text: "AI 生成正文" }],
    }],
  } as unknown as PmDoc;

  function generationFinishedFrame(version: number, seq: number): BridgeFrame {
    return {
      kind: "docGenerationEvent",
      data: {
        kind: "generation_finished",
        data: {
          generationId: "gen-1",
          seq,
          prevSeq: seq - 1,
          doc: agentDoc as never,
          finalVersion: version,
          contentHash: `pmv1-agent-${version}`,
        },
      },
    } as BridgeFrame;
  }

  /** 与 useWorkspacePageController 的接线同构:应用帧→登记已知版本;收 conflict→判处置。 */
  function createHarness() {
    const ledger = createKnownDocVersionLedger();
    const replayed = new Set<number>();
    let replayDepth = 0;
    let state = initialWorkspaceState;
    return {
      applyStreamFrame(frame: BridgeFrame) {
        const applied = appliedDocVersionFromBroadcastFrame(frame);
        if (applied) ledger.remember(appliedDocWriteBaseline(applied), "streamApply");
        state = workspaceReducer(state, frame);
      },
      receiveConflict(conflict: { expectedDocumentSnapshot: number; actualDocumentSnapshot: number }) {
        const resolution = resolveDocWriteConflict({
          conflict,
          isLatestOwnMutation: true,
          hasSubmittedDoc: true,
          knownActualVersion: ledger.get(conflict.actualDocumentSnapshot),
          replayedAgainstActual: replayed.has(conflict.actualDocumentSnapshot),
          replayDepth,
        });
        if (resolution.kind === "silentReplay") {
          replayed.add(conflict.actualDocumentSnapshot);
          replayDepth += 1;
          // 静默重放的这条回执不进 reducer,横幅不该出现
          return resolution;
        }
        state = workspaceReducer(state, {
          kind: "docWriteResult",
          data: { ok: false, clientMutationId: "m-1", conflict },
        });
        return resolution;
      },
      get banner() {
        return state.streamError;
      },
      get version() {
        return state.version;
      },
    };
  }

  it("①流应用 v1 后,持 v0 基线的写回执 conflict 静默重放,不弹横幅", () => {
    const harness = createHarness();
    harness.applyStreamFrame(generationFinishedFrame(1, 1));
    expect(harness.version).toBe(1);

    const resolution = harness.receiveConflict({
      expectedDocumentSnapshot: 0,
      actualDocumentSnapshot: 1,
    });

    expect(resolution).toEqual({
      kind: "silentReplay",
      // 重放基线用服务端给的 canonical contentHash,与 canonicalDocWriteBaseline 同口径
      baseline: {
        expectedDocumentSnapshot: 1,
        baseContentHash: "pmv1-agent-1",
        baseHasSubstantiveContent: true,
      },
    });
    expect(harness.banner).toBeNull();
  });

  it("②actual 版本从未经流应用(另一标签/外部 CLI 写入)仍弹横幅", () => {
    const harness = createHarness();
    harness.applyStreamFrame(generationFinishedFrame(1, 1));

    const resolution = harness.receiveConflict({
      expectedDocumentSnapshot: 1,
      actualDocumentSnapshot: 2,
    });

    expect(resolution).toEqual({ kind: "surface" });
    expect(harness.banner).toMatchObject({
      kind: "docWriteConflict",
      actualDocumentSnapshot: 2,
    });
  });

  it("③重放后 actual 又推进但仍是流应用过的版本→继续静默;actual 未知才弹", () => {
    const harness = createHarness();
    harness.applyStreamFrame(generationFinishedFrame(1, 1));
    expect(harness.receiveConflict({
      expectedDocumentSnapshot: 0,
      actualDocumentSnapshot: 1,
    }).kind).toBe("silentReplay");

    // agent 又写了一版并被本标签应用
    harness.applyStreamFrame(generationFinishedFrame(2, 2));
    expect(harness.receiveConflict({
      expectedDocumentSnapshot: 1,
      actualDocumentSnapshot: 2,
    }).kind).toBe("silentReplay");
    expect(harness.banner).toBeNull();

    // 连续冲突且 actual 本会话从未产出 → 弹横幅
    expect(harness.receiveConflict({
      expectedDocumentSnapshot: 2,
      actualDocumentSnapshot: 3,
    }).kind).toBe("surface");
    expect(harness.banner).toMatchObject({
      kind: "docWriteConflict",
      actualDocumentSnapshot: 3,
    });
  });

  it("同一已知版本重放过还冲突(基线口径对不上)立刻交回横幅,不无限重放", () => {
    const harness = createHarness();
    harness.applyStreamFrame(generationFinishedFrame(1, 1));
    expect(harness.receiveConflict({
      expectedDocumentSnapshot: 0,
      actualDocumentSnapshot: 1,
    }).kind).toBe("silentReplay");

    expect(harness.receiveConflict({
      expectedDocumentSnapshot: 0,
      actualDocumentSnapshot: 1,
    }).kind).toBe("surface");
    expect(harness.banner).toMatchObject({ kind: "docWriteConflict" });
  });
});

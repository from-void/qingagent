import { getPmContentHash, normalizePmDoc, type PmDoc } from "@qingagent/pm-schema";
import { pmDocHasSubstantiveContent } from "./pageExitSave";
import type { ViewDocumentSnapshot } from "./protocol";

/**
 * 编辑事务产生时的 canonical 基线。它必须跟待保存正文一起冻结，不能在真正发包时
 * 从全局 ref 重新读取；否则 agent/外标签先推进版本后，陈旧正文会被误绑到新基线。
 */
export interface DocWriteBaseline {
  expectedDocumentSnapshot: number;
  baseContentHash: string;
  baseHasSubstantiveContent: boolean;
}

export type EditorDocChange = (
  doc: PmDoc,
  baseline?: DocWriteBaseline,
) => void | Promise<void>;

/**
 * 服务端首写时构造的空文档:version 0 的乐观锁基线以它为准(与 commitDocumentOp 的 emptyPmDoc 同形)。
 */
export const EMPTY_PM_DOC: PmDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [],
} as unknown as PmDoc;

export const EMPTY_PM_DOC_CONTENT_HASH = getPmContentHash(EMPTY_PM_DOC);

/**
 * 乐观锁基线只能按【服务端 canonical 原样】计算。装载侧安全网(把伪装成代码块的 Mermaid
 * 升级回图表块、展平嵌套表格)改的是编辑器里看到的正文,并不代表服务端已经存成那样;
 * 拿变换后的正文算 baseContentHash,会与服务端 contentHash 永远对不上——该文档的任何一次
 * 写入都被判冲突,而重载拿回的还是同一份 canonical,冲突永远复现(纯读也会因图表块回写
 * attrs.svg 触发一次写入而弹提示)。
 */
export function canonicalBaselinePmDoc(
  doc: ViewDocumentSnapshot,
  fallback: (doc: ViewDocumentSnapshot) => PmDoc,
): PmDoc {
  return normalizePmDoc(doc.pmDoc ?? fallback(doc));
}

export function canonicalDocWriteBaseline(
  doc: ViewDocumentSnapshot,
  fallback: (doc: ViewDocumentSnapshot) => PmDoc,
): DocWriteBaseline {
  // version 0 = 服务端还没有这份文档,它首写时拿来比对的是空文档;
  // 而本地这时通常已经摆着一个带 blockId 的空段落脚手架,拿脚手架算 hash 与服务端对不上
  // → 首写必冲突,文档永远建不出来,之后每一笔(含图表块回写 attrs.svg)都跟着冲突。
  if (doc.version === 0) {
    return {
      expectedDocumentSnapshot: 0,
      baseContentHash: EMPTY_PM_DOC_CONTENT_HASH,
      baseHasSubstantiveContent: false,
    };
  }
  const canonical = canonicalBaselinePmDoc(doc, fallback);
  return {
    expectedDocumentSnapshot: doc.version,
    baseContentHash: getPmContentHash(canonical),
    baseHasSubstantiveContent: pmDocHasSubstantiveContent(canonical),
  };
}

/**
 * 仅“空基线 → 空提交，且没有排队中的实质输入”可静默丢弃并拉权威快照。
 * 用户从有内容的正文执行删除，或冲突期间又输入了正文，都必须留在既有冲突保留路径。
 */
export function isEmptyScaffoldConflict(input: {
  baseline: DocWriteBaseline | null;
  submittedDoc: PmDoc | null;
  queuedDoc: PmDoc | null;
}): boolean {
  return Boolean(
    input.baseline &&
    !input.baseline.baseHasSubstantiveContent &&
    input.submittedDoc &&
    !pmDocHasSubstantiveContent(input.submittedDoc) &&
    (!input.queuedDoc || !pmDocHasSubstantiveContent(input.queuedDoc)),
  );
}

/**
 * 一个已知版本是怎么来的:
 * - selfWrite:本标签自己的 updateDoc 回执产出的版本;
 * - streamApply:本会话生成流(agent 写文档)推进、且本标签已经把它应用到编辑器的版本。
 * - streamConflict:本会话生成流已推进，但本标签为保护本地编辑暂未应用的版本。
 * 三者都不是"外部并发"——用户眼里 agent 往自己正开着的文档里写,天经地义。
 */
export type KnownDocVersionOrigin =
  | "selfWrite"
  | "streamApply"
  | "streamConflict";

export interface KnownDocVersion {
  /** 该版本对应的 canonical 写入基线(可直接拿来重放) */
  baseline: DocWriteBaseline;
  origin: KnownDocVersionOrigin;
}

/**
 * 本会话【已知产出】的文档版本账本(按版本号索引,容量有界的 LRU)。
 * 冲突恢复判定只认它:actual ∈ 账本 → 只是基线取早了,静默改基线重放;
 * actual ∉ 账本(另一浏览器标签 / 外部 qa CLI 写入)→ 才是真外部并发,弹重载横幅。
 */
export interface KnownDocVersionLedger {
  remember(baseline: DocWriteBaseline, origin: KnownDocVersionOrigin): void;
  get(version: number): KnownDocVersion | null;
  clear(): void;
  readonly size: number;
}

export const KNOWN_DOC_VERSION_LEDGER_CAPACITY = 32;

export function createKnownDocVersionLedger(
  capacity: number = KNOWN_DOC_VERSION_LEDGER_CAPACITY,
): KnownDocVersionLedger {
  const entries = new Map<number, KnownDocVersion>();
  return {
    remember(baseline, origin) {
      const version = baseline.expectedDocumentSnapshot;
      // 版本 0 不是"产出",它是"服务端还没有这份文档"的空基线,登记它会让首写冲突被误判为自产。
      if (version <= 0) return;
      // 重复登记要刷新到队尾(Map 保插入序),否则老版本会先于新版本被淘汰。
      entries.delete(version);
      entries.set(version, { baseline, origin });
      while (entries.size > capacity) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    get(version) {
      return entries.get(version) ?? null;
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * 把流里应用下来的一版文档折成写入基线。
 * 服务端给了 canonical contentHash(generation_finished 带)就直接用它,免得本地再算一遍算歪;
 * 没给才按 canonicalDocWriteBaseline 的同一口径(normalizePmDoc + getPmContentHash)自算。
 */
export function appliedDocWriteBaseline(input: {
  version: number;
  pmDoc: PmDoc;
  contentHash?: string;
}): DocWriteBaseline {
  const canonical = normalizePmDoc(input.pmDoc);
  return {
    expectedDocumentSnapshot: input.version,
    baseContentHash: input.contentHash ?? getPmContentHash(canonical),
    baseHasSubstantiveContent: pmDocHasSubstantiveContent(canonical),
  };
}

/** 同一条编辑链最多连续静默重放几次,兜住任何意料外的打转。 */
export const MAX_SILENT_DOC_CONFLICT_REPLAYS = 4;

export type DocWriteConflictResolution =
  | { kind: "silentReplay"; baseline: DocWriteBaseline }
  | { kind: "surface" };

/**
 * 文档写入冲突怎么处置:静默改基线重放,还是弹"文档已被更新"横幅。
 *
 * 冲突的真实成因分两类:
 * 1) 基线取早了——服务端现版本是【本会话自己产出的】:本标签上一笔写入的回执(图表可视化写回
 *    与正文防抖保存互相追尾),或 agent 生成流刚推进、本标签也已应用的那一版。用户视角这都不是
 *    "别人在改我的文档",拿该版本的 canonical 基线重发即可,不该打断用户。
 * 2) 真外部并发——服务端现版本本会话从没见过(另一浏览器标签、外部 qa CLI 写入):保留横幅。
 *
 * 重放只在版本【继续往前走且仍是已知版本】时接着静默;同一版本重放过还冲突,说明基线口径本身
 * 对不上(不是追尾),立刻交回横幅,绝不打转。
 */
export function resolveDocWriteConflict(input: {
  conflict: { expectedDocumentSnapshot: number; actualDocumentSnapshot: number } | null;
  isLatestOwnMutation: boolean;
  hasSubmittedDoc: boolean;
  /** 账本里查到的 actual 版本(null = 本会话从未产出过) */
  knownActualVersion: KnownDocVersion | null;
  /** 是否已经拿这个 actual 版本当基线重放过 */
  replayedAgainstActual: boolean;
  replayDepth: number;
  maxReplayDepth?: number;
}): DocWriteConflictResolution {
  const { conflict } = input;
  const surface: DocWriteConflictResolution = { kind: "surface" };
  if (!conflict || !input.isLatestOwnMutation || !input.hasSubmittedDoc) return surface;
  // 基线不低于服务端版本 = 不是追尾(内容哈希对不上之类),不归重放管
  if (conflict.expectedDocumentSnapshot >= conflict.actualDocumentSnapshot) return surface;
  const known = input.knownActualVersion;
  if (!known) return surface;
  if (input.replayedAgainstActual) return surface;
  const max = input.maxReplayDepth ?? MAX_SILENT_DOC_CONFLICT_REPLAYS;
  if (input.replayDepth >= max) return surface;
  return { kind: "silentReplay", baseline: known.baseline };
}

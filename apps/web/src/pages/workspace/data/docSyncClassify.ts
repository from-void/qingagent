/**
 * 受控编辑器回环:canonical doc 版本变化时,判定该如何把 incoming 文档应用到编辑器。
 *
 * 背景:用户打字 → 防抖回写(forward) → 服务器存盘 → manualDocSaved 把"同一内容
 * (仅 version+1)"写回 canonical doc,触发 doc-sync。这类**自我保存回声**绝不能
 * setContent 整篇重设(TipTap 会把光标甩到文末);只有**真·外部变更**(agent 写作 /
 * 版本回滚 / 审阅落地)才需要 setContent + 选区恢复。
 *
 * 旧实现只用"incoming === 编辑器当前内容"判回声。快打字下会误判:打"abc"防抖保存,
 * 继续打"def"(编辑器已"abcdef"),"abc"的回声(内容仍是 abc)回来时与编辑器当前
 * ("abcdef")不等 → 被当外部变更 → setContent("abc") 把"def"吞掉、光标甩走。
 *
 * 修法:记录所有"已 forward 但尚未确认回声"的自我保存内容键(pendingSelfKeys)。
 * incoming 只要命中其一,就是自我回声(哪怕编辑器之后又超前了),仅同步版本号。
 */
export type IncomingDocVerdict = "echo" | "external";

export interface ClassifyIncomingDocInput {
  /** JSON.stringify(normalizePmDoc(incoming)) —— canonical 传回的文档键 */
  incomingKey: string;
  /** JSON.stringify(normalizePmDoc(editor.getJSON())) —— 编辑器当前内容键 */
  liveKey: string;
  /** 已 forward 上去、尚未确认回声的自我保存内容键(按发出顺序) */
  pendingSelfKeys: readonly string[];
}

export interface ClassifyIncomingDocResult {
  verdict: IncomingDocVerdict;
  /**
   * incoming 命中的 pendingSelfKeys 下标(-1 表示走"与编辑器当前内容一致"的快路径,
   * 或未命中)。命中时调用方应丢弃该下标及更早的在途键(它们已落地)。
   */
  matchedSelfIndex: number;
}

export function classifyIncomingDoc(
  input: ClassifyIncomingDocInput,
): ClassifyIncomingDocResult {
  // 快路径:与编辑器当前内容完全一致 → 自己保存的回声,光标原地不动。
  if (input.incomingKey === input.liveKey) {
    return { verdict: "echo", matchedSelfIndex: -1 };
  }
  // 命中任一在途自我保存内容 → 陈旧自我回声(快打字时编辑器已超前于该回声)。
  const idx = input.pendingSelfKeys.indexOf(input.incomingKey);
  if (idx >= 0) {
    return { verdict: "echo", matchedSelfIndex: idx };
  }
  // 既不等于当前内容、也不是我方发出的任何在途保存 → 真·外部变更。
  return { verdict: "external", matchedSelfIndex: -1 };
}

/** 在途自我保存键队列上限,防快打字无界增长(单飞 + 队列下实际很小)。 */
export const PENDING_SELF_DOC_KEYS_CAP = 12;

/**
 * 把一条新 forward 的自我保存键追加进在途队列(去重相邻重复 + 限长)。
 * 返回新数组(纯函数,便于测试);调用方把它写回 ref。
 */
export function pushPendingSelfDocKey(
  keys: readonly string[],
  key: string,
): string[] {
  if (keys.length > 0 && keys[keys.length - 1] === key) {
    return [...keys];
  }
  const next = [...keys, key];
  if (next.length > PENDING_SELF_DOC_KEYS_CAP) {
    next.splice(0, next.length - PENDING_SELF_DOC_KEYS_CAP);
  }
  return next;
}

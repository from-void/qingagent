// 改动B 审批入场"逐字打字"的纯调度器。
// 把"多通道打字机"的推进逻辑抽成纯函数,便于单测;WorkspacePage 的 effect 只负责
// 按节拍把这里产出的帧序列 apply 到 React state。

/** 一个正在打字的光标:patchId + 它占用的并发通道号(lane,1 起,用于 Agent·N 标签)。 */
export interface RevealCursorInfo {
  id: string;
  lane: number;
}

/** 一帧的快照:已入场的处、各处已打字数、当前正在打字(光标)的处。 */
export interface RevealFrame {
  /** 已"开始入场"(mount 标记)的 patchId。 */
  revealed: string[];
  /** [patchId, 已打字符数] 列表(便于序列化/断言;消费侧转成 Map)。 */
  typed: Array<[string, number]>;
  /** 当前正在打字的光标(可并发多处),带通道号供显示 Agent·N 标签。 */
  cursors: RevealCursorInfo[];
}

/**
 * 算一处 patch 的"新增文案"字数(按 code point,与 DocumentSnapshotView SpanView 的 newPart 对齐)。
 * 纯新增(after 以 before 开头且更长)→ 只数追加部分;其余 → 数 after 全文;纯删除 → 0。
 * 必须与 SpanView 的 newPart 切分逻辑保持一致,否则光标停位会偏。
 */
export function revealNewPartLen(before: string, after: string): number {
  const isAddition =
    before.length > 0 && after.startsWith(before) && after.length > before.length;
  const newPart = isAddition ? after.slice(before.length) : after;
  return Array.from(newPart).length;
}

/**
 * 规划"逐字打字"帧序列。
 *
 * 模型:`concurrency` 个打字头并发工作,每头按 FIFO 取一处、每拍吐 `charsPerTick` 字,
 * 打完该处后取队列下一处。目标字数 ≤ 0 的处(纯删除/无新增)只标记入场、不占打字头(瞬时出现)。
 *
 * - 首帧:首批光标就位、typed=0(先出现光标,再逐字冒出)。
 * - 末帧:所有处 typed=target、cursors 为空。
 *
 * @returns 帧数组,长度 ≥ 1。消费侧:首帧立即 apply,其余按节拍逐帧 apply,末帧后进入收尾停留。
 */
export function planRevealTypewriter(
  ids: readonly string[],
  targetOf: (id: string) => number,
  concurrency: number,
  charsPerTick: number,
): RevealFrame[] {
  const heads = Math.max(1, Math.floor(concurrency));
  const step = Math.max(1, Math.floor(charsPerTick));
  const queue = ids.slice();
  const active: { id: string; typed: number; lane: number }[] = [];
  const typed = new Map<string, number>();
  const revealed = new Set<string>();
  const usedLanes = new Set<number>();

  const targetSafe = (id: string) => Math.max(0, Math.floor(targetOf(id)));

  // 取最小的空闲通道号(1 起)。打字头打完会释放通道,后续头复用,
  // 使并发标签稳定在 Agent·1..Agent·N,不会越编越大。
  const takeLane = (): number => {
    let lane = 1;
    while (usedLanes.has(lane)) lane += 1;
    usedLanes.add(lane);
    return lane;
  };

  const refill = () => {
    while (active.length < heads && queue.length > 0) {
      const id = queue.shift()!;
      revealed.add(id);
      typed.set(id, 0);
      if (targetSafe(id) <= 0) continue; // 纯删除/无新增:不占头
      active.push({ id, typed: 0, lane: takeLane() });
    }
  };

  const snapshot = (): RevealFrame => ({
    revealed: [...revealed],
    typed: [...typed.entries()],
    cursors: active.map((h) => ({ id: h.id, lane: h.lane })),
  });

  const frames: RevealFrame[] = [];
  refill();
  frames.push(snapshot()); // 首帧

  // 防御:即便 target 计算异常也不死循环。每个生产性迭代至少推进 step≥1 字。
  let totalChars = 0;
  for (const id of ids) totalChars += targetSafe(id);
  const guardMax = totalChars + ids.length + 8;

  let guard = 0;
  while ((active.length > 0 || queue.length > 0) && guard <= guardMax) {
    guard++;
    for (const h of active) {
      h.typed += step;
      typed.set(h.id, Math.min(h.typed, targetSafe(h.id)));
    }
    for (let i = active.length - 1; i >= 0; i--) {
      const h = active[i]!;
      if (h.typed >= targetSafe(h.id)) {
        typed.set(h.id, targetSafe(h.id));
        usedLanes.delete(h.lane); // 释放通道供后续头复用
        active.splice(i, 1);
      }
    }
    refill();
    frames.push(snapshot());
  }

  return frames;
}

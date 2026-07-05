// 0603 — 拟人鼠标的通道(lane)→ 名字/颜色 共享映射,供 reveal/native 两场景 + overlay 共用,
// 保证鼠标与打字光标"同色系"、名字一致。名字按百家姓顺序(赵钱孙李周吴郑王)取"小X",按 lane 循环。
export const LANE_NAMES = ["小赵", "小钱", "小孙", "小李", "小周", "小吴", "小郑", "小王"] as const;
// 配本主题(玄青 + 金 + 朱砂 + 赭石)的一套光标色,奶白纸上可辨又和谐(不再用蓝紫玫红等亮色)。
export const LANE_COLORS = [
  "#b58a3e", // 金
  "#cf4636", // 朱砂
  "#3d7a74", // 玄青(青绿)
  "#a86a34", // 赭石/古铜
  "#7d7a45", // 苍黄/橄榄
  "#9a5566", // 绛/酡红
  "#4f6d8c", // 黛蓝(低饱和)
  "#6f5b8e", // 黛紫(低饱和)
] as const;

export function laneName(lane: number): string {
  if (!Number.isFinite(lane) || lane < 1) return "AI";
  return LANE_NAMES[(lane - 1) % LANE_NAMES.length]!;
}

export function laneColor(lane: number): string {
  if (!Number.isFinite(lane) || lane < 1) return LANE_COLORS[0];
  return LANE_COLORS[(lane - 1) % LANE_COLORS.length]!;
}

/** 从 "Agent·3" 之类的标签里取出并发号(全文生成场景的 lane),取不出返回 null。 */
export function laneFromAgentLabel(label: string | null | undefined): number | null {
  if (!label) return null;
  const m = /(\d+)/.exec(label);
  return m ? Number(m[1]) : null;
}

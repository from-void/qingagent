// 字数控制规格:把"目标字数"从裸数字升级为带语义的长度意图。
// 同样的 1500,"左右/不超过/不少于/严格"是四种不同的验收函数;
// 计数口径与编辑器展示同一把尺(默认含标点、不含空白)。
// 设计讨论见诊断报告 p21(软约束无验收家族)。

// 计数实现统一收敛到 @qingagent/pm-schema/charCount(前端字数显示同一把尺),
// 此处 re-export 保持既有 import 路径不变。
import { countVisibleChars, countCharsNoPunct } from "@qingagent/pm-schema";
export { countVisibleChars, countCharsNoPunct };

export type LengthBound = "approx" | "max" | "min" | "exact";
export type LengthUnit = "withPunct" | "noPunct";

export interface LengthSpec {
  /** 用户数值锚点。 */
  target: number;
  /** 约束语义。 */
  bound: LengthBound;
  /** 验收下限(含)。min/approx/exact 为硬下限,max 为软下限。 */
  min: number;
  /** 验收上限(含)。min 语义没有硬上限。 */
  max?: number;
  /** 给 prompt/ranking 用的软上限,绝不参与硬验收。 */
  softMax?: number;
  /** 给生成模型的工作目标(max 留余量 0.9x,min 加冲量 1.1x)。 */
  workingTarget: number;
  /** 计数口径。 */
  unit: LengthUnit;
  /** 最多自动修订轮数(exact=2,其余=1)。 */
  maxRevisions: number;
}

/** approx 默认容差(用户未明说波动幅度时)。跑稳后可收紧到 0.05。 */
export const DEFAULT_APPROX_TOLERANCE_PCT = 0.1;
/** exact("就要 1500 字")的容差。原 0.03 过紧(1500 要落 1455–1545),赛马常因差几十字被判
 *  超限触发第二轮拖慢首稿;放宽到 0.05 给模型合理余量,硬边界(不少于/不超过)仍由 min/max 守。 */
export const EXACT_TOLERANCE_PCT = 0.05;
/** max 约束的软下限比例(说"不超过1500"也不能只给 400 字糊弄)。 */
export const MAX_BOUND_SOFT_FLOOR = 0.75;
/** min 约束的软上限比例。 */
export const MIN_BOUND_SOFT_CEIL = 1.3;

export interface MakeLengthSpecInput {
  lengthTarget?: number | null;
  lengthBound?: LengthBound | null;
  lengthTolerancePct?: number | null;
  lengthUnit?: LengthUnit | null;
  /** 用户给出明确字数区间时的下/上限(如"3000到3800字")。两者都给且 0<min<max 时
   * 直接作为硬验收区间,不再折成中点±容差(否则内部带会比用户区间窄,区间内的稿被误判超限反复精简)。 */
  lengthMin?: number | null;
  lengthMax?: number | null;
  /** 旧字段兼容:仅传 targetLength 时按 approx 处理。 */
  targetLength?: number | null;
}

function validRangeBound(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

export function makeLengthSpec(input: MakeLengthSpecInput): LengthSpec | null {
  const unit: LengthUnit = input.lengthUnit ?? "withPunct";

  // 显式区间优先:用户说"A到B字"时,验收区间就是 [A,B] 本身(尊重用户原始区间)。
  // 修复 gen-wordcount-internal-gate-narrower:此前模型把区间折成中点 lengthTarget + approx±10%,
  // 内部带(如 3060-3740)比用户区间(3000-3800)窄,落在用户区间内的首稿(3760)被判超限触发不必要精简。
  if (validRangeBound(input.lengthMin) && validRangeBound(input.lengthMax) && input.lengthMin < input.lengthMax) {
    const mid = Math.round((input.lengthMin + input.lengthMax) / 2);
    return {
      target: mid,
      bound: "approx",
      min: Math.round(input.lengthMin),
      max: Math.round(input.lengthMax),
      workingTarget: mid,
      unit,
      maxRevisions: 1,
    };
  }

  const target = input.lengthTarget ?? input.targetLength ?? null;
  if (typeof target !== "number" || !Number.isFinite(target) || target <= 0) return null;

  const bound: LengthBound = input.lengthBound ?? "approx";
  const tol =
    typeof input.lengthTolerancePct === "number" && input.lengthTolerancePct > 0
      ? Math.min(input.lengthTolerancePct, 0.5)
      : bound === "exact"
        ? EXACT_TOLERANCE_PCT
        : DEFAULT_APPROX_TOLERANCE_PCT;

  switch (bound) {
    case "max":
      return {
        target,
        bound,
        min: Math.round(target * MAX_BOUND_SOFT_FLOOR),
        max: target, // 硬上限
        workingTarget: Math.round(target * 0.9),
        unit,
        maxRevisions: 1,
      };
    case "min":
      return {
        target,
        bound,
        min: target, // 硬下限
        softMax: Math.round(target * MIN_BOUND_SOFT_CEIL),
        workingTarget: Math.round(target * 1.1),
        unit,
        maxRevisions: 1,
      };
    case "exact":
      return {
        target,
        bound,
        min: Math.round(target * (1 - tol)),
        max: Math.round(target * (1 + tol)),
        workingTarget: target,
        unit,
        maxRevisions: 2,
      };
    case "approx":
    default:
      return {
        target,
        bound: "approx",
        min: Math.round(target * (1 - tol)),
        max: Math.round(target * (1 + tol)),
        workingTarget: target,
        unit,
        maxRevisions: 1,
      };
  }
}

export function countByUnit(text: string, unit: LengthUnit): number {
  return unit === "noPunct" ? countCharsNoPunct(text) : countVisibleChars(text);
}

/**
 * 把用户指定的计数 unit 换算成终态 canonical（含标点）口径。
 *
 * 换算比来自同一份候选正文，因此 `canonicalCount` 对换算后规格的验收结论，
 * 与原 unit 对 `unitCount` 的语义等价；终态展示的数字和区间也不会再混用两把尺。
 */
export function convertLengthSpecToCanonical(
  spec: LengthSpec,
  unitCount: number,
  canonicalCount: number,
): LengthSpec {
  if (spec.unit === "withPunct") return spec;

  const scale = unitCount > 0
    ? canonicalCount / unitCount
    : canonicalCount > 0
      ? canonicalCount + 1
      : 1;
  const convert = (value: number): number => Math.round(value * scale);
  return {
    ...spec,
    target: convert(spec.target),
    min: convert(spec.min),
    ...(typeof spec.max === "number" ? { max: convert(spec.max) } : {}),
    ...(typeof spec.softMax === "number" ? { softMax: convert(spec.softMax) } : {}),
    workingTarget: convert(spec.workingTarget),
    unit: "withPunct",
  };
}

export function withinSpec(count: number, spec: LengthSpec): boolean {
  switch (spec.bound) {
    case "min":
      return count >= spec.min;
    case "max":
      return typeof spec.max === "number" ? count <= spec.max : true;
    case "exact":
    case "approx":
    default:
      return count >= spec.min && typeof spec.max === "number" && count <= spec.max;
  }
}

export type LengthStatus =
  | "not_requested"
  | "accepted_first_pass"
  | "accepted_after_revision"
  | "accepted_with_soft_warning"
  | "below_min"
  | "above_hard_max"
  | "near_after_revision"
  | "failed_after_revision";

function hardFailureStatus(count: number, spec: LengthSpec): "below_min" | "above_hard_max" | null {
  switch (spec.bound) {
    case "min":
      return count < spec.min ? "below_min" : null;
    case "max":
      return typeof spec.max === "number" && count > spec.max ? "above_hard_max" : null;
    case "exact":
    case "approx":
    default:
      if (count < spec.min) return "below_min";
      if (typeof spec.max === "number" && count > spec.max) return "above_hard_max";
      return null;
  }
}

function hasSoftLengthWarning(count: number, spec: LengthSpec): boolean {
  return spec.bound === "min" && typeof spec.softMax === "number" && count > spec.softMax;
}

export function getLengthStatus(
  firstCount: number,
  finalCount: number,
  spec: LengthSpec | null,
  revisionCount: number,
): LengthStatus {
  if (!spec) return "not_requested";
  const count = revisionCount === 0 ? firstCount : finalCount;
  const failure = hardFailureStatus(count, spec);
  if (failure) return failure;
  if (hasSoftLengthWarning(count, spec)) return "accepted_with_soft_warning";
  return revisionCount === 0 ? "accepted_first_pass" : "accepted_after_revision";
}

/** 给提示词用的人话描述。 */
export function describeLengthSpec(spec: LengthSpec): string {
  const unitText = spec.unit === "noPunct" ? "不含标点(只数汉字/字母/数字)" : "含标点、不含空白";
  const boundText =
    spec.bound === "max"
      ? `不得超过 ${spec.max} 字(硬上限),建议写到约 ${spec.workingTarget} 字,尽量不少于 ${spec.min} 字`
      : spec.bound === "min"
        ? `不得少于 ${spec.min} 字(硬下限),建议写到约 ${spec.workingTarget} 字,软建议不超过 ${spec.softMax} 字;超过建议篇幅不算失败`
        : `目标 ${spec.target} 字,必须落入 ${spec.min}-${spec.max} 字`;
  return `${boundText};计数口径:正文可见字符,${unitText},不含空白/换行/JSON 字段名`;
}

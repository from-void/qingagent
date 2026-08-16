import { describe, expect, it } from "vitest";
import {
  countCharsNoPunct,
  countVisibleChars,
  convertLengthSpecToCanonical,
  getLengthStatus,
  makeLengthSpec,
  withinSpec,
} from "../utils/lengthSpec.js";

// p21 字数控制:长度意图规格化(approx/max/min/exact)+ 统一计数口径

describe("countVisibleChars 计数口径(含标点不含空白)", () => {
  it("中文+标点都算,空白换行不算", () => {
    expect(countVisibleChars("你好，世界。")).toBe(6);
    expect(countVisibleChars("你好 ，\n世界\t。 ")).toBe(6);
  });
  it("中英混排与数字", () => {
    expect(countVisibleChars("GPT-5 发布了！")).toBe(9);
  });
  it("emoji/代理对按码点数,不会数错", () => {
    // "𝒳" 是代理对,String.length=2 但应数 1
    expect(countVisibleChars("𝒳a")).toBe(2);
  });
  it("不含标点口径只数汉字字母数字", () => {
    expect(countCharsNoPunct("你好，世界。abc123！")).toBe(10);
  });
  it("不含标点口径统一覆盖各语种 Unicode 字母与数字", () => {
    expect(countCharsNoPunct("日本語，한국어 café １２３！")).toBe(13);
  });
});

describe("lengthSpec canonical 换算", () => {
  it("不含标点规格按候选正文比例换成 canonical 区间", () => {
    const spec = makeLengthSpec({ lengthTarget: 100, lengthUnit: "noPunct" })!;

    expect(convertLengthSpecToCanonical(spec, 100, 120)).toMatchObject({
      target: 120,
      min: 108,
      max: 132,
      workingTarget: 120,
      unit: "withPunct",
    });
  });

  it("正文只有标点时不会把正数字数下限误判为已满足", () => {
    const spec = makeLengthSpec({ lengthTarget: 10, lengthUnit: "noPunct" })!;
    const canonical = convertLengthSpecToCanonical(spec, 0, 20);

    expect(withinSpec(20, canonical)).toBe(false);
  });
});

describe("makeLengthSpec 四种 bound 语义", () => {
  it("approx 默认 ±10%", () => {
    const spec = makeLengthSpec({ lengthTarget: 1500 })!;
    expect(spec.bound).toBe("approx");
    expect(spec.min).toBe(1350);
    expect(spec.max).toBe(1650);
    expect(spec.workingTarget).toBe(1500);
    expect(spec.maxRevisions).toBe(1);
  });
  it("max:硬上限+软下限 0.75,工作目标留余量 0.9", () => {
    const spec = makeLengthSpec({ lengthTarget: 1500, lengthBound: "max" })!;
    expect(spec.max).toBe(1500);
    expect(spec.min).toBe(1125);
    expect(spec.workingTarget).toBe(1350);
  });
  it("min:只有硬下限,软上限仅用于提示和排序", () => {
    const spec = makeLengthSpec({ lengthTarget: 1500, lengthBound: "min" })!;
    expect(spec.min).toBe(1500);
    expect(spec.max).toBeUndefined();
    expect(spec.softMax).toBe(1950);
    expect(spec.workingTarget).toBe(1650);
  });
  it("exact:±5% 且允许修订 2 轮", () => {
    const spec = makeLengthSpec({ lengthTarget: 1500, lengthBound: "exact" })!;
    expect(spec.min).toBe(1425);
    expect(spec.max).toBe(1575);
    expect(spec.maxRevisions).toBe(2);
  });
  it("用户明说容差时覆盖默认", () => {
    const spec = makeLengthSpec({ lengthTarget: 1500, lengthTolerancePct: 0.067 })!;
    expect(spec.min).toBe(1400);
    expect(spec.max).toBe(1601);
  });
  it("旧字段 targetLength 兼容为 approx", () => {
    const spec = makeLengthSpec({ targetLength: 800 })!;
    expect(spec.bound).toBe("approx");
    expect(spec.target).toBe(800);
  });
  it("无目标返回 null", () => {
    expect(makeLengthSpec({})).toBeNull();
    expect(makeLengthSpec({ lengthTarget: 0 })).toBeNull();
  });
});

describe("makeLengthSpec 显式区间(回归 gen-wordcount-internal-gate-narrower)", () => {
  it("给 lengthMin/lengthMax 时验收区间就是用户区间本身,不收窄成中点±10%", () => {
    const spec = makeLengthSpec({ lengthMin: 3000, lengthMax: 3800 })!;
    expect(spec.bound).toBe("approx");
    expect(spec.min).toBe(3000);
    expect(spec.max).toBe(3800);
    expect(spec.target).toBe(3400); // 中点仅作工作目标
    expect(spec.workingTarget).toBe(3400);
  });
  it("核心回归:落在用户区间内的稿(3760)不再被判超限(此前折成3060-3740会误杀)", () => {
    const spec = makeLengthSpec({ lengthMin: 3000, lengthMax: 3800 })!;
    expect(withinSpec(3760, spec)).toBe(true); // bug 前:内部上限 3740 → false
    expect(withinSpec(3000, spec)).toBe(true);
    expect(withinSpec(3800, spec)).toBe(true);
    expect(withinSpec(2999, spec)).toBe(false);
    expect(withinSpec(3801, spec)).toBe(false);
  });
  it("显式区间优先于 lengthTarget(两者都给时用区间)", () => {
    const spec = makeLengthSpec({ lengthTarget: 1000, lengthMin: 3000, lengthMax: 3800 })!;
    expect(spec.min).toBe(3000);
    expect(spec.max).toBe(3800);
  });
  it("非法区间(min>=max 或缺一个)回落单锚点/null,不误用区间分支", () => {
    expect(makeLengthSpec({ lengthMin: 3800, lengthMax: 3000 })).toBeNull();
    expect(makeLengthSpec({ lengthMin: 3000 })).toBeNull();
    const single = makeLengthSpec({ lengthTarget: 1500, lengthMin: 3000 })!;
    expect(single.min).toBe(1350); // 只给 min 缺 max → 走单锚点 approx
    expect(single.max).toBe(1650);
  });
});

describe("getLengthStatus 验收状态机", () => {
  const spec = makeLengthSpec({ lengthTarget: 1500 })!; // 1350-1650

  it("首轮即达标", () => {
    expect(getLengthStatus(1500, 1500, spec, 0)).toBe("accepted_first_pass");
  });
  it("修订后达标", () => {
    expect(getLengthStatus(2403, 1496, spec, 1)).toBe("accepted_after_revision");
  });
  it("修订后高于硬上限标 above_hard_max", () => {
    expect(withinSpec(1700, spec)).toBe(false);
    expect(getLengthStatus(2403, 1700, spec, 1)).toBe("above_hard_max");
  });
  it("修订后低于硬下限标 below_min", () => {
    expect(getLengthStatus(2403, 1200, spec, 1)).toBe("below_min");
  });
  it("首轮失败也按方向标出硬边界", () => {
    expect(getLengthStatus(2403, 2403, spec, 0)).toBe("above_hard_max");
  });
  it("无 spec 标 not_requested", () => {
    expect(getLengthStatus(2403, 2403, null, 0)).toBe("not_requested");
  });

  it("min bound:2000 字要求下 2900/7395 都 accepted,1999 才 below_min", () => {
    const minSpec = makeLengthSpec({ lengthTarget: 2000, lengthBound: "min" })!;
    expect(withinSpec(2900, minSpec)).toBe(true);
    expect(withinSpec(7395, minSpec)).toBe(true);
    expect(withinSpec(1999, minSpec)).toBe(false);
    expect(getLengthStatus(2900, 2900, minSpec, 0)).toBe("accepted_with_soft_warning");
    expect(getLengthStatus(7395, 7395, minSpec, 0)).toBe("accepted_with_soft_warning");
    expect(getLengthStatus(1999, 1999, minSpec, 0)).toBe("below_min");
  });
});

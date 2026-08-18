// 文末落款区块用的中文格式化:阿拉伯数字 → 中文数字(一千二百…),公历年 → 干支(甲子…),
// 日期 → 「干支年 X月 X日」。纯函数,便于单测(数字转换有零/单位等脏边界)。

const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const;
const SMALL_UNITS = ["", "十", "百", "千"] as const; // 个十百千
const BIG_UNITS = ["", "万", "亿"] as const; // 每 4 位一节

/** 把 0–9999 的一节转中文(不带万/亿),内部零压缩成单个「零」。 */
function sectionToChinese(section: number): string {
  let out = "";
  let zeroPending = false;
  const digits = [
    Math.floor(section / 1000) % 10,
    Math.floor(section / 100) % 10,
    Math.floor(section / 10) % 10,
    section % 10,
  ];
  for (let i = 0; i < 4; i++) {
    const d = digits[i]!;
    const unit = SMALL_UNITS[3 - i]!;
    if (d === 0) {
      zeroPending = out.length > 0; // 前面已有非零,记一个待补的零
    } else {
      if (zeroPending) out += CN_DIGITS[0];
      out += CN_DIGITS[d] + unit;
      zeroPending = false;
    }
  }
  return out;
}

/**
 * 阿拉伯数字 → 中文数字(小写体:一千二百三十四 / 一万零四 …)。支持 0 ~ 99,999,999。
 * 负数取绝对值,非整数取整。
 */
export function numberToChinese(n: number): string {
  if (!Number.isFinite(n)) return "零";
  let v = Math.floor(Math.abs(n));
  if (v === 0) return CN_DIGITS[0];

  // 拆成每 4 位一节(个、万、亿)
  const sections: number[] = [];
  while (v > 0) {
    sections.push(v % 10000);
    v = Math.floor(v / 10000);
  }

  let out = "";
  for (let i = sections.length - 1; i >= 0; i--) {
    const sec = sections[i]!;
    // 超出「万/亿」节(>= 1e12)就退化处理:用不到的量级(字数远不及),但不能输出 "undefined"。
    const big = BIG_UNITS[i] ?? "";
    if (sec === 0) {
      // 整节为 0:若后面还有非零节,需补一个「零」(避免「一万亿」漏零),由下一非零节处理
      continue;
    }
    // 高节与低节之间:低节不足 1000 时要补「零」(一万零四)
    if (out.length > 0 && sec < 1000) out += CN_DIGITS[0];
    out += sectionToChinese(sec) + big;
  }

  // 「一十X」习惯写成「十X」(十二 而不是 一十二)——仅当结果以「一十」开头时
  if (out.startsWith("一十")) out = out.slice(1);
  return out;
}

const TIANGAN = "甲乙丙丁戊己庚辛壬癸";
const DIZHI = "子丑寅卯辰巳午未申酉戌亥";

/** 公历年 → 干支年(甲子…)。1984=甲子(基准:公元 4 年为甲子)。 */
export function ganzhiYear(year: number): string {
  const g = ((year - 4) % 10 + 10) % 10;
  const z = ((year - 4) % 12 + 12) % 12;
  return TIANGAN[g]! + DIZHI[z]!;
}

/**
 * 日 → 中文日名(一日..三十一日)。day 取 1–31。
 *
 * 曾用「初一/廿三」这类古法日名,但**落款算的是公历**,而「初几」「廿几」在中文里
 * 强指农历,会让读者以为这是农历日期。故统一改为「N日」,不带农历暗示。
 * (年仍用干支只是纪年风格,不构成日期歧义。)
 */
export function dayToClassical(day: number): string {
  const d = Math.floor(Math.abs(day));
  if (d < 1) return "";
  return `${numberToChinese(d)}日`;
}

/** 日期 → 「丙午年六月五日」(干支年 + 中文月 + 中文日,紧排无空格)。month 1–12,day 1–31。 */
export function formatColophonDate(year: number, month: number, day: number): string {
  return `${ganzhiYear(year)}年${numberToChinese(month)}月${dayToClassical(day)}`;
}

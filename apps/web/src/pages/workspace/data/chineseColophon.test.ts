import { describe, it, expect } from "vitest";
import { numberToChinese, ganzhiYear, formatColophonDate, dayToClassical } from "./chineseColophon";

describe("numberToChinese(脏边界:零/单位/万亿)", () => {
  it.each([
    [0, "零"],
    [5, "五"],
    [10, "十"],
    [11, "十一"],
    [19, "十九"],
    [20, "二十"],
    [100, "一百"],
    [105, "一百零五"],
    [110, "一百一十"],
    [120, "一百二十"],
    [1000, "一千"],
    [1004, "一千零四"],
    [1040, "一千零四十"],
    [1234, "一千二百三十四"],
    [10000, "一万"],
    [10004, "一万零四"],
    [12345, "一万二千三百四十五"],
    [20300, "二万零三百"],
  ])("%i → %s", (n, expected) => {
    expect(numberToChinese(n)).toBe(expected);
  });

  it("负数取绝对值、小数取整", () => {
    expect(numberToChinese(-12)).toBe("十二");
    expect(numberToChinese(3.9)).toBe("三");
  });

  it("回归:超「亿」量级(>=1e12)不输出 undefined", () => {
    const huge = numberToChinese(1_000_000_000_000);
    expect(huge).not.toContain("undefined");
    expect(huge.length).toBeGreaterThan(0);
  });
});

describe("ganzhiYear", () => {
  it.each([
    [1984, "甲子"],
    [2024, "甲辰"],
    [2026, "丙午"],
    [4, "甲子"],
  ])("%i → %s", (y, expected) => {
    expect(ganzhiYear(y)).toBe(expected);
  });
});

// 落款算的是**公历**,而「初几/廿几」在中文里强指农历,会误导读者;统一为「N日」。
describe("dayToClassical(公历日名:N日,不得出现初/廿)", () => {
  it.each([
    [1, "一日"],
    [5, "五日"],
    [9, "九日"],
    [10, "十日"],
    [11, "十一日"],
    [14, "十四日"],
    [19, "十九日"],
    [20, "二十日"],
    [21, "二十一日"],
    [25, "二十五日"],
    [29, "二十九日"],
    [30, "三十日"],
    [31, "三十一日"],
  ])("%i → %s", (d, expected) => {
    expect(dayToClassical(d)).toBe(expected);
  });

  it("任何一天都不得带农历暗示的「初」或「廿」", () => {
    for (let d = 1; d <= 31; d += 1) {
      expect(dayToClassical(d)).not.toMatch(/[初廿]/);
    }
  });
});

describe("formatColophonDate", () => {
  it("拼成『干支年+中文月+中文日』紧排(无空格)", () => {
    expect(formatColophonDate(2026, 6, 14)).toBe("丙午年六月十四日");
    expect(formatColophonDate(2026, 6, 5)).toBe("丙午年六月五日");
    expect(formatColophonDate(1984, 1, 1)).toBe("甲子年一月一日");
  });
});

import { describe, it, expect } from "vitest";
import { mergeTail, targetDescLine, lengthStatusLabel } from "./DraftMiniCard";

describe("mergeTail 流式尾巴重建全文", () => {
  it("空缓冲 → 首个尾巴原样", () => {
    expect(mergeTail("", "春天来了")).toBe("春天来了");
  });

  it("尾巴与缓冲末尾重叠 → 只追加新增部分", () => {
    // 缓冲已是「...东风来了」,新尾巴「东风来了，春天的脚步近了」
    expect(mergeTail("春天盼望着，东风来了", "东风来了，春天的脚步近了")).toBe(
      "春天盼望着，东风来了，春天的脚步近了",
    );
  });

  it("滚动窗口右移(头部掉字)也能续上", () => {
    // 模拟 tailExcerpt:每次最后 N 字。缓冲 "ABCDEF",新尾巴 "DEFGHI"(重叠 DEF)
    expect(mergeTail("ABCDEF", "DEFGHI")).toBe("ABCDEFGHI");
  });

  it("尾巴完全包含在缓冲末尾(本次没新增)→ 维持不重复", () => {
    expect(mergeTail("春天来了，脚步近了", "脚步近了")).toBe("春天来了，脚步近了");
  });

  it("空尾巴 → 维持缓冲", () => {
    expect(mergeTail("已有内容", "")).toBe("已有内容");
  });

  it("完全无重叠(换赛道/重来)→ 以新尾巴重建,不拼出乱码", () => {
    expect(mergeTail("旧赛道的一整段文字", "全新赛道另起的内容")).toBe("全新赛道另起的内容");
  });

  it("连续增量重放 → 正确重建整段", () => {
    const full = "春天盼望着，盼望着，东风来了，春天的脚步近了。";
    let buf = "";
    // 用窗口大小 8 模拟滚动尾巴,逐字增长喂入
    for (let i = 1; i <= full.length; i++) {
      const tail = full.slice(Math.max(0, i - 8), i);
      buf = mergeTail(buf, tail);
    }
    expect(buf).toBe(full);
  });
});

describe("targetDescLine", () => {
  it("区间 / 单上限 / 单下限 / 自由", () => {
    expect(targetDescLine({ minLength: 1000, maxLength: 1500 } as never)).toBe("目标 1000–1500 字");
    expect(targetDescLine({ minLength: null, maxLength: 1500 } as never)).toBe("目标 1500 字");
    expect(targetDescLine({ minLength: 800, maxLength: null } as never)).toBe("目标 800+ 字");
    expect(targetDescLine({ minLength: null, maxLength: null } as never)).toBe("自由长度");
  });
});

describe("lengthStatusLabel", () => {
  it("达标/略偏/未达/未请求", () => {
    expect(lengthStatusLabel("accepted_first_pass")?.tone).toBe("ok");
    expect(lengthStatusLabel("near_after_revision")?.tone).toBe("warn");
    expect(lengthStatusLabel("failed_after_revision")?.tone).toBe("bad");
    expect(lengthStatusLabel("not_requested")).toBeNull();
    expect(lengthStatusLabel(null)).toBeNull();
  });
});

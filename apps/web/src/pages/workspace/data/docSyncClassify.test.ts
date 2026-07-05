import { describe, expect, it } from "vitest";
import {
  classifyIncomingDoc,
  PENDING_SELF_DOC_KEYS_CAP,
  pushPendingSelfDocKey,
} from "./docSyncClassify";

// 用内容键模拟 JSON.stringify(normalizePmDoc(...)) 的产物;只关心字符串相等关系。
const ABC = '{"doc":"abc"}';
const ABCDEF = '{"doc":"abcdef"}';
const EXTERNAL = '{"doc":"agent wrote this"}';

describe("classifyIncomingDoc —— 受控回环回声 vs 外部变更", () => {
  it("incoming 与编辑器当前内容一致 → 自我回声(快路径,不 setContent)", () => {
    expect(
      classifyIncomingDoc({
        incomingKey: ABC,
        liveKey: ABC,
        pendingSelfKeys: [],
      }),
    ).toEqual({ verdict: "echo", matchedSelfIndex: -1 });
  });

  it("复现 Bug A:陈旧自我回声落后于编辑器当前内容时仍判回声(不 setContent、不吞字、不跳光标)", () => {
    // 打"abc"防抖保存(forward 记下 ABC),继续打"def"→编辑器现为 ABCDEF;
    // "abc"的回声(incoming=ABC)回来时,编辑器已超前(live=ABCDEF)。
    // 旧逻辑只比 incoming===live → 不等 → 误当外部变更 setContent(ABC) → 倒回旧内容、光标甩走。
    // 新逻辑:incoming 命中在途自我键 ABC → 判回声,仅同步版本号。
    const result = classifyIncomingDoc({
      incomingKey: ABC,
      liveKey: ABCDEF,
      pendingSelfKeys: [ABC, ABCDEF],
    });
    expect(result).toEqual({ verdict: "echo", matchedSelfIndex: 0 });
  });

  it("既不等当前内容、也不是任何在途自我保存 → 真·外部变更(agent/回滚/审阅)→ setContent", () => {
    expect(
      classifyIncomingDoc({
        incomingKey: EXTERNAL,
        liveKey: ABCDEF,
        pendingSelfKeys: [ABC, ABCDEF],
      }),
    ).toEqual({ verdict: "external", matchedSelfIndex: -1 });
  });

  it("命中较晚的在途自我键也算回声(返回其下标供调用方丢弃更早的)", () => {
    expect(
      classifyIncomingDoc({
        incomingKey: ABCDEF,
        liveKey: '{"doc":"abcdefgh"}',
        pendingSelfKeys: [ABC, ABCDEF],
      }),
    ).toEqual({ verdict: "echo", matchedSelfIndex: 1 });
  });
});

describe("pushPendingSelfDocKey —— 在途自我保存键队列", () => {
  it("追加新键", () => {
    expect(pushPendingSelfDocKey([ABC], ABCDEF)).toEqual([ABC, ABCDEF]);
  });

  it("去重相邻重复(同内容连续 forward 不堆积)", () => {
    expect(pushPendingSelfDocKey([ABC], ABC)).toEqual([ABC]);
  });

  it("超过上限时丢弃最旧键(防快打字无界增长)", () => {
    const many = Array.from(
      { length: PENDING_SELF_DOC_KEYS_CAP },
      (_, i) => `{"doc":"k${i}"}`,
    );
    const next = pushPendingSelfDocKey(many, '{"doc":"newest"}');
    expect(next).toHaveLength(PENDING_SELF_DOC_KEYS_CAP);
    expect(next[next.length - 1]).toBe('{"doc":"newest"}');
    expect(next[0]).toBe('{"doc":"k1"}'); // k0 被挤出
  });
});

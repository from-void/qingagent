import { describe, expect, it } from "vitest";
import {
  LANE_COLORS,
  LANE_NAMES,
  laneColor,
  laneFromAgentLabel,
  laneName,
} from "./humanCursorLanes";

describe("humanCursorLanes", () => {
  it("lane 1..N 一一映射到中文名/颜色", () => {
    for (let lane = 1; lane <= LANE_NAMES.length; lane++) {
      expect(laneName(lane)).toBe(LANE_NAMES[lane - 1]);
    }
    for (let lane = 1; lane <= LANE_COLORS.length; lane++) {
      expect(laneColor(lane)).toBe(LANE_COLORS[lane - 1]);
    }
  });

  it("超出名册长度循环回绕(lane=N+1→index0,lane=N+2→index1)", () => {
    const n = LANE_NAMES.length;
    expect(laneName(n + 1)).toBe(LANE_NAMES[0]);
    expect(laneName(n + 2)).toBe(LANE_NAMES[1]);
    expect(laneName(2 * n + 1)).toBe(LANE_NAMES[0]);
    const c = LANE_COLORS.length;
    expect(laneColor(c + 1)).toBe(LANE_COLORS[0]);
  });

  it("非法 lane(0 / 负 / NaN)走兜底:名 AI、色取首色", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(laneName(bad)).toBe("AI");
      expect(laneColor(bad)).toBe(LANE_COLORS[0]);
    }
  });

  it("laneFromAgentLabel:从 Agent·N 取并发号,取不出返回 null", () => {
    expect(laneFromAgentLabel("Agent·1")).toBe(1);
    expect(laneFromAgentLabel("Agent·12")).toBe(12);
    expect(laneFromAgentLabel("")).toBeNull();
    expect(laneFromAgentLabel(null)).toBeNull();
    expect(laneFromAgentLabel("无数字")).toBeNull();
  });
});

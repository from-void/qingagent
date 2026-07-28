// @vitest-environment jsdom
// 技能 tab 闪帧根治的锚点:SkillsPanel 的空态分支是 `!loading && !error && skills.length === 0`,
// 首拉在途时 loading 必须已经是 true,否则首帧就渲染出「暂无技能」再被列表顶掉。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSkills } from "./useSkills";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const frames: Array<{ loading: boolean; count: number; error: string | null }> = [];

function Probe() {
  const { skills, loading, error } = useSkills();
  frames.push({ loading, count: skills.length, error });
  // 复刻 SkillsPanel 的空态判定,直接断言这一帧会不会渲染出「暂无技能」
  return <div>{!loading && !error && skills.length === 0 ? "暂无技能" : ""}</div>;
}

describe("useSkills 首拉在途契约", () => {
  beforeEach(() => {
    frames.length = 0;
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("首拉未回来时 loading 恒为 true,任何一帧都不渲染「暂无技能」", async () => {
    const pending = new Promise<Response>(() => {});
    vi.stubGlobal("fetch", vi.fn(() => pending));

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<Probe />);
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.loading)).toBe(true);
    expect(host?.textContent).toBe("");
  });

  it("首拉返回空列表后才允许下「暂无技能」的结论", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ skills: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<Probe />);
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(host?.textContent).toBe("暂无技能");
  });
});

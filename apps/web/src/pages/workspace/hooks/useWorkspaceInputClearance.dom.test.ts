import { afterEach, describe, expect, it } from "vitest";
import { measureWorkspaceInputClearance } from "./useWorkspaceChrome";

const CHAT_BOTTOM = 800;
const DESIGN_GAP = 24;

describe("workspace 对话流底部留白", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it.each([
    ["普通输入框", "wf-input", 668, 682, 100],
    ["多行长文", "wf-input", 568, 582, 200],
    ["askUser 面板", "askuser-overlay", 668, 350, 438],
    ["确认条", "cf-overlay", 668, 420, 362],
  ])(
    "%s 下末条消息不与输入区重叠，且留白减实际占用不小于显式 gap",
    (_shape, occupantClass, wrapTop, occupantTop, occupantHeight) => {
      const { chat, wrap, occupant } = createLayout({
        occupantClass,
        wrapTop,
        occupantTop,
        occupantHeight,
      });

      const clearance = measureWorkspaceInputClearance(chat, wrap);
      const actualOccupied = CHAT_BOTTOM - occupantTop;
      const lastMessageBottomAtScrollEnd = CHAT_BOTTOM - clearance;

      expect(clearance - actualOccupied).toBeGreaterThanOrEqual(DESIGN_GAP);
      expect(clearance - actualOccupied).toBe(DESIGN_GAP);
      expect(lastMessageBottomAtScrollEnd).toBeLessThan(occupantTop);
      expect(occupant.getBoundingClientRect().top).toBe(occupantTop);
    },
  );

  it("技能菜单展开后按菜单真实顶边扩展留白", () => {
    const { chat, wrap } = createLayout({
      occupantClass: "wf-input",
      wrapTop: 668,
      occupantTop: 682,
      occupantHeight: 100,
    });
    const menu = document.createElement("div");
    menu.className = "qa-skill-menu";
    setRect(menu, { top: 300, bottom: 560, width: 268, height: 260 });
    wrap.appendChild(menu);

    expect(measureWorkspaceInputClearance(chat, wrap)).toBe(
      CHAT_BOTTOM - 300 + DESIGN_GAP,
    );
  });

  it("wrap paddingTop 大于显式 gap 时取较大值且不双份相加", () => {
    const { chat, wrap } = createLayout({
      occupantClass: "wf-input",
      wrapTop: 650,
      occupantTop: 682,
      occupantHeight: 100,
      paddingTop: 32,
    });

    const clearance = measureWorkspaceInputClearance(chat, wrap);
    const actualOccupied = CHAT_BOTTOM - 682;
    expect(clearance - actualOccupied).toBe(32);
  });
});

function createLayout(input: {
  occupantClass: string;
  wrapTop: number;
  occupantTop: number;
  occupantHeight: number;
  paddingTop?: number;
}) {
  const chat = document.createElement("div");
  const wrap = document.createElement("div");
  const occupant = document.createElement("div");
  wrap.style.paddingTop = `${input.paddingTop ?? 0}px`;
  wrap.style.setProperty("--ws-input-clearance-gap", `${DESIGN_GAP}px`);
  occupant.className = input.occupantClass;
  wrap.appendChild(occupant);
  document.body.append(chat, wrap);

  setRect(chat, {
    top: 0,
    bottom: CHAT_BOTTOM,
    width: 440,
    height: CHAT_BOTTOM,
  });
  setRect(wrap, {
    top: input.wrapTop,
    bottom: CHAT_BOTTOM,
    width: 440,
    height: CHAT_BOTTOM - input.wrapTop,
  });
  setRect(occupant, {
    top: input.occupantTop,
    bottom: input.occupantTop + input.occupantHeight,
    width: 422,
    height: input.occupantHeight,
  });

  return { chat, wrap, occupant };
}

function setRect(
  element: HTMLElement,
  rect: Pick<DOMRect, "top" | "bottom" | "width" | "height">,
) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      ...rect,
      x: 0,
      y: rect.top,
      left: 0,
      right: rect.width,
      toJSON: () => ({}),
    }),
  });
}

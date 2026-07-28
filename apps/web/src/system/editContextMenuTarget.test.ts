// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  clampMenuPosition,
  computeEditMenuAbility,
  resolveEditableTarget,
} from "./editContextMenuTarget";

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

describe("resolveEditableTarget", () => {
  it("命中输入框、文本域与富文本宿主", () => {
    const host = mount(
      '<input id="a" /><textarea id="b"></textarea><div id="c" contenteditable="true"><span id="d">x</span></div>',
    );
    expect(resolveEditableTarget(host.querySelector("#a"))?.kind).toBe("input");
    expect(resolveEditableTarget(host.querySelector("#b"))?.kind).toBe("input");
    expect(resolveEditableTarget(host.querySelector("#d"))?.kind).toBe("contenteditable");
    host.remove();
  });

  it("非文本 input、禁用控件与普通区域一律不接管", () => {
    const host = mount(
      '<input id="a" type="checkbox" /><input id="b" disabled /><p id="c">普通文本</p>',
    );
    expect(resolveEditableTarget(host.querySelector("#a"))).toBeNull();
    expect(resolveEditableTarget(host.querySelector("#b"))).toBeNull();
    expect(resolveEditableTarget(host.querySelector("#c"))).toBeNull();
    expect(resolveEditableTarget(null)).toBeNull();
    host.remove();
  });
});

describe("computeEditMenuAbility", () => {
  it("只读区域可复制全选、不可剪切粘贴", () => {
    const host = mount('<input id="a" readonly value="内容" />');
    const target = resolveEditableTarget(host.querySelector("#a"))!;
    expect(
      computeEditMenuAbility({ target, hasSelection: true, hasContent: true }),
    ).toEqual({ canCut: false, canCopy: true, canPaste: false, canSelectAll: true });
    host.remove();
  });

  it("密码框不给复制剪切，无选区禁用剪切复制，空内容禁用全选", () => {
    const host = mount('<input id="p" type="password" value="x" /><input id="t" />');
    const password = resolveEditableTarget(host.querySelector("#p"))!;
    expect(
      computeEditMenuAbility({ target: password, hasSelection: true, hasContent: true }),
    ).toEqual({ canCut: false, canCopy: false, canPaste: true, canSelectAll: true });

    const text = resolveEditableTarget(host.querySelector("#t"))!;
    expect(
      computeEditMenuAbility({ target: text, hasSelection: false, hasContent: false }),
    ).toEqual({ canCut: false, canCopy: false, canPaste: true, canSelectAll: false });
    host.remove();
  });
});

describe("clampMenuPosition", () => {
  it("菜单不越出视口右下缘", () => {
    expect(
      clampMenuPosition({
        x: 990,
        y: 780,
        menuWidth: 180,
        menuHeight: 130,
        viewportWidth: 1000,
        viewportHeight: 800,
      }),
    ).toEqual({ left: 814, top: 664 });
  });

  it("视口比菜单还小时退到边距位，不产生负坐标", () => {
    expect(
      clampMenuPosition({
        x: 10,
        y: 10,
        menuWidth: 400,
        menuHeight: 400,
        viewportWidth: 200,
        viewportHeight: 200,
      }),
    ).toEqual({ left: 6, top: 6 });
  });
});

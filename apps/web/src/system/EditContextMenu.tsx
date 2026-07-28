// 可编辑区域(输入框/文本域/富文本)的自绘右键菜单。
//
// 为什么自绘:桌面端原来弹的是 Electron 原生菜单,原生菜单**改不了字体**,剪切/复制/粘贴/全选
// 四项永远是系统默认字体,和全应用的宋体皮肤割裂(用户亲测点名)。渲染进程自绘后字体/描边/底色
// 全部跟随水墨皮肤。桌面主进程侧同步不再对可编辑区域弹原生菜单(见 apps/desktop/src/main/index.ts),
// 避免两张菜单同时出现。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useOverlayDismiss } from "./overlayDismissStack";
import {
  clampMenuPosition,
  computeEditMenuAbility,
  resolveEditableTarget,
} from "./editContextMenuTarget";
import type { EditableTarget, EditMenuAbility } from "./editContextMenuTarget";
import "./EditContextMenu.css";

interface MenuState {
  x: number;
  y: number;
  target: EditableTarget;
  ability: EditMenuAbility;
}

function isMacLike(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac/i.test(navigator.platform || navigator.userAgent || "");
}

function selectionTextIn(target: EditableTarget): string {
  if (target.kind === "input") {
    const el = target.element;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    return start === end ? "" : el.value.slice(start, end);
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  const anchor = selection.anchorNode;
  if (anchor && !target.element.contains(anchor)) return "";
  return selection.toString();
}

function contentTextIn(target: EditableTarget): string {
  return target.kind === "input" ? target.element.value : target.element.textContent ?? "";
}

function focusTarget(target: EditableTarget): void {
  const el = target.element;
  if (document.activeElement !== el) el.focus({ preventScroll: true });
}

function selectAllIn(target: EditableTarget): void {
  focusTarget(target);
  if (target.kind === "input") {
    target.element.select();
    return;
  }
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(target.element);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // 无剪贴板权限时静默降级:上面的 execCommand 通常已经成功。
  }
}

function copyIn(target: EditableTarget): void {
  focusTarget(target);
  const text = selectionTextIn(target);
  let done = false;
  try {
    done = document.execCommand("copy");
  } catch {
    done = false;
  }
  if (!done && text) void writeClipboard(text);
}

function cutIn(target: EditableTarget): void {
  focusTarget(target);
  const text = selectionTextIn(target);
  let done = false;
  try {
    done = document.execCommand("cut");
  } catch {
    done = false;
  }
  if (done) return;
  if (text) void writeClipboard(text);
  // 兜底删除选区:insertText("") 会走 beforeinput/input,React 受控输入与 ProseMirror 都能收到。
  try {
    document.execCommand("insertText", false, "");
  } catch {
    // 再失败就放弃,不做 DOM 直改(直改会绕过受控组件的 state)。
  }
}

async function readClipboard(): Promise<{ text: string; html: string } | null> {
  const clipboard = navigator.clipboard;
  if (!clipboard) return null;
  try {
    if (typeof clipboard.read === "function" && typeof ClipboardItem !== "undefined") {
      const items = await clipboard.read();
      let text = "";
      let html = "";
      for (const item of items) {
        if (!html && item.types.includes("text/html")) {
          html = await (await item.getType("text/html")).text();
        }
        if (!text && item.types.includes("text/plain")) {
          text = await (await item.getType("text/plain")).text();
        }
      }
      if (text || html) return { text, html };
    }
  } catch {
    // 读富文本失败(权限/格式)→ 退回纯文本。
  }
  try {
    if (typeof clipboard.readText === "function") {
      return { text: await clipboard.readText(), html: "" };
    }
  } catch {
    // 交给下面的 execCommand("paste") 兜底。
  }
  return null;
}

async function pasteInto(target: EditableTarget): Promise<void> {
  focusTarget(target);
  const payload = await readClipboard();
  if (!payload || (!payload.text && !payload.html)) {
    try {
      document.execCommand("paste");
    } catch {
      // 浏览器禁止 execCommand("paste");此时无从粘贴,保持静默(用户仍可 Ctrl+V)。
    }
    return;
  }
  // 富文本宿主(TipTap/ProseMirror)自己处理 paste 事件,能保留格式;派发合成事件让它接管。
  if (target.kind === "contenteditable" && typeof ClipboardEvent !== "undefined") {
    try {
      const data = new DataTransfer();
      if (payload.text) data.setData("text/plain", payload.text);
      if (payload.html) data.setData("text/html", payload.html);
      const event = new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      });
      const notHandled = target.element.dispatchEvent(event);
      if (!notHandled) return;
    } catch {
      // 合成事件不可用 → 落到下面的 insertText。
    }
  }
  if (!payload.text) return;
  try {
    document.execCommand("insertText", false, payload.text);
  } catch {
    // 放弃:不直改 DOM,避免绕过受控组件。
  }
}

/**
 * 挂在应用壳上的全局单例:监听 contextmenu,命中可编辑区域就自绘菜单,其余区域一律不接管
 * (让浏览器/桌面原生菜单照旧)。
 */
export function EditContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setMenu(null), []);

  // Esc 统一走浮层关闭栈(设置面板等处的面板级守卫会先弹栈关掉本菜单)。
  useOverlayDismiss(menu !== null, close);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      // 已被组件级右键菜单(画布/技能卡等)接管的,不抢。
      if (event.defaultPrevented) return;
      const target = resolveEditableTarget(event.target);
      if (!target) return;
      event.preventDefault();
      const ability = computeEditMenuAbility({
        target,
        hasSelection: selectionTextIn(target).length > 0,
        hasContent: contentTextIn(target).length > 0,
      });
      setPosition(null);
      setMenu({ x: event.clientX, y: event.clientY, target, ability });
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      close();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, { passive: true });
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [close, menu]);

  // 先按点击点渲染一帧(隐藏),量到实际尺寸再夹回视口内,保证菜单不越出屏幕。
  useLayoutEffect(() => {
    if (!menu) {
      setPosition(null);
      return;
    }
    const node = menuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setPosition(
      clampMenuPosition({
        x: menu.x,
        y: menu.y,
        menuWidth: rect.width,
        menuHeight: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    );
  }, [menu]);

  if (!menu) return null;
  const mod = isMacLike() ? "⌘" : "Ctrl+";
  const run = (action: () => void | Promise<void>) => () => {
    close();
    void action();
  };
  const items: { label: string; hint: string; enabled: boolean; onSelect: () => void }[] = [
    {
      label: "剪切",
      hint: `${mod}X`,
      enabled: menu.ability.canCut,
      onSelect: run(() => cutIn(menu.target)),
    },
    {
      label: "复制",
      hint: `${mod}C`,
      enabled: menu.ability.canCopy,
      onSelect: run(() => copyIn(menu.target)),
    },
    {
      label: "粘贴",
      hint: `${mod}V`,
      enabled: menu.ability.canPaste,
      onSelect: run(() => pasteInto(menu.target)),
    },
    {
      label: "全选",
      hint: `${mod}A`,
      enabled: menu.ability.canSelectAll,
      onSelect: run(() => selectAllIn(menu.target)),
    },
  ];

  return createPortal(
    <div
      ref={menuRef}
      className="wf-editmenu"
      data-wf="EditContextMenu"
      role="menu"
      style={{
        left: position?.left ?? menu.x,
        top: position?.top ?? menu.y,
        visibility: position ? "visible" : "hidden",
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="wf-editmenu-item"
          disabled={!item.enabled}
          // 不抢焦点:输入框保持聚焦与选区,execCommand 才作用在原目标上。
          onMouseDown={(e) => e.preventDefault()}
          onClick={item.onSelect}
        >
          <span>{item.label}</span>
          <span className="wf-editmenu-key">{item.hint}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

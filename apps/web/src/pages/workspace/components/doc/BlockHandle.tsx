import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { DEFAULT_DRAWIO_SOURCE, pmToClipboardHtml, pmToPlainText, type PmDoc } from "@qingagent/pm-schema";
import type { DrawioEditorResult } from "../drawioEmbedProtocol";
import { findDraggableBlock, type MovableBlock } from "../ColumnDnD";
import { findDraggableListItem, LIST_ITEM_DND_MIME, resolveListItemByBlockId, type DraggableListItem } from "../ListItemDnD";
import { getBlockCollapseInfo, qingagentCollapseKey, toggleBlockCollapse } from "../BlockCollapse";
import { openDrawioEditor } from "../drawioEditorLauncher";
import {
  createDrawioBlockId,
  writeDrawioResultByBlockId,
} from "../drawioDocumentWriteback";
import { insertFileAsset, insertImageAsset } from "../../data/insertUploadedAsset";
import { uploadFailureMessage } from "../../data/uploadAsset";
import { pickFile } from "./pickFile";
import {
  createBlockDragPayload,
  createDefaultColumnListNode,
  createDefaultTableNode,
  insertStructureNodeAfterBlock,
} from "./structureNodes";
import { writeBlockClipboardPayload } from "./blockClipboard";
import { readTableBlockMenuState, setEvenTableColumnWidths, toggleTableHeader } from "./blockHandleTable";
import { BlockHandleIcon } from "./BlockHandleIcons";
import { TableSizePicker, type TableSize } from "./TableSizePicker";
import {
  computeBlockMenuPlacement,
  computeCollapsedCarets,
  blockHandleGeometry,
  glyphForBlock,
  glyphForListItem,
  HandleTypeIcon,
  listItemHandleGeometry,
  refreshHandleGeometryFromDom,
  type CollapsedCaret,
  type HandleState,
} from "./blockHandleGeometry";
import {
  getCurrentHandleNode,
  resolveHandleRangeByStableId,
  resolveDocumentPositionSafely,
} from "./blockHandlePosition";

type SubmenuKey = "align" | "insert";

export function BlockHandle({ editor, onToast }: { editor: Editor; onToast?: (message: string) => void }) {
  const [handle, setHandle] = useState<HandleState | null>(null);
  const [collapsedCarets, setCollapsedCarets] = useState<CollapsedCaret[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuFlipUp, setMenuFlipUp] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<SubmenuKey | null>(null);
  const [submenuPlacement, setSubmenuPlacement] = useState<Partial<Record<SubmenuKey, { side: "left" | "right"; top: number; left: number }>>>({});
  const [tablePicker, setTablePicker] = useState<{ anchor: HTMLElement; autoFocus: boolean } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const alignPanelRef = useRef<HTMLDivElement>(null);
  const insertPanelRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submenuCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggingRef = useRef(false);
  const lastMouseRef = useRef<MouseEvent | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const clearSubmenuCloseTimer = useCallback(() => {
    if (submenuCloseTimer.current) {
      clearTimeout(submenuCloseTimer.current);
      submenuCloseTimer.current = null;
    }
  }, []);

  const resetMenuPlacement = useCallback(() => {
    setMenuPos(null);
    setMenuFlipUp(false);
    setActiveSubmenu(null);
    setSubmenuPlacement({});
    setTablePicker(null);
  }, []);

  const refreshFloatingHandle = useCallback(
    (h: HandleState): HandleState | null =>
      getCurrentHandleNode(editor.state.doc, h)
        ? refreshHandleGeometryFromDom(h, editor.view.dom as HTMLElement)
        : null,
    [editor],
  );

  const applyBlockMenuPlacement = useCallback((h: HandleState, menuEl?: HTMLElement | null): boolean => {
    const placement = computeBlockMenuPlacement(h, menuEl);
    if (!placement) return false;
    setMenuPos({ top: placement.top, left: placement.left });
    setMenuFlipUp(placement.flipUp);
    setActiveSubmenu(null);
    setSubmenuPlacement({});
    setTablePicker(null);
    return true;
  }, []);

  const openBlockMenu = useCallback(
    (h: HandleState) => {
      if (h.kind !== "block" || !editor.isEditable) return;
      const next = refreshFloatingHandle(h);
      if (!next || next.kind !== "block") {
        setHandle(next);
        setMenuOpen(false);
        resetMenuPlacement();
        return;
      }
      if (!applyBlockMenuPlacement(next, menuRef.current)) {
        setHandle(next);
        setMenuOpen(false);
        resetMenuPlacement();
        return;
      }
      setHandle(next);
      setMenuOpen(true);
    },
    [applyBlockMenuPlacement, editor, refreshFloatingHandle, resetMenuPlacement],
  );

  useEffect(() => {
    return () => {
      clearHideTimer();
      clearSubmenuCloseTimer();
    };
  }, [clearHideTimer, clearSubmenuCloseTimer]);

  // 折叠态常驻三角(gutter 悬浮层):随文档内容/折叠态/滚动重算位置。rAF 节流。
  useEffect(() => {
    let raf = 0;
    const recompute = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setCollapsedCarets(computeCollapsedCarets(editor));
      });
    };
    // 折叠/展开走的是纯装饰事务(docChanged=false),tiptap 不发 update/selectionUpdate,
    // 只发 transaction。若只听 update,折叠后常驻三角不重算、要滚动才出现(回归
    // fold-collapse-triangle-disappears)。额外监听 transaction,按 collapse meta 过滤后重算。
    const onTransaction = ({ transaction }: { transaction: { getMeta: (k: typeof qingagentCollapseKey) => unknown } }) => {
      if (transaction.getMeta(qingagentCollapseKey) !== undefined) recompute();
    };
    recompute();
    editor.on("update", recompute);
    editor.on("selectionUpdate", recompute);
    editor.on("transaction", onTransaction);
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      editor.off("update", recompute);
      editor.off("selectionUpdate", recompute);
      editor.off("transaction", onTransaction);
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [editor]);

  useEffect(() => {
    const dom = editor.view.dom;

    const handleFromBlock = (block: MovableBlock, insertPos: number): HandleState | null => {
      if (!editor.isEditable) return null;
      const currentDoc = editor.state.doc;
      if (
        !resolveDocumentPositionSafely(currentDoc, block.pos) ||
        !resolveDocumentPositionSafely(currentDoc, insertPos)
      ) {
        return null;
      }
      // 列表(有序/无序/待办)不出整块级拖拽手柄——列表只做行级(listItem)拖拽,
      // 整列表块手柄会和行手柄语义打架且不是用户要的交互。列表项仍通过 li 命中走行手柄。
      if (block.node.type.name === "bulletList" || block.node.type.name === "orderedList" || block.node.type.name === "taskList") {
        return null;
      }
      try {
        const blockDom = editor.view.nodeDOM(block.pos);
        if (!(blockDom instanceof HTMLElement)) return null;
        const geometry = blockHandleGeometry(blockDom, block.node.type.name);
        const isEmpty = block.node.type.name !== "table" && (
          blockDom.textContent?.trim() === "" ||
          (blockDom.childNodes.length === 1 && blockDom.firstChild?.nodeName === "BR")
        );
        return {
          kind: "block",
          top: geometry.top,
          left: geometry.left,
          blockPos: block.pos,
          insertPos,
          isEmpty,
          // "+" 仅给"空行且无格式"(空段落);空标题/空引用等已有格式的块显示其类型图标(可拖拽 chip)
          glyph: isEmpty && block.node.type.name === "paragraph" ? "+" : glyphForBlock(block.node),
          blockEl: blockDom,
          blockId: typeof block.node.attrs.blockId === "string" ? block.node.attrs.blockId : null,
          nodeType: block.node.type.name,
        };
      } catch {
        return null;
      }
    };

    const handleFromListItem = (item: DraggableListItem, insertPos: number): HandleState | null => {
      if (!editor.isEditable) return null;
      const currentDoc = editor.state.doc;
      if (
        !resolveDocumentPositionSafely(currentDoc, item.itemPos) ||
        !resolveDocumentPositionSafely(currentDoc, insertPos)
      ) {
        return null;
      }
      try {
        const itemDom = editor.view.nodeDOM(item.itemPos);
        if (!(itemDom instanceof HTMLElement)) return null;
        const geometry = listItemHandleGeometry(itemDom, item.itemType);
        return {
          kind: "listItem",
          top: geometry.top,
          left: geometry.left,
          blockPos: item.itemPos,
          insertPos,
          isEmpty: false,
          glyph: glyphForListItem(item),
          blockEl: itemDom,
          blockId: item.blockId,
          itemType: item.itemType,
          nodeType: item.itemType,
        };
      } catch {
        return null;
      }
    };

    const eventTargetElement = (target: EventTarget | null): Element | null => {
      if (target instanceof Element) return target;
      if (target instanceof Node && target.parentElement) return target.parentElement;
      return null;
    };

    const pointIsInsideColumnBlock = (block: MovableBlock, e: MouseEvent): boolean => {
      if (block.parentType !== "column") return true;
      const blockDom = editor.view.nodeDOM(block.pos);
      if (!(blockDom instanceof HTMLElement)) return false;
      const rect = blockDom.getBoundingClientRect();
      return e.clientX >= rect.left && e.clientX <= rect.right;
    };

    const resolveHandleFromSelection = (): HandleState | null => {
      if (!editor.isEditable) return null;
      const { $from } = editor.state.selection;
      const block = findDraggableBlock($from);
      return block ? handleFromBlock(block, editor.state.selection.from) : null;
    };

    const resolveTrailingWhitespaceHandle = (e: MouseEvent): HandleState | null => {
      // 只认真正的"块外留白":指针落在某个块自己的 DOM 上时一律交回行内解析,
      // 否则会把列表行等块内 hover 抢成末块手柄。
      const target = eventTargetElement(e.target);
      if (target && target !== editor.view.dom && editor.view.dom.contains(target)) return null;
      const doc = editor.state.doc;
      const lastIndex = doc.childCount - 1;
      if (lastIndex < 0) return null;
      const lastBlockDom = editor.view.dom.lastElementChild;
      if (!(lastBlockDom instanceof HTMLElement)) return null;
      const paperRect = editor.view.dom.getBoundingClientRect();
      const lastRect = lastBlockDom.getBoundingClientRect();
      if (e.clientY <= lastRect.bottom) return null;
      if (e.clientX < paperRect.left || e.clientX > paperRect.right) return null;
      let lastPos = 0;
      doc.forEach((_node, offset, index) => {
        if (index === lastIndex) lastPos = offset;
      });
      const $inside = resolveDocumentPositionSafely(doc, Math.min(lastPos + 1, doc.content.size));
      const $boundary = resolveDocumentPositionSafely(doc, lastPos);
      const block =
        ($inside ? findDraggableBlock($inside) : null) ??
        ($boundary ? findDraggableBlock($boundary) : null);
      return block ? handleFromBlock(block, lastPos + 1) : null;
    };

    const resolveHandleFromPoint = (e: MouseEvent): HandleState | null => {
      // 末尾空白优先判:指针落在最后一个顶层块底边之下、且横向在正文带内(纸面留白也算)时,
      // 手柄锚到最后一个可拖块——飞书就是这样,不必精确压在行上才出加号;空文档锚到唯一的空段。
      // 放最前是因为这时任何行内解析都不可能命中正确的块。
      const trailing = resolveTrailingWhitespaceHandle(e);
      if (trailing) return trailing;

      const targetLi = eventTargetElement(e.target)?.closest("li[data-block-id]");
      if (targetLi && editor.view.dom.contains(targetLi)) {
        const blockId = targetLi.getAttribute("data-block-id");
        const hit = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
        const currentDoc = editor.state.doc;
        const $hit = hit
          ? resolveDocumentPositionSafely(currentDoc, hit.pos)
          : null;
        const byPos = $hit ? findDraggableListItem($hit) : null;
        const item = byPos ?? (blockId ? resolveListItemByBlockId(editor.state, blockId) : null);
        if (item) {
          const resolved = handleFromListItem(item, hit?.pos ?? item.itemPos + 1);
          if (resolved) return resolved;
        }
      }

      // 鼠标在列表行左侧 marker 带 / gutter(不在 li 文字区,closest 命中不到 li、posAtCoords 落到
      // ul padding)时,按"垂直所在行"找到列表项,保持行手柄不消失——否则往左移一点点想去点手柄,
      // 手柄就没了、永远抓不住。取垂直命中 clientY、且 x 不在行右侧之外、x 在行左 gutter 容差内的
      // 最深(面积最小)列表项。
      {
        const HANDLE_GUTTER_PX = 48;
        let liFallback: HandleState | null = null;
        let liFallbackArea = Number.POSITIVE_INFINITY;
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name !== "listItem" && node.type.name !== "taskItem") return true;
          const liDom = editor.view.nodeDOM(pos);
          if (!(liDom instanceof HTMLElement)) return true;
          const rect = liDom.getBoundingClientRect();
          if (e.clientY < rect.top || e.clientY > rect.bottom) return true;
          if (e.clientX > rect.right || e.clientX < rect.left - HANDLE_GUTTER_PX) return true;
          const $item = resolveDocumentPositionSafely(
            editor.state.doc,
            Math.min(pos + 1, editor.state.doc.content.size),
          );
          const item = $item ? findDraggableListItem($item) : null;
          const resolved = item ? handleFromListItem(item, pos + 1) : null;
          const area = Math.max(1, rect.width * rect.height);
          if (resolved && area < liFallbackArea) {
            liFallback = resolved;
            liFallbackArea = area;
          }
          return true;
        });
        if (liFallback) return liFallback;
      }

      // posAtCoords 依赖宿主的 elementFromPoint,极端环境(块刚卸载/非常规宿主)会抛;
      // 命中失败退回下面按块矩形的解析,不让一次异常打断整条 hover 链。
      let hit: { pos: number } | null = null;
      try {
        hit = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
      } catch {
        hit = null;
      }
      if (hit) {
        const $hit = resolveDocumentPositionSafely(editor.state.doc, hit.pos);
        const block = $hit ? findDraggableBlock($hit) : null;
        const resolved = block && pointIsInsideColumnBlock(block, e)
          ? handleFromBlock(block, hit.pos)
          : null;
        if (resolved) return resolved;
      }

      let fallback: HandleState | null = null;
      let fallbackArea = Number.POSITIVE_INFINITY;
      editor.state.doc.descendants((node, pos, parent) => {
        if (!parent || !node.isBlock) return true;
        if (parent.type.name !== "doc" && parent.type.name !== "column") return true;
        const blockDom = editor.view.nodeDOM(pos);
        if (!(blockDom instanceof HTMLElement)) return true;
        const rect = blockDom.getBoundingClientRect();
        if (e.clientY < rect.top || e.clientY > rect.bottom) return true;
        if (parent.type.name === "column" && (e.clientX < rect.left || e.clientX > rect.right)) return true;
        // 非叶子块从内部位置(pos+1)解析;叶子块(diagram 等)pos+1 落到块后无法命中,
        // 退回用块边界 pos(findDraggableBlock 会经 nodeAfter 命中叶子块)。
        const $inside = resolveDocumentPositionSafely(
          editor.state.doc,
          Math.min(pos + 1, editor.state.doc.content.size),
        );
        const $boundary = resolveDocumentPositionSafely(editor.state.doc, pos);
        const block =
          ($inside ? findDraggableBlock($inside) : null) ??
          ($boundary ? findDraggableBlock($boundary) : null);
        const resolved = block ? handleFromBlock(block, pos + 1) : null;
        const area = Math.max(1, rect.width * rect.height);
        if (resolved && area < fallbackArea) {
          fallback = resolved;
          fallbackArea = area;
        }
        return true;
      });
      return fallback;
    };

    const onMove = (e: MouseEvent) => {
      if (menuOpen || draggingRef.current) return;
      if (!editor.isEditable) return; // 只读视图不显示手柄
      lastMouseRef.current = e;
      clearHideTimer();
      setHandle(resolveHandleFromPoint(e));
    };

    // 折叠/展开是纯装饰事务(无 mousemove),尤其点常驻三角展开后鼠标静止,接管的 hover 折叠
    // 箭头依赖 handle 却收不到 move 事件→箭头不出现、需移动鼠标才回来(回归用户反馈)。
    // 折叠态变化后按"上次鼠标位置"重算 handle,让 fold 箭头立即接管。
    const onLeave = (e: MouseEvent) => {
      if (menuOpen || draggingRef.current) return;
      if (wrapRef.current?.contains(e.relatedTarget as Node)) return;
      hideTimer.current = setTimeout(() => setHandle(null), 250);
    };

    // 滚动/缩放/transaction 时手柄和菜单实时跟随其所属块。菜单用 viewport fixed 坐标,
    // 因此必须重读 block rect;锚点失效时直接关闭菜单。rAF 节流。
    let rafId = 0;
    const syncFloatingAnchor = () => {
      setHandle((h) => {
        if (!h) {
          if (menuOpen) {
            setMenuOpen(false);
            resetMenuPlacement();
          }
          return h;
        }
        const next = getCurrentHandleNode(editor.state.doc, h)
          ? refreshHandleGeometryFromDom(h, dom)
          : null;
        if (!next) {
          if (menuOpen) {
            setMenuOpen(false);
            resetMenuPlacement();
          }
          return null;
        }
        if (menuOpen) {
          if (next.kind !== "block" || !applyBlockMenuPlacement(next, menuRef.current)) {
            setMenuOpen(false);
            resetMenuPlacement();
          }
        }
        return next;
      });
    };
    const scheduleFloatingSync = () => {
      if (draggingRef.current || rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        syncFloatingAnchor();
      });
    };

    const onTransaction = ({ transaction }: { transaction: { getMeta: (k: typeof qingagentCollapseKey) => unknown } }) => {
      const collapseChanged = transaction.getMeta(qingagentCollapseKey) !== undefined;
      if (menuOpen) {
        scheduleFloatingSync();
        return;
      }
      if (!collapseChanged || draggingRef.current || !editor.isEditable) return;
      const last = lastMouseRef.current;
      if (!last) return;
      requestAnimationFrame(() => {
        if (editor.isDestroyed) return;
        clearHideTimer();
        setHandle(resolveHandleFromPoint(last));
      });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const wantsMenu = (e.altKey && e.key === "Enter") || ((e.metaKey || e.ctrlKey) && e.key === "/");
      if (!wantsMenu) return;
      const next = resolveHandleFromSelection();
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      clearHideTimer();
      openBlockMenu(next);
    };

    // 纸面留白(.wf-doc 之外、纸内)也要收到 mousemove,否则最后一块下方的空白区连事件都没有;
    // 与"末尾点击追加行"共用同一片留白:悬停出手柄、点击仍追加行,互不打架。
    const paperHost: HTMLElement | null =
      dom.closest<HTMLElement>(".ws-paper-surface") ?? dom.parentElement;
    dom.addEventListener("mousemove", onMove);
    if (paperHost && paperHost !== dom) paperHost.addEventListener("mousemove", onMove as EventListener);
    dom.addEventListener("mouseleave", onLeave);
    if (paperHost && paperHost !== dom) paperHost.addEventListener("mouseleave", onLeave as EventListener);
    dom.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", scheduleFloatingSync, true); // capture:捕获嵌套滚动容器的滚动
    window.addEventListener("resize", scheduleFloatingSync);
    editor.on("transaction", onTransaction);
    return () => {
      dom.removeEventListener("mousemove", onMove);
      paperHost?.removeEventListener("mousemove", onMove as EventListener);
      dom.removeEventListener("mouseleave", onLeave);
      paperHost?.removeEventListener("mouseleave", onLeave as EventListener);
      dom.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", scheduleFloatingSync, true);
      window.removeEventListener("resize", scheduleFloatingSync);
      editor.off("transaction", onTransaction);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [editor, menuOpen, clearHideTimer, applyBlockMenuPlacement, openBlockMenu, resetMenuPlacement]);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideHandle = wrapRef.current?.contains(target) ?? false;
      const insideMenu = menuRef.current?.contains(target) ?? false;
      const insideSubmenuPanel =
        (alignPanelRef.current?.contains(target) ?? false) ||
        (insertPanelRef.current?.contains(target) ?? false);
      const insideTablePicker = target instanceof Element && Boolean(target.closest(".table-size-picker"));
      if (!insideHandle && !insideMenu && !insideSubmenuPanel && !insideTablePicker) {
        setMenuOpen(false);
        setHandle(null);
        resetMenuPlacement();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMenuOpen(false);
        resetMenuPlacement();
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, resetMenuPlacement]);

  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuFlipUp(false);
      setMenuPos(null);
      setActiveSubmenu(null);
      setSubmenuPlacement({});
      setTablePicker(null);
      return;
    }
    const menu = menuRef.current;
    if (!handle || handle.kind !== "block" || !menu) return;
    if (!applyBlockMenuPlacement(handle, menu)) {
      setMenuOpen(false);
      resetMenuPlacement();
      return;
    }
    requestAnimationFrame(() => {
      menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    });
  }, [menuOpen, handle, applyBlockMenuPlacement, resetMenuPlacement]);

  const scheduleSubmenuClose = useCallback(() => {
    clearSubmenuCloseTimer();
    submenuCloseTimer.current = setTimeout(() => {
      setActiveSubmenu(null);
      setTablePicker(null);
    }, 90);
  }, [clearSubmenuCloseTimer]);

  const placeSubmenu = useCallback((key: SubmenuKey, wrapper: HTMLDivElement) => {
    clearSubmenuCloseTimer();
    const panel = key === "align" ? alignPanelRef.current : insertPanelRef.current;
    if (!panel) return;
    const rect = wrapper.getBoundingClientRect();
    const panelWidth = panel.offsetWidth || 164;
    const panelHeight = panel.offsetHeight || panel.scrollHeight || 34;
    const margin = 8;
    const side = rect.right + 4 + panelWidth <= window.innerWidth - margin ? "right" : "left";
    const preferredTop = rect.top - 6;
    const maxTop = Math.max(margin, window.innerHeight - Math.min(panelHeight, window.innerHeight - margin * 2) - margin);
    const clampedTop = Math.min(Math.max(preferredTop, margin), maxTop);
    const left = side === "right"
      ? rect.right + 4
      : Math.max(margin, rect.left - panelWidth - 4);
    setSubmenuPlacement((current) => ({
      ...current,
      [key]: { side, top: Math.round(clampedTop), left: Math.round(left) },
    }));
    setActiveSubmenu(key);
  }, [clearSubmenuCloseTimer]);

  const keepSubmenuOpen = useCallback(() => {
    clearSubmenuCloseTimer();
  }, [clearSubmenuCloseTimer]);

  const openTablePicker = useCallback((anchor: HTMLElement, autoFocus: boolean) => {
    clearSubmenuCloseTimer();
    setTablePicker({ anchor, autoFocus });
  }, [clearSubmenuCloseTimer]);

  const closeTablePickerOnOtherMenuItem = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const menuItem = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[role="menuitem"]')
      : null;
    if (
      !menuItem ||
      !event.currentTarget.contains(menuItem) ||
      menuItem.hasAttribute("data-table-picker-trigger")
    ) return;
    setTablePicker(null);
  }, []);

  const closeSubmenuOnBlur = useCallback((e: React.FocusEvent<HTMLElement>, key: SubmenuKey) => {
    const next = e.relatedTarget;
    if (next instanceof Node) {
      const panel = key === "align" ? alignPanelRef.current : insertPanelRef.current;
      if (
        e.currentTarget.contains(next) ||
        (panel?.contains(next) ?? false) ||
        (menuRef.current?.contains(next) ?? false)
      ) return;
    }
    scheduleSubmenuClose();
  }, [scheduleSubmenuClose]);

  // 把光标放到"该插入新块的位置":空块原地;非空块在其下方插一个空段落并进入。
  const seedInsertChain = useCallback(
    (h: HandleState) => {
      if (!editor.isEditable) return null;
      const node = getCurrentHandleNode(editor.state.doc, h);
      if (!node) return null;
      const chain = editor.chain().focus();
      if (h.isEmpty) return chain.setTextSelection(h.insertPos);
      const after = h.blockPos + node.nodeSize;
      return chain.insertContentAt(after, { type: "paragraph" }).setTextSelection(after + 1);
    },
    [editor],
  );

  const runHandleCommand = useCallback(
    (ok: boolean, label: string) => {
      if (!ok) onToast?.(`无法执行：${label}`);
      return ok;
    },
    [onToast],
  );

  const insertStructureBlockAfter = useCallback(
    (h: HandleState, node: Record<string, unknown>, label: string) => {
      const current = getCurrentHandleNode(editor.state.doc, h);
      if (!current) return runHandleCommand(false, label);
      return runHandleCommand(
        insertStructureNodeAfterBlock(editor, h.blockPos, node),
        label,
      );
    },
    [editor, runHandleCommand],
  );

  const insertBlock = useCallback(
    async (type: string, opts?: number) => {
      if (!handle || handle.kind !== "block") return;
      if (!editor.isEditable) return;
      if (!getCurrentHandleNode(editor.state.doc, handle)) {
        setHandle(null);
        setMenuOpen(false);
        resetMenuPlacement();
        return;
      }
      setMenuOpen(false);
      const h = handle;
      setHandle(null);

      switch (type) {
        case "blockMath":
          insertStructureBlockAfter(h, { type: "blockMath", attrs: { latex: "E = mc^2" } }, "公式块");
          return;
        case "diagram":
          insertStructureBlockAfter(
            h,
            {
              type: "diagram",
              attrs: { lang: "mermaid", source: "flowchart TD\n  A[开始] --> B[结束]", svg: null },
            },
            "插入 Mermaid 图表",
          );
          return;
        case "drawio": {
          try {
            const blockId = createDrawioBlockId();
            const inserted = insertStructureBlockAfter(
              h,
              {
                type: "diagram",
                attrs: {
                  blockId,
                  lang: "drawio",
                  source: DEFAULT_DRAWIO_SOURCE,
                  svg: null,
                },
              },
              "插入 drawio 工程图",
            );
            if (!inserted) return;
            const writeBack = (result: DrawioEditorResult) => {
              if (!editor.isEditable) return;
              writeDrawioResultByBlockId(editor, blockId, result);
            };
            const result = await openDrawioEditor(
              DEFAULT_DRAWIO_SOURCE,
              "新建 drawio 工程图",
              writeBack,
            );
            if (result) writeBack(result);
          } catch (drawioError) {
            onToast?.(drawioError instanceof Error ? drawioError.message : String(drawioError));
          }
          return;
        }
        case "horizontalRule":
          insertStructureBlockAfter(h, { type: "horizontalRule" }, "插入分隔线");
          return;
        case "columnList":
          insertStructureBlockAfter(h, createDefaultColumnListNode(), "插入分栏");
          return;
      }

      const chain = seedInsertChain(h);
      if (!chain) return;
      switch (type) {
        case "heading":
          runHandleCommand(chain.setHeading({ level: (opts ?? 1) as 1 | 2 | 3 | 4 | 5 | 6 }).run(), "标题");
          break;
        case "bulletList":
          runHandleCommand(chain.toggleBulletList().run(), "无序列表");
          break;
        case "orderedList":
          runHandleCommand(chain.toggleOrderedList().run(), "有序列表");
          break;
        case "codeBlock":
          runHandleCommand(chain.setCodeBlock().run(), "代码块");
          break;
        case "inlineMath":
          runHandleCommand(chain.insertInlineMath({ latex: "x^2" }).run(), "行内公式");
          break;
        case "blockquote":
          runHandleCommand(chain.toggleBlockquote().run(), "引用");
          break;
      }
    },
    [editor, handle, insertStructureBlockAfter, resetMenuPlacement, runHandleCommand, seedInsertChain],
  );

  const insertTableBlock = useCallback((size: TableSize) => {
    if (!handle || handle.kind !== "block" || !editor.isEditable) return;
    if (!getCurrentHandleNode(editor.state.doc, handle)) {
      setHandle(null);
      setMenuOpen(false);
      resetMenuPlacement();
      return;
    }
    const h = handle;
    setTablePicker(null);
    setMenuOpen(false);
    setHandle(null);
    insertStructureBlockAfter(h, createDefaultTableNode(size.rows, size.cols, false), "插入表格");
  }, [editor, handle, insertStructureBlockAfter, resetMenuPlacement]);

  // 转换当前块的格式(turn-into,对齐飞书:点徽标把 H1 换成正文/其他)。原地转换,不新建块。
  const convertBlock = useCallback(
    (type: string, opts?: number) => {
      if (!handle || handle.kind !== "block") return;
      if (!editor.isEditable) return;
      if (!getCurrentHandleNode(editor.state.doc, handle)) {
        setHandle(null);
        setMenuOpen(false);
        resetMenuPlacement();
        return;
      }
      setMenuOpen(false);
      const h = handle;
      setHandle(null);
      const chain = editor.chain().focus().setTextSelection(h.insertPos);
      switch (type) {
        case "paragraph":
          runHandleCommand(chain.setParagraph().run(), "正文");
          break;
        case "heading":
          runHandleCommand(chain.setHeading({ level: (opts ?? 1) as 1 | 2 | 3 | 4 | 5 | 6 }).run(), "标题");
          break;
        case "bulletList":
          runHandleCommand(chain.toggleBulletList().run(), "无序列表");
          break;
        case "orderedList":
          runHandleCommand(chain.toggleOrderedList().run(), "有序列表");
          break;
        case "blockquote":
          runHandleCommand(chain.toggleBlockquote().run(), "引用");
          break;
        case "codeBlock":
          runHandleCommand(chain.setCodeBlock().run(), "代码块");
          break;
        case "taskList":
          runHandleCommand(chain.toggleTaskList().run(), "待办清单");
          break;
        case "callout":
          if (editor.isActive("callout")) runHandleCommand(chain.lift("callout").run(), "高亮块");
          else runHandleCommand(chain.wrapIn("callout").run(), "高亮块");
          break;
      }
    },
    [editor, handle, resetMenuPlacement, runHandleCommand],
  );

  const doInsertImage = useCallback(() => {
    if (handle?.kind !== "block") return;
    if (!editor.isEditable) return;
    if (!getCurrentHandleNode(editor.state.doc, handle)) {
      setHandle(null);
      setMenuOpen(false);
      resetMenuPlacement();
      return;
    }
    setMenuOpen(false);
    const h = handle;
    setHandle(null);
    void pickFile("image/*").then(async (file) => {
      if (!file) return;
      if (!editor.isEditable) return;
      if (!seedInsertChain(h)?.run()) return;
      try {
        await insertImageAsset(editor, file);
      } catch (error) {
        console.error("[workspace] image upload failed", error);
        onToast?.(uploadFailureMessage(error, "图片上传失败，请重试"));
      }
    });
  }, [editor, onToast, handle, resetMenuPlacement, seedInsertChain]);

  const doInsertFile = useCallback(() => {
    if (handle?.kind !== "block") return;
    if (!editor.isEditable) return;
    if (!getCurrentHandleNode(editor.state.doc, handle)) {
      setHandle(null);
      setMenuOpen(false);
      resetMenuPlacement();
      return;
    }
    setMenuOpen(false);
    const h = handle;
    setHandle(null);
    void pickFile("*/*").then(async (file) => {
      if (!file) return;
      if (!editor.isEditable) return;
      if (!seedInsertChain(h)?.run()) return;
      try {
        await insertFileAsset(editor, file);
      } catch (error) {
        console.error("[workspace] file upload failed", error);
        onToast?.(uploadFailureMessage(error, "文件上传失败，请重试"));
      }
    });
  }, [editor, onToast, handle, resetMenuPlacement, seedInsertChain]);

  const handleAlign = useCallback(
    (align: "left" | "center" | "right") => {
      if (!handle) return;
      if (!editor.isEditable) return;
      if (!getCurrentHandleNode(editor.state.doc, handle)) {
        setHandle(null);
        setMenuOpen(false);
        resetMenuPlacement();
        return;
      }
      const h = handle;
      setMenuOpen(false);
      setHandle(null);
      editor.chain().focus().setTextSelection(h.insertPos).setTextAlign(align).run();
    },
    [editor, handle, resetMenuPlacement],
  );

  const deleteCurrentBlock = useCallback(() => {
    if (!handle) return;
    if (!editor.isEditable) return;
    const h = handle;
    const node = getCurrentHandleNode(editor.state.doc, h);
    if (!node) return;
    setMenuOpen(false);
    setHandle(null);
    editor
      .chain()
      .focus()
      .deleteRange({ from: h.blockPos, to: h.blockPos + node.nodeSize })
      .run();
  }, [editor, handle]);

  const writeBlockToClipboard = useCallback(
    async (isCut: boolean) => {
      if (!handle) return;
      if (isCut && !editor.isEditable) return;
      const h = handle;
      const node = getCurrentHandleNode(editor.state.doc, h);
      if (!node) return;
      const pmDoc = { type: "doc", content: [node.toJSON()] } as PmDoc;
      const html = pmToClipboardHtml(pmDoc);
      const plain = pmToPlainText(pmDoc);
      if (!html && !plain) return;
      const docBeforeClipboardWrite = editor.state.doc;

      try {
        await writeBlockClipboardPayload(html, plain);
        if (isCut) {
          if (!editor.isEditable) {
            onToast?.("已复制，当前为只读，未删除");
            return;
          }
          const currentDoc = editor.state.doc;
          const stableRange = resolveHandleRangeByStableId(currentDoc, h);
          const unchangedRange =
            currentDoc === docBeforeClipboardWrite &&
            getCurrentHandleNode(currentDoc, h)
              ? { from: h.blockPos, to: h.blockPos + node.nodeSize }
              : null;
          const range = stableRange ?? unchangedRange;
          if (!range) {
            onToast?.("已复制，原内容已变化，未删除");
            return;
          }
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .run();
        }
        onToast?.(isCut ? "已剪切" : "已复制");
      } catch (error) {
        console.warn("[workspace] block clipboard failed", error);
        onToast?.(isCut ? "剪切失败，请重试" : "复制失败，请重试");
      } finally {
        setMenuOpen(false);
        setHandle(null);
      }
    },
    [editor, handle, onToast],
  );

  const liveHandle =
    handle && getCurrentHandleNode(editor.state.doc, handle) ? handle : null;
  const tableMenuState = liveHandle?.kind === "block" && liveHandle.nodeType === "table"
    ? readTableBlockMenuState(getCurrentHandleNode(editor.state.doc, liveHandle))
    : null;

  const runTableMenuCommand = useCallback((command: "headerRow" | "headerColumn" | "evenColumns") => {
    if (!handle || handle.kind !== "block" || handle.nodeType !== "table" || !editor.isEditable) return;
    if (!getCurrentHandleNode(editor.state.doc, handle)) {
      setHandle(null);
      setMenuOpen(false);
      resetMenuPlacement();
      return;
    }
    const ok = command === "headerRow"
      ? toggleTableHeader(editor, handle.blockPos, "row")
      : command === "headerColumn"
        ? toggleTableHeader(editor, handle.blockPos, "column")
        : setEvenTableColumnWidths(editor, handle.blockPos);
    runHandleCommand(ok, command === "headerRow" ? "标题行" : command === "headerColumn" ? "标题列" : "均分列宽");
    if (ok) setHandle((current) => current ? { ...current } : current);
  }, [editor, handle, resetMenuPlacement, runHandleCommand]);

  // 拖拽排序:ProseMirror 原生 NodeSelection + view.dragging(move),drop 由 PM 处理、
  // dropcursor 出落点线。手柄是覆盖层元素,选区/插入位置都来自 hover 时存下的 handle,不依赖实时选区。
  const onDragStart = useCallback(
    (e: React.DragEvent) => {
      if (!handle || !editor.isEditable) {
        e.preventDefault();
        return;
      }
      if (!getCurrentHandleNode(editor.state.doc, handle)) {
        e.preventDefault();
        setHandle(null);
        setMenuOpen(false);
        resetMenuPlacement();
        return;
      }
      const { view } = editor;
      try {
        const payload = createBlockDragPayload(view, handle.blockPos);
        view.dispatch(view.state.tr.setSelection(payload.selection));
        (view as unknown as { dragging: typeof payload.dragging }).dragging = payload.dragging;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", "");
        if (handle.kind === "listItem") {
          e.dataTransfer.setData(
            LIST_ITEM_DND_MIME,
            JSON.stringify({ blockId: handle.blockId, pos: handle.blockPos }),
          );
        }
        e.dataTransfer.setDragImage(handle.blockEl, 12, 12);
      } catch {
        e.preventDefault();
        return;
      }
      draggingRef.current = true;
      setMenuOpen(false);
    },
    [editor, handle, resetMenuPlacement],
  );

  const onDragEnd = useCallback(() => {
    draggingRef.current = false;
    setHandle(null);
  }, []);

  const foldInfo = liveHandle
    ? getBlockCollapseInfo(editor.state, liveHandle.blockPos)
    : null;
  const onFoldToggle = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (!editor.isEditable) return;
      if (!foldInfo?.canToggle) return;
      toggleBlockCollapse(editor, foldInfo.blockId);
      setMenuOpen(false);
      setHandle((current) => (current ? { ...current } : current));
    },
    [editor, foldInfo?.blockId, foldInfo?.canToggle],
  );
  // 注:不再 early-return,因为折叠常驻三角(collapsedCarets)即使无 hover handle 也要渲染。
  // menuStyle/子菜单定位(dev 的块菜单)不访问 handle,可无条件计算;菜单 JSX 由
  // {liveHandle && ...} 守卫，transaction 后的旧位置不会进入 render 投影。
  const menuStyle =
    menuPos === null
      ? undefined
      : ({ top: menuPos.top, left: menuPos.left } as React.CSSProperties);
  const alignPlacement = submenuPlacement.align;
  const alignSubmenuStyle = alignPlacement
    ? ({
      "--bh-submenu-left": `${alignPlacement.left}px`,
      "--bh-submenu-top": `${alignPlacement.top}px`,
    } as React.CSSProperties)
    : undefined;
  const insertPlacement = submenuPlacement.insert;
  const insertSubmenuStyle = insertPlacement
    ? ({
      "--bh-submenu-left": `${insertPlacement.left}px`,
      "--bh-submenu-top": `${insertPlacement.top}px`,
    } as React.CSSProperties)
    : undefined;
  const submenuPortalTarget = typeof document === "undefined"
    ? null
    : (editor.view.dom.closest("#view-workspace") ?? document.body);
  const submenuPanels = (
    <>
      <div
        id="block-handle-align-submenu"
        ref={alignPanelRef}
        className={`bh-submenu-panel bh-submenu-portal${activeSubmenu === "align" ? " is-open" : ""}${alignPlacement?.side === "left" ? " is-left" : ""}`}
        role="menu"
        style={alignSubmenuStyle}
        onMouseEnter={keepSubmenuOpen}
        onMouseLeave={scheduleSubmenuClose}
        onFocus={keepSubmenuOpen}
        onBlur={(e) => closeSubmenuOnBlur(e, "align")}
      >
        <button type="button" role="menuitem" className="block-handle-item" onClick={() => handleAlign("left")}>
          <span className="bh-icon"><BlockHandleIcon name="alignLeft" /></span>
          左对齐
        </button>
        <button type="button" role="menuitem" className="block-handle-item" onClick={() => handleAlign("center")}>
          <span className="bh-icon"><BlockHandleIcon name="alignCenter" /></span>
          居中
        </button>
        <button type="button" role="menuitem" className="block-handle-item" onClick={() => handleAlign("right")}>
          <span className="bh-icon"><BlockHandleIcon name="alignRight" /></span>
          右对齐
        </button>
      </div>
      <div
        id="block-handle-insert-submenu"
        ref={insertPanelRef}
        className={`bh-submenu-panel bh-submenu-portal${activeSubmenu === "insert" ? " is-open" : ""}${insertPlacement?.side === "left" ? " is-left" : ""}`}
        role="menu"
        style={insertSubmenuStyle}
        onMouseEnter={keepSubmenuOpen}
        onMouseLeave={scheduleSubmenuClose}
        onMouseOver={closeTablePickerOnOtherMenuItem}
        onFocus={keepSubmenuOpen}
        onBlur={(e) => closeSubmenuOnBlur(e, "insert")}
      >
        <button type="button" role="menuitem" className="block-handle-item" onClick={doInsertImage}>
          <span className="bh-icon"><BlockHandleIcon name="image" /></span>
          插入图片
        </button>
        <button type="button" role="menuitem" className="block-handle-item" onClick={doInsertFile}>
          <span className="bh-icon"><BlockHandleIcon name="file" /></span>
          插入文件
        </button>
        <button type="button" role="menuitem" className="block-handle-item" onClick={() => insertBlock("inlineMath")}>
          <span className="bh-icon"><BlockHandleIcon name="inlineMath" /></span>
          行内公式
        </button>
        <button type="button" role="menuitem" className="block-handle-item" onClick={() => insertBlock("blockMath")}>
          <span className="bh-icon"><BlockHandleIcon name="blockMath" /></span>
          公式块
        </button>
        <button type="button" role="menuitem" className="block-handle-item" onClick={() => insertBlock("diagram")}>
          <span className="bh-icon"><BlockHandleIcon name="diagram" /></span>
          插入 Mermaid 图表
        </button>
        <button type="button" role="menuitem" className="block-handle-item" onClick={() => insertBlock("drawio")}>
          <span className="bh-icon"><BlockHandleIcon name="diagram" /></span>
          插入 drawio 工程图
        </button>
        <button
          type="button"
          role="menuitem"
          className="block-handle-item bh-submenu-trigger"
          data-table-picker-trigger=""
          aria-haspopup="dialog"
          aria-expanded={Boolean(tablePicker)}
          onMouseEnter={(event) => openTablePicker(event.currentTarget, false)}
          onFocus={(event) => openTablePicker(event.currentTarget, false)}
          onClick={(event) => {
            event.preventDefault();
            openTablePicker(event.currentTarget, true);
          }}
        >
          <span className="bh-icon"><BlockHandleIcon name="table" /></span>
          插入表格
          <span className="bh-caret"><BlockHandleIcon name="chevron" /></span>
        </button>
        <button type="button" role="menuitem" className="block-handle-item" onClick={() => insertBlock("columnList")}>
          <span className="bh-icon"><BlockHandleIcon name="columns" /></span>
          插入分栏
        </button>
        <button type="button" role="menuitem" className="block-handle-item" onClick={() => insertBlock("codeBlock")}>
          <span className="bh-icon"><BlockHandleIcon name="code" /></span>
          代码块
        </button>
        <button type="button" role="menuitem" className="block-handle-item" onClick={() => insertBlock("horizontalRule")}>
          <span className="bh-icon"><BlockHandleIcon name="divider" /></span>
          插入分隔线
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* 折叠态常驻三角:gutter 悬浮层(不进入内容),折叠态三角始终由它负责(hover 也不切换,避免跳动);
          hover 时只在它左边追加拖拽 chip(chip 折叠态左移让位)。 */}
      {collapsedCarets.map((c) => (
          <button
            key={c.blockId}
            type="button"
            className="block-fold-persist"
            aria-label="展开折叠内容"
            title="展开"
            style={{ position: "fixed", top: c.top, left: c.left, zIndex: 9 }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!editor.isEditable) return;
              toggleBlockCollapse(editor, c.blockId);
            }}
          >
            <svg className="block-fold-persist__icon" width="9" height="9" viewBox="0 0 9 9" aria-hidden="true" focusable="false">
              <path d="M2.4 1.6L6.4 4.5L2.4 7.4Z" fill="currentColor" />
            </svg>
          </button>
        ))}
      {liveHandle && (
        <>
    <div
      ref={wrapRef}
      className="block-handle-wrap"
      data-node-type={liveHandle.nodeType}
      data-block-handle-id={liveHandle.blockId ?? undefined}
      style={{
        position: "fixed",
        top: liveHandle.top,
        // 折叠态:常驻三角占住锚点槽位,拖拽 chip 左移让位,二者不重叠
        left: foldInfo?.collapsed ? liveHandle.left - 18 : liveHandle.left,
        zIndex: 100050,
      }}
      onMouseEnter={clearHideTimer}
      onMouseLeave={(e) => {
        if (menuOpen || draggingRef.current) return;
        const relatedTarget = e.relatedTarget;
        if (!(relatedTarget instanceof Node) || !editor.view.dom.contains(relatedTarget)) {
          hideTimer.current = setTimeout(() => setHandle(null), 200);
        }
      }}
    >
      <button
        type="button"
        className={`block-handle-btn${liveHandle.glyph === "+" ? " is-plus" : " is-chip"}`}
        aria-label={liveHandle.kind === "listItem" ? "拖拽列表行" : "块操作菜单(转换格式 / 插入)"}
        aria-haspopup={liveHandle.kind === "block" ? "menu" : undefined}
        aria-expanded={liveHandle.kind === "block" ? menuOpen : undefined}
        title={liveHandle.kind === "listItem" ? "拖拽排序" : "点击转换格式 · 拖拽排序"}
        draggable={editor.isEditable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={() => {
          if (!editor.isEditable) return;
          if (liveHandle.kind !== "block") return;
          if (menuOpen) {
            setMenuOpen(false);
            resetMenuPlacement();
            return;
          }
          openBlockMenu(liveHandle);
        }}
        onKeyDown={(e) => {
          if (!editor.isEditable) return;
          if (liveHandle.kind !== "block") return;
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          if (!menuOpen) {
            openBlockMenu(liveHandle);
            return;
          }
          menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
        }}
      >
        {liveHandle.glyph === "+" ? (
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M6.5 1.8v9.4M1.8 6.5h9.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        ) : (
          <span className="bh-chip-inner">
            <span className="bh-type">
              <HandleTypeIcon glyph={liveHandle.glyph} />
            </span>
            <svg className="bh-grip" width="7" height="13" viewBox="0 0 7 13" aria-hidden="true" focusable="false">
              <circle cx="1.6" cy="2.5" r="1.05" fill="currentColor" />
              <circle cx="5.4" cy="2.5" r="1.05" fill="currentColor" />
              <circle cx="1.6" cy="6.5" r="1.05" fill="currentColor" />
              <circle cx="5.4" cy="6.5" r="1.05" fill="currentColor" />
              <circle cx="1.6" cy="10.5" r="1.05" fill="currentColor" />
              <circle cx="5.4" cy="10.5" r="1.05" fill="currentColor" />
            </svg>
          </span>
        )}
      </button>
      {foldInfo?.canToggle && !foldInfo.collapsed && (
        <button
          type="button"
          className={`fold-toggle${foldInfo.collapsed ? " is-collapsed" : ""}`}
          aria-label={foldInfo.collapsed ? "展开折叠内容" : "折叠下级内容"}
          aria-pressed={foldInfo.collapsed}
          title={foldInfo.collapsed ? "展开" : "折叠"}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={onFoldToggle}
        >
          <svg className="fold-caret" width="9" height="9" viewBox="0 0 9 9" aria-hidden="true" focusable="false">
            <path d="M2.4 1.6L6.4 4.5L2.4 7.4Z" fill="currentColor" />
          </svg>
        </button>
      )}
    </div>
      {menuOpen && liveHandle.kind === "block" && (
        <div
          ref={menuRef}
          className={`block-handle-menu${menuFlipUp ? " flip-up" : ""}`}
          role="menu"
          style={menuStyle}
          onMouseEnter={keepSubmenuOpen}
          onMouseLeave={scheduleSubmenuClose}
          onMouseOver={closeTablePickerOnOtherMenuItem}
        >
          {tableMenuState ? null : <div className="bh-section-label">转换为</div>}
          {tableMenuState ? null : <div className="bh-grid">
            <button type="button" role="menuitem" className="bh-grid-btn" aria-label="正文" title="正文" onClick={() => convertBlock("paragraph")}><BlockHandleIcon name="paragraph" /></button>
            <button type="button" role="menuitem" className="bh-grid-btn" aria-label="一级标题" title="一级标题" onClick={() => convertBlock("heading", 1)}><BlockHandleIcon name="heading1" /></button>
            <button type="button" role="menuitem" className="bh-grid-btn" aria-label="二级标题" title="二级标题" onClick={() => convertBlock("heading", 2)}><BlockHandleIcon name="heading2" /></button>
            <button type="button" role="menuitem" className="bh-grid-btn" aria-label="三级标题" title="三级标题" onClick={() => convertBlock("heading", 3)}><BlockHandleIcon name="heading3" /></button>
            <button type="button" role="menuitem" className="bh-grid-btn" aria-label="无序列表" title="无序列表" onClick={() => convertBlock("bulletList")}><BlockHandleIcon name="bulletList" /></button>
            <button type="button" role="menuitem" className="bh-grid-btn" aria-label="有序列表" title="有序列表" onClick={() => convertBlock("orderedList")}><BlockHandleIcon name="orderedList" /></button>
            <button type="button" role="menuitem" className="bh-grid-btn" aria-label="引用" title="引用" onClick={() => convertBlock("blockquote")}><BlockHandleIcon name="quote" /></button>
            <button type="button" role="menuitem" className="bh-grid-btn" aria-label="代码块" title="代码块" onClick={() => convertBlock("codeBlock")}><BlockHandleIcon name="code" /></button>
            <button type="button" role="menuitem" className="bh-grid-btn" aria-label="待办清单" title="待办清单" onClick={() => convertBlock("taskList")}><BlockHandleIcon name="task" /></button>
            <button type="button" role="menuitem" className="bh-grid-btn" aria-label="高亮块" title="高亮块" onClick={() => convertBlock("callout")}><BlockHandleIcon name="callout" /></button>
          </div>}
          {tableMenuState ? null : <div className="bh-divider" />}
          {tableMenuState ? (
            <>
              <button type="button" role="menuitem" className="block-handle-item" onClick={() => void writeBlockToClipboard(true)}>
                <span className="bh-icon"><BlockHandleIcon name="cut" /></span>
                剪切
              </button>
              <button type="button" role="menuitem" className="block-handle-item" onClick={() => void writeBlockToClipboard(false)}>
                <span className="bh-icon"><BlockHandleIcon name="copy" /></span>
                复制
              </button>
              <button type="button" role="menuitem" className="block-handle-item is-danger" onClick={deleteCurrentBlock}>
                <span className="bh-icon"><BlockHandleIcon name="delete" /></span>
                删除
              </button>
              <div className="bh-divider" />
              <button type="button" role="menuitemcheckbox" aria-checked={tableMenuState.hasHeaderRow} className="block-handle-item" onClick={() => runTableMenuCommand("headerRow")}>
                <span className="bh-icon bh-menu-check">{tableMenuState.hasHeaderRow ? "✓" : ""}</span>
                标题行
              </button>
              <button type="button" role="menuitemcheckbox" aria-checked={tableMenuState.hasHeaderColumn} className="block-handle-item" onClick={() => runTableMenuCommand("headerColumn")}>
                <span className="bh-icon bh-menu-check">{tableMenuState.hasHeaderColumn ? "✓" : ""}</span>
                标题列
              </button>
              <button type="button" role="menuitem" className="block-handle-item" onClick={() => runTableMenuCommand("evenColumns")}>
                <span className="bh-icon"><BlockHandleIcon name="equalColumns" /></span>
                均分列宽
              </button>
              <div className="bh-divider" />
              <div
                className={`bh-submenu${insertPlacement?.side === "left" ? " is-left" : ""}`}
                onMouseEnter={(e) => placeSubmenu("insert", e.currentTarget)}
                onMouseLeave={scheduleSubmenuClose}
                onFocus={(e) => placeSubmenu("insert", e.currentTarget)}
                onBlur={(e) => closeSubmenuOnBlur(e, "insert")}
              >
                <button type="button" role="menuitem" className="block-handle-item bh-submenu-trigger" aria-haspopup="menu" aria-expanded={activeSubmenu === "insert"} aria-controls="block-handle-insert-submenu" onClick={(e) => e.preventDefault()}>
                  <span className="bh-icon"><BlockHandleIcon name="insert" /></span>
                  在下方添加
                  <span className="bh-caret"><BlockHandleIcon name="chevron" /></span>
                </button>
              </div>
            </>
          ) : !liveHandle.isEmpty ? (
            <>
              <div
                className={`bh-submenu${alignPlacement?.side === "left" ? " is-left" : ""}`}
                onMouseEnter={(e) => placeSubmenu("align", e.currentTarget)}
                onMouseLeave={scheduleSubmenuClose}
                onFocus={(e) => placeSubmenu("align", e.currentTarget)}
                onBlur={(e) => closeSubmenuOnBlur(e, "align")}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="block-handle-item bh-submenu-trigger"
                  aria-haspopup="menu"
                  aria-expanded={activeSubmenu === "align"}
                  aria-controls="block-handle-align-submenu"
                  onClick={(e) => e.preventDefault()}
                >
                  <span className="bh-icon"><BlockHandleIcon name="align" /></span>
                  对齐
                  <span className="bh-caret"><BlockHandleIcon name="chevron" /></span>
                </button>
              </div>
              <button type="button" role="menuitem" className="block-handle-item" onClick={() => void writeBlockToClipboard(false)}>
                <span className="bh-icon"><BlockHandleIcon name="copy" /></span>
                复制
              </button>
              <button type="button" role="menuitem" className="block-handle-item" onClick={() => void writeBlockToClipboard(true)}>
                <span className="bh-icon"><BlockHandleIcon name="cut" /></span>
                剪切
              </button>
              <button type="button" role="menuitem" className="block-handle-item is-danger" onClick={deleteCurrentBlock}>
                <span className="bh-icon"><BlockHandleIcon name="delete" /></span>
                删除
              </button>
              <div className="bh-divider" />
            </>
          ) : null}
          {!tableMenuState && liveHandle.isEmpty ? (
            <div className="bh-inline-insert">
              <button type="button" role="menuitem" className="block-handle-item" onClick={doInsertImage}>
                <span className="bh-icon"><BlockHandleIcon name="image" /></span>
                插入图片
              </button>
              <button type="button" role="menuitem" className="block-handle-item" onClick={doInsertFile}>
                <span className="bh-icon"><BlockHandleIcon name="file" /></span>
                插入文件
              </button>
              <button type="button" role="menuitem" className="block-handle-item" onClick={() => insertBlock("inlineMath")}>
                <span className="bh-icon"><BlockHandleIcon name="inlineMath" /></span>
                行内公式
              </button>
              <button type="button" role="menuitem" className="block-handle-item" onClick={() => insertBlock("blockMath")}>
                <span className="bh-icon"><BlockHandleIcon name="blockMath" /></span>
                公式块
              </button>
              <button type="button" role="menuitem" className="block-handle-item" onClick={() => insertBlock("diagram")}>
                <span className="bh-icon"><BlockHandleIcon name="diagram" /></span>
                插入 Mermaid 图表
              </button>
              <button type="button" role="menuitem" className="block-handle-item" onClick={() => insertBlock("drawio")}>
                <span className="bh-icon"><BlockHandleIcon name="diagram" /></span>
                插入 drawio 工程图
              </button>
              <button
                type="button"
                role="menuitem"
                className="block-handle-item bh-submenu-trigger"
                data-table-picker-trigger=""
                aria-haspopup="dialog"
                aria-expanded={Boolean(tablePicker)}
                onMouseEnter={(event) => openTablePicker(event.currentTarget, false)}
                onFocus={(event) => openTablePicker(event.currentTarget, false)}
                onClick={(event) => {
                  event.preventDefault();
                  openTablePicker(event.currentTarget, true);
                }}
              >
                <span className="bh-icon"><BlockHandleIcon name="table" /></span>
                插入表格
                <span className="bh-caret"><BlockHandleIcon name="chevron" /></span>
              </button>
              <button type="button" role="menuitem" className="block-handle-item" onClick={() => insertBlock("columnList")}>
                <span className="bh-icon"><BlockHandleIcon name="columns" /></span>
                插入分栏
              </button>
              <button type="button" role="menuitem" className="block-handle-item" onClick={() => insertBlock("codeBlock")}>
                <span className="bh-icon"><BlockHandleIcon name="code" /></span>
                代码块
              </button>
              <button type="button" role="menuitem" className="block-handle-item" onClick={() => insertBlock("horizontalRule")}>
                <span className="bh-icon"><BlockHandleIcon name="divider" /></span>
                插入分隔线
              </button>
            </div>
          ) : !tableMenuState ? (
            <div
              className={`bh-submenu${insertPlacement?.side === "left" ? " is-left" : ""}`}
              onMouseEnter={(e) => placeSubmenu("insert", e.currentTarget)}
              onMouseLeave={scheduleSubmenuClose}
              onFocus={(e) => placeSubmenu("insert", e.currentTarget)}
              onBlur={(e) => closeSubmenuOnBlur(e, "insert")}
            >
              <button
                type="button"
                role="menuitem"
                className="block-handle-item bh-submenu-trigger"
                aria-haspopup="menu"
                aria-expanded={activeSubmenu === "insert"}
                aria-controls="block-handle-insert-submenu"
                onClick={(e) => e.preventDefault()}
              >
                <span className="bh-icon"><BlockHandleIcon name="insert" /></span>
                插入
                <span className="bh-caret"><BlockHandleIcon name="chevron" /></span>
              </button>
            </div>
          ) : null}
        </div>
      )}
      {menuOpen && liveHandle.kind === "block" && submenuPortalTarget
        ? createPortal(submenuPanels, submenuPortalTarget)
        : null}
      {menuOpen && tablePicker ? (
        <TableSizePicker
          anchor={tablePicker.anchor}
          autoFocus={tablePicker.autoFocus}
          portalTarget={submenuPortalTarget ?? undefined}
          onSelect={insertTableBlock}
          onClose={() => setTablePicker(null)}
          onPointerEnter={keepSubmenuOpen}
          onPointerLeave={scheduleSubmenuClose}
        />
      ) : null}
        </>
      )}
    </>
  );
}

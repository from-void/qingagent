import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import {
  maskSensitiveAnnotationGroup,
  maskSensitiveValues,
  normalizeAnnotationSuggestion,
  type AnnotationGroup,
  type ReviewType,
} from "@qingagent/contract-ts";
import { CaretIcon } from "./icons";

const SHOW_DELAY_MS = 80;
const HIDE_DELAY_MS = 350;
const NAVIGATION_SCROLL_IDLE_MS = 200;
const VIEWPORT_GUTTER = 12;
const CARD_GAP = 8;

type HoveredAnnotation = {
  groupId: string;
  groupIds: string[];
  anchor: HTMLElement;
  anchorRect: DOMRect;
};

function annotationGroupIdsAtTarget(
  target: Element,
  editorDom: HTMLElement,
  groups: readonly AnnotationGroup[],
): string[] {
  const reviewingIds = new Set(groups.filter((group) => group.status === "reviewing").map((group) => group.id));
  const ids: string[] = [];
  let current: Element | null = target.closest(".annotation-anchor-active[data-annotation-group]");
  while (current && editorDom.contains(current)) {
    const encodedIds = current instanceof HTMLElement
      ? (current.dataset.annotationGroups?.split(",").filter(Boolean) ?? [current.dataset.annotationGroup].filter(Boolean))
      : [];
    for (const groupId of encodedIds) {
      if (groupId && reviewingIds.has(groupId) && !ids.includes(groupId)) ids.push(groupId);
    }
    current = current.parentElement?.closest(".annotation-anchor-active[data-annotation-group]") ?? null;
  }
  return ids;
}

export function buildAnnotationInstruction(group: AnnotationGroup, editedSuggestion?: string): string {
  const safeGroup = maskSensitiveAnnotationGroup(group);
  const anchor = safeGroup.anchors[0];
  const quoteChars = Array.from(compactAnnotationText(anchor?.quote ?? ""));
  const quote = quoteChars.length > 30 ? `${quoteChars.slice(0, 30).join("")}…` : quoteChars.join("");
  const summary = compactAnnotationText(safeGroup.summary);
  const suggestion = compactAnnotationText(resolveAnnotationSuggestion(safeGroup, editedSuggestion));
  if (!suggestion) return "";
  const action = summary ? `${summary}——${suggestion}` : suggestion;
  return `按批注修改：${action}${quote ? `（原文：『${quote}』）` : ""}`;
}

function compactAnnotationText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export function resolveAnnotationSuggestion(
  group: AnnotationGroup,
  editedSuggestion?: string,
): string {
  const suggestion = normalizeAnnotationSuggestion(
    group.note,
    editedSuggestion === undefined ? group.suggestion : editedSuggestion,
  ) ?? "";
  return group.origin === "privacy" || group.origin === "sensitive"
    ? maskSensitiveValues(suggestion)
    : suggestion;
}

// 用户裁定:批注分级用优先级词(高优/中优/低优),不用「严重」这类成文口吻。
const SEVERITY_LABELS = { error: "高优", warn: "中优", info: "低优" } as const;

const REVIEW_TYPE_LABELS: Readonly<Record<ReviewType, string>> = {
  sensitive: "敏感词",
  deai: "去 AI 味",
  source: "来源核查",
  consistency: "一致性",
  privacy: "隐私",
  format: "格式",
  role: "角色审查",
  custom: "自定义审查",
};

const REVIEW_ORIGIN_LABELS: Readonly<Record<string, string>> = {
  ...REVIEW_TYPE_LABELS,
  "source-check": "来源核查",
  "role-review": "角色审查",
  "custom-review": "自定义审查",
  "external-plugin": "青简插件",
  "system-parse-error": "审查异常",
};

export function reviewOriginLabel(origin: string): string {
  const normalized = origin.trim();
  const label = REVIEW_ORIGIN_LABELS[normalized];
  if (label) return label;
  return /[\p{Script=Han}]/u.test(normalized) ? normalized : "其他审查";
}

export function buildAnnotationSeveritySummary(groups: readonly AnnotationGroup[]): string | null {
  if (!groups.some((group) => group.severity !== undefined)) return null;
  const counts = { error: 0, warn: 0, info: 0 };
  for (const group of groups) counts[group.severity ?? "warn"] += 1;
  return (["error", "warn", "info"] as const)
    .filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${SEVERITY_LABELS[severity]}`)
    .join(" · ");
}

export function AnnotationCarousel(props: {
  groups: readonly AnnotationGroup[];
  editorDom: HTMLElement | null;
  onAccept: (group: AnnotationGroup, suggestion: string) => boolean;
  onIgnore: (group: AnnotationGroup) => void;
}) {
  const [hovered, setHovered] = useState<HoveredAnnotation | null>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const [suggestions, setSuggestions] = useState<Record<string, string>>({});
  const cardRef = useRef<HTMLElement>(null);
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const navigationScrollRef = useRef(false);
  const navigationScrollTimerRef = useRef<number | null>(null);
  const navigationFrameRef = useRef<number | null>(null);
  const pinnedRef = useRef(false);
  const hoveredKeyRef = useRef<string | null>(null);
  hoveredKeyRef.current = hovered ? `${hovered.groupId}:${hovered.groupIds.join(",")}` : null;

  const clearTimer = (timerRef: typeof showTimerRef) => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const cancelHide = () => clearTimer(hideTimerRef);
  const clearNavigationFrame = () => {
    if (navigationFrameRef.current === null) return;
    window.cancelAnimationFrame(navigationFrameRef.current);
    navigationFrameRef.current = null;
  };
  const protectNavigationScroll = () => {
    navigationScrollRef.current = true;
    clearTimer(navigationScrollTimerRef);
    navigationScrollTimerRef.current = window.setTimeout(() => {
      navigationScrollTimerRef.current = null;
      navigationScrollRef.current = false;
    }, NAVIGATION_SCROLL_IDLE_MS);
  };
  const closeCard = () => {
    clearTimer(showTimerRef);
    clearTimer(hideTimerRef);
    clearTimer(navigationScrollTimerRef);
    clearNavigationFrame();
    navigationScrollRef.current = false;
    pinnedRef.current = false;
    setHovered(null);
  };
  const scheduleHide = () => {
    if (pinnedRef.current) {
      cancelHide();
      return;
    }
    clearTimer(hideTimerRef);
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      if (pinnedRef.current) return;
      setHovered(null);
    }, HIDE_DELAY_MS);
  };
  const pinCard = () => {
    pinnedRef.current = true;
    clearTimer(showTimerRef);
    cancelHide();
  };

  useEffect(() => {
    const editorDom = props.editorDom;
    if (!editorDom) return;

    const onMouseOver = (event: globalThis.MouseEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>(".annotation-anchor-active[data-annotation-group]")
        : null;
      if (!target || !editorDom.contains(target)) return;
      const groupIds = annotationGroupIdsAtTarget(event.target as Element, editorDom, props.groups);
      const groupId = groupIds[0];
      if (!groupId) return;
      cancelHide();
      if (pinnedRef.current) return;
      if (hoveredKeyRef.current === `${groupId}:${groupIds.join(",")}`) return;
      clearTimer(showTimerRef);
      showTimerRef.current = window.setTimeout(() => {
        showTimerRef.current = null;
        if (!target.isConnected) return;
        setPosition({ visibility: "hidden" });
        setHovered({ groupId, groupIds, anchor: target, anchorRect: target.getBoundingClientRect() });
      }, SHOW_DELAY_MS);
    };
    const onMouseOut = (event: globalThis.MouseEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>(".annotation-anchor-active[data-annotation-group]")
        : null;
      if (!target || !editorDom.contains(target)) return;
      const related = event.relatedTarget;
      if (related instanceof Node && target.contains(related)) return;
      if (related instanceof Node && cardRef.current?.contains(related)) return;
      clearTimer(showTimerRef);
      scheduleHide();
    };
    const closeOnViewportChange = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && cardRef.current?.contains(target)) return;
      if (event.type === "scroll" && navigationScrollRef.current) {
        protectNavigationScroll();
        return;
      }
      closeCard();
    };
    const closeOnOutsideMouseDown = (event: globalThis.MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && cardRef.current?.contains(target)) return;
      closeCard();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCard();
    };
    editorDom.addEventListener("mouseover", onMouseOver);
    editorDom.addEventListener("mouseout", onMouseOut);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    document.addEventListener("mousedown", closeOnOutsideMouseDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      editorDom.removeEventListener("mouseover", onMouseOver);
      editorDom.removeEventListener("mouseout", onMouseOut);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
      document.removeEventListener("mousedown", closeOnOutsideMouseDown);
      document.removeEventListener("keydown", closeOnEscape);
      clearTimer(showTimerRef);
      clearTimer(hideTimerRef);
      clearTimer(navigationScrollTimerRef);
      clearNavigationFrame();
      navigationScrollRef.current = false;
    };
  }, [props.editorDom, props.groups]);

  useEffect(() => {
    if (hovered && !props.groups.some((group) => group.id === hovered.groupId && group.status === "reviewing")) {
      closeCard();
    }
  }, [hovered, props.groups]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !hovered) return;
    const cardRect = card.getBoundingClientRect();
    const maxLeft = Math.max(VIEWPORT_GUTTER, window.innerWidth - cardRect.width - VIEWPORT_GUTTER);
    const left = Math.min(maxLeft, Math.max(VIEWPORT_GUTTER, hovered.anchorRect.left));
    const fitsAbove = hovered.anchorRect.top - cardRect.height - CARD_GAP >= VIEWPORT_GUTTER;
    const top = fitsAbove
      ? hovered.anchorRect.top - cardRect.height - CARD_GAP
      : Math.min(window.innerHeight - cardRect.height - VIEWPORT_GUTTER, hovered.anchorRect.bottom + CARD_GAP);
    setPosition({ left, top: Math.max(VIEWPORT_GUTTER, top), visibility: "visible" });
  }, [hovered]);

  const reviewingGroups = props.groups
    .filter((item) => item.status === "reviewing")
    .map(maskSensitiveAnnotationGroup);
  const group = hovered
    ? reviewingGroups.find((item) => item.id === hovered.groupId)
    : undefined;
  if (!group) return null;

  const groupIndex = reviewingGroups.findIndex((item) => item.id === group.id);
  const hitGroups = (hovered?.groupIds ?? [])
    .map((id) => reviewingGroups.find((item) => item.id === id))
    .filter((item): item is AnnotationGroup => item !== undefined);
  const hitIndex = hitGroups.findIndex((item) => item.id === group.id);
  const hasOverlap = hitGroups.length > 1;
  const storedSuggestion = resolveAnnotationSuggestion(group);
  const suggestion = suggestions[group.id] ?? storedSuggestion;
  const resolvedSuggestion = resolveAnnotationSuggestion(group, suggestion);
  // 用户裁定(与插件批注 chip 面板同款交互):按钮默认置灰,修改意见内容与初值
  // 不一致时才点亮;置灰 hover 提示引导先修改。
  const initialSuggestion = resolveAnnotationSuggestion(group, undefined);
  const suggestionChanged = resolvedSuggestion.trim() !== initialSuggestion.trim();
  const hasSuggestedChange = storedSuggestion.length > 0;

  const keepOpen = () => {
    cancelHide();
  };
  const leaveCard = (event: ReactMouseEvent<HTMLElement>) => {
    const related = event.relatedTarget;
    if (related instanceof Node && props.editorDom?.contains(related)) {
      const element = related instanceof Element ? related : related.parentElement;
      if (element?.closest(".annotation-anchor-active")) return;
    }
    scheduleHide();
  };
  const moveGroup = (delta: -1 | 1) => {
    pinCard();
    if (hasOverlap && hovered && hitIndex >= 0) {
      const nextGroup = hitGroups[(hitIndex + delta + hitGroups.length) % hitGroups.length];
      if (!nextGroup) return;
      setHovered({ ...hovered, groupId: nextGroup.id });
      return;
    }
    if (reviewingGroups.length < 2 || groupIndex < 0) return;
    const nextGroup = reviewingGroups[(groupIndex + delta + reviewingGroups.length) % reviewingGroups.length];
    if (!nextGroup) return;
    const target = Array.from(
      props.editorDom?.querySelectorAll<HTMLElement>(".annotation-anchor-active[data-annotation-group]") ?? [],
    ).find((anchor) => anchor.dataset.annotationGroup === nextGroup.id);
    if (!target) return;
    clearNavigationFrame();
    protectNavigationScroll();
    target.scrollIntoView?.({ block: "center", behavior: "auto" });
    setHovered({ groupId: nextGroup.id, groupIds: [nextGroup.id], anchor: target, anchorRect: target.getBoundingClientRect() });
    navigationFrameRef.current = window.requestAnimationFrame(() => {
      navigationFrameRef.current = null;
      if (!target.isConnected) {
        closeCard();
        return;
      }
      setHovered((current) => current?.groupId === nextGroup.id
        ? { ...current, anchor: target, anchorRect: target.getBoundingClientRect() }
        : current);
    });
  };

  return <article
    ref={cardRef}
    className="annotation-hover-card"
    data-wf="AnnotationHoverCard"
    data-group-id={group.id}
    role="dialog"
    aria-label={`批注：${group.summary}`}
    style={position}
    onMouseEnter={keepOpen}
    onMouseLeave={leaveCard}
    onClickCapture={pinCard}
  >
    <div className="ahc-body">
      <header className="ahc-head">
        <div className="ahc-title-row">
          <strong>{group.summary}</strong>
          <div className="ahc-nav" aria-label="批注位置">
            {/* 用户裁定:导航只留「n/N」,严重度汇总等冗余信息全部去掉。 */}
            <span className="ahc-count">{hasOverlap
              ? <>{hitIndex + 1}/{hitGroups.length}</>
              : <>{groupIndex + 1}/{reviewingGroups.length}</>}</span>
            <button type="button" aria-label="上一处批注" disabled={(hasOverlap ? hitGroups : reviewingGroups).length < 2} onClick={() => moveGroup(-1)}><CaretIcon size={13} direction="left" /></button>
            <button type="button" aria-label="下一处批注" disabled={(hasOverlap ? hitGroups : reviewingGroups).length < 2} onClick={() => moveGroup(1)}><CaretIcon size={13} direction="right" /></button>
          </div>
        </div>
      </header>
      {/* 用户裁定:去掉来源/优先级独立行;优先级做成小标签跟在「批注原因」后。 */}
      <section className="ahc-reason" aria-label="批注原因">
        <span>批注原因{group.severity
          ? <span className="ahc-severity" data-severity={group.severity}>{SEVERITY_LABELS[group.severity]}</span>
          : null}</span>
        <p>{group.note}</p>
      </section>
      {hasSuggestedChange ? <section className="ahc-suggestion" aria-label="修改意见">
        <label htmlFor={`annotation-suggestion-${group.id}`}>修改意见</label>
        <textarea
          id={`annotation-suggestion-${group.id}`}
          rows={3}
          value={suggestion}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setSuggestions((current) => ({ ...current, [group.id]: value }));
          }}
        />
      </section> : null}
    </div>
    <footer>
      <div className="ahc-ignore-actions">
        <button className="ahc-ignore" type="button" onClick={() => { props.onIgnore(group); closeCard(); }}>忽略</button>
      </div>
      {hasSuggestedChange ? <div className="ahc-accept-actions">
        <button
          className="ahc-accept"
          type="button"
          title={suggestionChanged && resolvedSuggestion ? "将追加到输入框，由你确认发送" : "请先修改内容"}
          disabled={!resolvedSuggestion || !suggestionChanged}
          onClick={() => { if (resolvedSuggestion && suggestionChanged && props.onAccept(group, resolvedSuggestion)) closeCard(); }}
        >生成修改</button>
      </div> : null}
    </footer>
  </article>;
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import {
  maskSensitiveAnnotationGroup,
  maskSensitiveValues,
  type AnnotationGroup,
} from "@qingagent/contract-ts";
import { CaretIcon } from "./icons";

const SHOW_DELAY_MS = 80;
const HIDE_DELAY_MS = 150;
const VIEWPORT_GUTTER = 12;
const CARD_GAP = 8;

type HoveredAnnotation = {
  groupId: string;
  groupIds: string[];
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
  const quoteChars = Array.from(anchor?.quote.trim() ?? "");
  const quote = quoteChars.length > 30 ? `${quoteChars.slice(0, 30).join("")}…` : quoteChars.join("");
  const suggestion = resolveAnnotationSuggestion(safeGroup, editedSuggestion);
  const location = anchor
    ? `块 ${anchor.blockId}，PM ${anchor.pmFrom}-${anchor.pmTo}`
    : "原批注锚点";
  return `按批注修改：「${quote}」——${suggestion}（批注：${safeGroup.summary}；原因：${safeGroup.note}；定位：${location}）`;
}

export function resolveAnnotationSuggestion(
  group: AnnotationGroup,
  editedSuggestion?: string,
): string {
  if (editedSuggestion !== undefined) {
    const suggestion = editedSuggestion.trim() || group.note.trim();
    return group.origin === "privacy" || group.origin === "sensitive"
      ? maskSensitiveValues(suggestion)
      : suggestion;
  }
  return group.suggestion?.trim() || group.note.trim();
}

const SEVERITY_LABELS = { error: "严重", warn: "建议", info: "提示" } as const;

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
  onIgnore: (group: AnnotationGroup, rememberDismissal: boolean) => void;
}) {
  const [hovered, setHovered] = useState<HoveredAnnotation | null>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const [suggestions, setSuggestions] = useState<Record<string, string>>({});
  const cardRef = useRef<HTMLElement>(null);
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const navigationScrollRef = useRef(false);
  const hoveredKeyRef = useRef<string | null>(null);
  hoveredKeyRef.current = hovered ? `${hovered.groupId}:${hovered.groupIds.join(",")}` : null;

  const clearTimer = (timerRef: typeof showTimerRef) => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const cancelHide = () => clearTimer(hideTimerRef);
  const hideNow = () => {
    clearTimer(showTimerRef);
    clearTimer(hideTimerRef);
    setHovered(null);
  };
  const scheduleHide = () => {
    clearTimer(hideTimerRef);
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setHovered(null);
    }, HIDE_DELAY_MS);
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
      if (hoveredKeyRef.current === `${groupId}:${groupIds.join(",")}`) return;
      clearTimer(showTimerRef);
      showTimerRef.current = window.setTimeout(() => {
        showTimerRef.current = null;
        if (!target.isConnected) return;
        setPosition({ visibility: "hidden" });
        setHovered({ groupId, groupIds, anchorRect: target.getBoundingClientRect() });
      }, SHOW_DELAY_MS);
    };
    const onMouseOut = (event: globalThis.MouseEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>(".annotation-anchor-active[data-annotation-group]")
        : null;
      if (!target || !editorDom.contains(target)) return;
      const related = event.relatedTarget;
      if (related instanceof Node && (target.contains(related) || cardRef.current?.contains(related))) return;
      clearTimer(showTimerRef);
      scheduleHide();
    };
    const closeOnViewportChange = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && cardRef.current?.contains(target)) return;
      if (event.type === "scroll" && navigationScrollRef.current) return;
      hideNow();
    };
    editorDom.addEventListener("mouseover", onMouseOver);
    editorDom.addEventListener("mouseout", onMouseOut);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      editorDom.removeEventListener("mouseover", onMouseOver);
      editorDom.removeEventListener("mouseout", onMouseOut);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
      clearTimer(showTimerRef);
      clearTimer(hideTimerRef);
    };
  }, [props.editorDom, props.groups]);

  useEffect(() => {
    if (hovered && !props.groups.some((group) => group.id === hovered.groupId && group.status === "reviewing")) {
      hideNow();
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
  const suggestion = suggestions[group.id]
    ?? (group.suggestion?.trim() || group.note.trim());
  const resolvedSuggestion = resolveAnnotationSuggestion(group, suggestion);
  const severitySummary = buildAnnotationSeveritySummary(reviewingGroups);

  const keepOpen = () => cancelHide();
  const leaveCard = (event: ReactMouseEvent<HTMLElement>) => {
    const related = event.relatedTarget;
    if (related instanceof Node && props.editorDom?.contains(related)) {
      const element = related instanceof Element ? related : related.parentElement;
      if (element?.closest(".annotation-anchor-active")) return;
    }
    scheduleHide();
  };
  const moveGroup = (delta: -1 | 1) => {
    cancelHide();
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
    navigationScrollRef.current = true;
    target.scrollIntoView?.({ block: "center", behavior: "auto" });
    setPosition({ visibility: "hidden" });
    setHovered({ groupId: nextGroup.id, groupIds: [nextGroup.id], anchorRect: target.getBoundingClientRect() });
    requestAnimationFrame(() => {
      if (target.isConnected) {
        setPosition({ visibility: "hidden" });
        setHovered({ groupId: nextGroup.id, groupIds: [nextGroup.id], anchorRect: target.getBoundingClientRect() });
      }
      requestAnimationFrame(() => {
        navigationScrollRef.current = false;
      });
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
  >
    <div className="ahc-body">
      <header className="ahc-head">
        <div className="ahc-title-row">
          <strong>{group.summary}</strong>
          <div className="ahc-nav" aria-label="批注位置">
            <span className="ahc-count">{hasOverlap
              ? <>此处 {hitGroups.length} 条 · 第 {hitIndex + 1} / 共 {hitGroups.length} 条{severitySummary ? ` · ${severitySummary}` : ""}</>
              : <>第 {groupIndex + 1} / 共 {reviewingGroups.length} 处{severitySummary ? ` · ${severitySummary}` : ""}</>}</span>
            <button type="button" aria-label="上一处批注" disabled={(hasOverlap ? hitGroups : reviewingGroups).length < 2} onClick={() => moveGroup(-1)}><CaretIcon size={13} direction="left" /></button>
            <button type="button" aria-label="下一处批注" disabled={(hasOverlap ? hitGroups : reviewingGroups).length < 2} onClick={() => moveGroup(1)}><CaretIcon size={13} direction="right" /></button>
          </div>
        </div>
        <div className="ahc-meta">
          {group.origin ? <span className="ahc-origin">{group.origin}</span> : null}
          {group.severity ? <span className="ahc-severity" data-severity={group.severity}>{SEVERITY_LABELS[group.severity]}</span> : null}
        </div>
      </header>
      <section className="ahc-reason" aria-label="批注原因">
        <span>批注原因</span>
        <p>{group.note}</p>
      </section>
      <section className="ahc-suggestion" aria-label="修改意见">
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
      </section>
    </div>
    <footer>
      <div className="ahc-ignore-actions">
        <button className="ahc-ignore" type="button" onClick={() => { props.onIgnore(group, false); hideNow(); }}>忽略</button>
        <button className="ahc-ignore-remember" type="button" onClick={() => { props.onIgnore(group, true); hideNow(); }}>下次不再提示</button>
      </div>
      <div className="ahc-accept-actions">
        <span>将追加到输入框，由你确认发送</span>
        <button
          className="ahc-accept"
          type="button"
          disabled={!resolvedSuggestion}
          onClick={() => { if (resolvedSuggestion && props.onAccept(group, resolvedSuggestion)) hideNow(); }}
        >生成修改</button>
      </div>
    </footer>
  </article>;
}

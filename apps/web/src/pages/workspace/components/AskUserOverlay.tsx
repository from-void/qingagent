import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@qingagent/ui-kit";
import type {
  AskUserAnswer,
  AskUserAnswers,
  AskUserOption,
  AskUserQuestion,
  AskUserSpec,
} from "../data/protocol";
import { AskUserPreview } from "./AskUserPreview";
import { SliderQuestionInput, defaultSliderValue } from "./SliderQuestionInput";
import { CheckIcon } from "./icons";

export interface AskUserOverlayProps {
  spec: AskUserSpec;
  onClose: () => void;
  onSubmit: (answers: AskUserAnswers) => void;
  onAbort: () => void;
}

function emptyAnswer(): AskUserAnswer {
  return { chosen: [], freeText: null };
}

function initialAnswers(qs: AskUserQuestion[]): AskUserAnswers {
  const out: AskUserAnswers = {};
  for (const q of qs) out[q.id] = emptyAnswer();
  return out;
}

function reconcileAnswers(
  previous: AskUserAnswers,
  questions: readonly AskUserQuestion[],
): AskUserAnswers {
  const next: AskUserAnswers = {};
  for (const question of questions) {
    next[question.id] = previous[question.id] ?? emptyAnswer();
  }
  return next;
}

function hasMeaningfulAnswer(answer: AskUserAnswer | undefined): boolean {
  if (!answer) return false;
  if ((answer.chosen ?? []).length > 0) return true;
  if ((answer.freeText ?? "").trim().length > 0) return true;
  return typeof answer.numericValue === "number" && Number.isFinite(answer.numericValue);
}

function isRequiredQuestion(q: AskUserQuestion): boolean {
  return q.kind.kind === "single" || q.kind.kind === "multi";
}

function answersWithSubmitSemantics(
  questions: readonly AskUserQuestion[],
  answers: AskUserAnswers,
  customActive: Readonly<Record<string, boolean>>,
): AskUserAnswers {
  const out: AskUserAnswers = {};
  for (const question of questions) {
    const answer = answers[question.id] ?? emptyAnswer();
    if (question.kind.kind === "single") {
      const useCustom = customActive[question.id] === true
        && (answer.freeText ?? "").trim().length > 0;
      out[question.id] = useCustom
        ? { ...answer, chosen: [] }
        : { ...answer, freeText: null };
      continue;
    }
    if (
      question.kind.kind === "slider"
      && question.slider
      && answer.numericValue == null
    ) {
      out[question.id] = {
        ...answer,
        chosen: answer.chosen ?? [],
        freeText: answer.freeText ?? null,
        numericValue: defaultSliderValue(question.slider),
      };
      continue;
    }
    out[question.id] = answer;
  }
  return out;
}

function canSubmitAnswers(
  questions: readonly AskUserQuestion[],
  answers: AskUserAnswers,
): boolean {
  if (questions.length === 0) return false;
  const requiredReady = questions
    .filter(isRequiredQuestion)
    .every((question) => hasMeaningfulAnswer(answers[question.id]));
  return requiredReady && questions.some((question) => hasMeaningfulAnswer(answers[question.id]));
}

function isTextEditingElement(
  target: EventTarget | null,
): target is HTMLInputElement | HTMLTextAreaElement {
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return ["email", "number", "password", "search", "tel", "text", "url"].includes(target.type);
}

export function AskUserOverlay({
  spec,
  onClose,
  onSubmit,
  onAbort,
}: AskUserOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const focusEntryOnQuestionChangeRef = useRef(false);
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const specIdRef = useRef(spec.id);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<AskUserAnswers>(() => initialAnswers(spec.questions));
  const [customActive, setCustomActive] = useState<Record<string, boolean>>({});
  const [scrollEdge, setScrollEdge] = useState({ top: true, bottom: true });
  const [tabScrollEdge, setTabScrollEdge] = useState({ left: true, right: true });
  const answersRef = useRef(answers);
  const customActiveRef = useRef(customActive);
  const currentIndexRef = useRef(currentIndex);
  const questionsRef = useRef(spec.questions);
  const anchorRef = useRef<HTMLDivElement>(null);
  const [portalStyle, setPortalStyle] = useState<React.CSSProperties | null>(null);

  answersRef.current = answers;
  customActiveRef.current = customActive;
  currentIndexRef.current = currentIndex;
  questionsRef.current = spec.questions;

  const updateScrollEdge = () => {
    const el = bodyRef.current;
    if (!el) return;
    const top = el.scrollTop <= 1;
    const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    setScrollEdge((prev) =>
      prev.top === top && prev.bottom === bottom ? prev : { top, bottom },
    );
  };

  const updateTabScrollEdge = () => {
    const el = tabsRef.current;
    if (!el) return;
    const left = el.scrollLeft <= 1;
    const right = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    setTabScrollEdge((previous) =>
      previous.left === left && previous.right === right ? previous : { left, right },
    );
  };

  const getQuestionFocusItems = () => Array.from(
    overlayRef.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      '[data-au-option="true"], [data-au-custom-input="true"]',
    ) ?? [],
  ).filter((element) => !element.disabled);

  const focusQuestionEntry = () => {
    getQuestionFocusItems()[0]?.focus({ preventScroll: true });
  };

  // 同一问卷流式追加问题时保留现有答案；只有 spec.id 变化才开启全新一轮。
  useEffect(() => {
    const isNewSpec = specIdRef.current !== spec.id;
    specIdRef.current = spec.id;
    setAnswers((previous) =>
      isNewSpec ? initialAnswers(spec.questions) : reconcileAnswers(previous, spec.questions),
    );
    setCustomActive((previous) => {
      if (isNewSpec) return {};
      const next: Record<string, boolean> = {};
      for (const question of spec.questions) {
        const active = previous[question.id];
        if (active !== undefined) next[question.id] = active;
      }
      return next;
    });
    setCurrentIndex((previous) => isNewSpec
      ? 0
      : Math.min(previous, Math.max(0, spec.questions.length - 1)));
  }, [spec.id, spec.questions]);

  useEffect(() => {
    updateScrollEdge();
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      const raf = requestAnimationFrame(updateScrollEdge);
      return () => cancelAnimationFrame(raf);
    }
    const ro = new ResizeObserver(() => updateScrollEdge());
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    const raf = requestAnimationFrame(updateScrollEdge);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [currentIndex, spec.questions]);

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) {
      setTabScrollEdge({ left: true, right: true });
      return;
    }
    updateTabScrollEdge();
    const activeTab = el.querySelectorAll<HTMLButtonElement>(".auq-tab")[currentIndex];
    activeTab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const raf = requestAnimationFrame(updateTabScrollEdge);
    if (typeof ResizeObserver === "undefined") {
      return () => cancelAnimationFrame(raf);
    }
    const ro = new ResizeObserver(updateTabScrollEdge);
    ro.observe(el);
    for (const tab of Array.from(el.children)) ro.observe(tab);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [currentIndex, spec.questions]);

  useEffect(() => {
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusQuestionEntry();

    return () => {
      if (previousActiveElement?.isConnected) {
        previousActiveElement.focus({ preventScroll: true });
      }
    };
  }, [spec.id]);

  useEffect(() => () => {
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
    }
  }, [spec.id]);

  const answersForSubmit = useMemo(
    () => answersWithSubmitSemantics(spec.questions, answers, customActive),
    [answers, customActive, spec.questions],
  );
  const requiredQuestions = spec.questions.filter(isRequiredQuestion);
  const answeredRequiredCount = requiredQuestions.filter((question) =>
    hasMeaningfulAnswer(answersForSubmit[question.id]),
  ).length;
  const isLoading = spec.questions.length === 0;
  const canSubmit = canSubmitAnswers(spec.questions, answersForSubmit);
  const currentQuestion = spec.questions[currentIndex] ?? null;
  const hasPreview = currentQuestion?.options.some((option) => Boolean(option.preview?.trim())) ?? false;

  useLayoutEffect(() => {
    if (!focusEntryOnQuestionChangeRef.current) return;
    focusEntryOnQuestionChangeRef.current = false;
    focusQuestionEntry();
  }, [currentIndex]);

  useLayoutEffect(() => {
    if (!hasPreview) {
      setPortalStyle(null);
      return;
    }
    const updatePlacement = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPortalStyle({
        "--au-portal-left": `${rect.left}px`,
        "--au-portal-bottom": `${Math.max(12, window.innerHeight - rect.bottom)}px`,
        "--au-portal-max-width": `${Math.max(420, window.innerWidth - rect.left - 12)}px`,
      } as React.CSSProperties);
    };
    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [hasPreview]);

  const scheduleAutoAdvance = (qid: string) => {
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
    }
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      const questions = questionsRef.current;
      const activeIndex = currentIndexRef.current;
      if (questions[activeIndex]?.id !== qid) return;
      const submitted = answersWithSubmitSemantics(
        questions,
        answersRef.current,
        customActiveRef.current,
      );
      const searchOrder = [
        ...questions.slice(activeIndex + 1).map((_, offset) => activeIndex + 1 + offset),
        ...questions.slice(0, activeIndex).map((_, index) => index),
      ];
      const nextIndex = searchOrder.find((index) =>
        !hasMeaningfulAnswer(submitted[questions[index]!.id]),
      );
      if (nextIndex !== undefined) {
        focusEntryOnQuestionChangeRef.current = true;
        setCurrentIndex(nextIndex);
      }
    }, 350);
  };

  const setSingle = (qid: string, value: string) => {
    setCustomActive((previous) => ({ ...previous, [qid]: false }));
    setAnswers((previous) => ({
      ...previous,
      [qid]: { ...previous[qid], chosen: [value], freeText: previous[qid]?.freeText ?? null },
    }));
    scheduleAutoAdvance(qid);
  };

  const toggleMulti = (qid: string, value: string) => {
    setAnswers((previous) => {
      const current = previous[qid]?.chosen ?? [];
      const nextChosen = current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value];
      return {
        ...previous,
        [qid]: { ...previous[qid], chosen: nextChosen, freeText: previous[qid]?.freeText ?? null },
      };
    });
  };

  const setOtherText = (qid: string, value: string) => {
    const question = questionsRef.current.find((item) => item.id === qid);
    const activatesCustom = question?.kind.kind === "single" && value.trim().length > 0;
    if (question?.kind.kind === "single") {
      setCustomActive((previous) => ({ ...previous, [qid]: activatesCustom }));
    }
    setAnswers((previous) => ({
      ...previous,
      [qid]: {
        ...previous[qid],
        chosen: activatesCustom ? [] : previous[qid]?.chosen ?? [],
        freeText: value,
      },
    }));
  };

  const setNumeric = (qid: string, value: number) => {
    setAnswers((previous) => ({
      ...previous,
      [qid]: {
        ...previous[qid],
        chosen: previous[qid]?.chosen ?? [],
        freeText: previous[qid]?.freeText ?? null,
        numericValue: value,
      },
    }));
  };

  const moveToQuestion = (index: number, focusEntry = false) => {
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
    const nextIndex = Math.max(0, Math.min(index, spec.questions.length - 1));
    if (focusEntry) {
      if (nextIndex === currentIndexRef.current) {
        focusQuestionEntry();
      } else {
        focusEntryOnQuestionChangeRef.current = true;
      }
    }
    setCurrentIndex(nextIndex);
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % spec.questions.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + spec.questions.length) % spec.questions.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = spec.questions.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    moveToQuestion(nextIndex);
    requestAnimationFrame(() => {
      tabsRef.current?.querySelectorAll<HTMLButtonElement>(".auq-tab")[nextIndex!]?.focus();
    });
  };

  const handleSubmit = () => {
    if (canSubmit) onSubmit(answersForSubmit);
  };

  const submitCurrentAnswersIfComplete = (): boolean => {
    const questions = questionsRef.current;
    const submitted = answersWithSubmitSemantics(
      questions,
      answersRef.current,
      customActiveRef.current,
    );
    const allAnswered = questions.length > 0
      && questions.every((question) => hasMeaningfulAnswer(submitted[question.id]));
    if (!allAnswered || !canSubmitAnswers(questions, submitted)) return false;
    onSubmit(submitted);
    return true;
  };

  const advanceFromCustomInput = (qid: string) => {
    const questions = questionsRef.current;
    const activeIndex = currentIndexRef.current;
    if (questions[activeIndex]?.id !== qid) return;
    if (activeIndex < questions.length - 1) {
      moveToQuestion(activeIndex + 1, true);
      return;
    }
    if (!submitCurrentAnswersIfComplete()) {
      requestAnimationFrame(() => {
        overlayRef.current?.querySelector<HTMLButtonElement>('[data-au-submit="true"]')
          ?.focus({ preventScroll: true });
      });
    }
  };

  const handleOverlayKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const target = event.target;
    const isComposing = event.key === "Enter"
      && (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229);
    if (isComposing) return;

    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submitCurrentAnswersIfComplete();
      return;
    }

    const textEditing = isTextEditingElement(target);
    if (
      event.key === "Enter"
      && textEditing
      && target.dataset.auCustomInput === "true"
    ) {
      if (target instanceof HTMLTextAreaElement && event.shiftKey) return;
      if (target.value.trim().length === 0) return;
      event.preventDefault();
      const questionId = target.dataset.auQuestionId;
      if (questionId) advanceFromCustomInput(questionId);
      return;
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const items = getQuestionFocusItems();
      if (items.length === 0) return;
      event.preventDefault();
      const activeIndex = items.findIndex((item) => item === document.activeElement);
      const delta = event.key === "ArrowUp" ? -1 : 1;
      const nextIndex = activeIndex < 0
        ? (delta < 0 ? items.length - 1 : 0)
        : (activeIndex + delta + items.length) % items.length;
      items[nextIndex]?.focus({ preventScroll: true });
      return;
    }

    if (textEditing) return;

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? -1 : 1;
      moveToQuestion(currentIndexRef.current + delta, true);
      return;
    }

    if (
      /^[1-9]$/.test(event.key)
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
    ) {
      const option = getQuestionFocusItems()
        .filter((item) => item.dataset.auOption === "true")[Number(event.key) - 1];
      if (!option) return;
      event.preventDefault();
      option.click();
      option.focus({ preventScroll: true });
      return;
    }

    if (event.key === "Enter" && target instanceof HTMLElement) {
      const option = target.closest<HTMLElement>('[data-au-option="true"]');
      if (!option) return;
      event.preventDefault();
      option.click();
    }
  };

  const overlay = (
    <div
      ref={overlayRef}
      className="askuser-overlay"
      data-wf="AskUserOverlay"
      data-wide={hasPreview ? "true" : "false"}
      data-portal={portalStyle ? "true" : "false"}
      style={portalStyle ?? undefined}
      role="dialog"
      aria-modal="true"
      aria-busy={isLoading ? true : undefined}
      onKeyDown={handleOverlayKeyDown}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
      }}
    >
      <div className="au-head">
        <span className="au-title">
          <span className="au-dot" />
          {isLoading ? "正在准备问题" : "有问题待确认"}
        </span>
        <button type="button" className="au-x" aria-label="关闭" onClick={onClose}>×</button>
      </div>

      {!isLoading && spec.questions.length > 1 && (
        <div className="auq-tabs-wrap">
          <div className="auq-tabs-edge auq-tabs-edge-left" data-show={!tabScrollEdge.left} aria-hidden="true" />
          <div
            className="auq-tabs"
            role="tablist"
            aria-label="问题导航"
            ref={tabsRef}
            onScroll={updateTabScrollEdge}
          >
            {spec.questions.map((question, index) => {
              const answered = hasMeaningfulAnswer(answersForSubmit[question.id]);
              const current = index === currentIndex;
              return (
                <button
                  type="button"
                  role="tab"
                  className="auq-tab"
                  key={question.id}
                  aria-selected={current}
                  aria-controls={`auq-panel-${question.id}`}
                  aria-label={`${question.header?.trim() || `第 ${index + 1} 题`}${answered ? "，已回答" : ""}`}
                  tabIndex={current ? 0 : -1}
                  data-current={current ? "true" : "false"}
                  data-answered={answered ? "true" : "false"}
                  onClick={() => moveToQuestion(index)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                >
                  <span className="auq-tab-index">{String(index + 1).padStart(2, "0")}</span>
                  {question.header?.trim() && <span>{question.header.trim()}</span>}
                  {answered && <span className="qa-check-icon"><CheckIcon size={10} /></span>}
                </button>
              );
            })}
          </div>
          <div className="auq-tabs-edge auq-tabs-edge-right" data-show={!tabScrollEdge.right} aria-hidden="true" />
        </div>
      )}

      <div className="au-body-scroll">
        <div className="au-edge au-edge-top" data-show={!scrollEdge.top} aria-hidden="true" />
        <div className="au-body" ref={bodyRef} onScroll={updateScrollEdge}>
          {isLoading ? (
            <div className="au-skeleton" data-wf="AskUserLoading" aria-label="正在准备问题">
              <div className="au-sk-line au-sk-sub" />
              <div className="au-q-item">
                <div className="au-q">
                  <span className="au-q-num">01</span>
                  <span className="au-sk-line au-sk-label" />
                </div>
                <div className="au-opts">
                  <span className="au-sk-chip" />
                  <span className="au-sk-chip" />
                  <span className="au-sk-chip" />
                </div>
              </div>
            </div>
          ) : currentQuestion ? (
            <div
              className="au-q-item"
              id={`auq-panel-${currentQuestion.id}`}
              role="tabpanel"
              aria-label={currentQuestion.header?.trim() || `第 ${currentIndex + 1} 题`}
            >
              {spec.rationale && <div className="au-rationale">{spec.rationale}</div>}
              <div className="au-q">
                {spec.questions.length > 1 && (
                  <span className="au-q-num">{String(currentIndex + 1).padStart(2, "0")}</span>
                )}
                {currentQuestion.label}
                {currentQuestion.kind.kind === "multi" && <span className="hint">可多选</span>}
              </div>
              {currentQuestion.kind.kind === "slider" && currentQuestion.slider ? (
                <>
                  <SliderQuestionInput
                    qid={currentQuestion.id}
                    slider={currentQuestion.slider}
                    value={answers[currentQuestion.id]?.numericValue ?? null}
                    onChange={(value) => setNumeric(currentQuestion.id, value)}
                  />
                  <input
                    className="au-other"
                    type="text"
                    data-au-custom-input="true"
                    data-au-question-id={currentQuestion.id}
                    placeholder={otherPlaceholder(currentQuestion.kind.kind)}
                    value={answers[currentQuestion.id]?.freeText ?? ""}
                    onChange={(event) => setOtherText(currentQuestion.id, event.target.value)}
                  />
                </>
              ) : currentQuestion.kind.kind === "text" ? (
                <input
                  className="au-text"
                  type="text"
                  data-au-custom-input="true"
                  data-au-question-id={currentQuestion.id}
                  placeholder={currentQuestion.placeholder ?? undefined}
                  value={answers[currentQuestion.id]?.freeText ?? ""}
                  onChange={(event) => setOtherText(currentQuestion.id, event.target.value)}
                />
              ) : (
                <ChoiceQuestionFields
                  key={currentQuestion.id}
                  question={currentQuestion}
                  answer={answers[currentQuestion.id] ?? emptyAnswer()}
                  onSingle={setSingle}
                  onMulti={toggleMulti}
                />
              )}
            </div>
          ) : null}
        </div>
        <div className="au-edge au-edge-bottom" data-show={!scrollEdge.bottom} aria-hidden="true" />
      </div>

      {currentQuestion && currentQuestion.kind.kind !== "slider" && currentQuestion.kind.kind !== "text" && (
        <ChoiceQuestionOtherField
          question={currentQuestion}
          answer={answers[currentQuestion.id] ?? emptyAnswer()}
          customActive={customActive[currentQuestion.id] === true}
          onOtherText={setOtherText}
        />
      )}

      <div className="au-foot">
        <Button variant="ghost" size="small" onClick={onAbort}>手动输入</Button>
        <div className="au-actions">
          {!isLoading && spec.questions.length > 1 && (
            <span className="au-progress" aria-label={`已回答 ${answeredRequiredCount} 道必答题，共 ${requiredQuestions.length} 道`}>
              {answeredRequiredCount} / {requiredQuestions.length}
            </span>
          )}
          <Button
            variant="primary"
            size="small"
            onClick={handleSubmit}
            data-au-submit="true"
            disabled={!canSubmit}
            title={isLoading ? "问题生成中" : !canSubmit ? "请回答全部必答问题" : undefined}
          >
            提交
          </Button>
        </div>
      </div>
    </div>
  );

  const portalTarget = typeof document === "undefined"
    ? null
    : document.getElementById("view-workspace");
  return (
    <>
      <div ref={anchorRef} className="askuser-portal-anchor" aria-hidden="true" />
      {hasPreview && portalStyle && portalTarget
        ? createPortal(overlay, portalTarget)
        : overlay}
    </>
  );
}

function otherPlaceholder(kind: AskUserQuestion["kind"]["kind"]): string {
  if (kind === "slider") return "不按这个范围？说说你的想法…";
  if (kind === "multi") return "还想补充别的内容？写在这…";
  return "都不合适？直接写你的想法…";
}

function ChoiceQuestionFields({
  question,
  answer,
  onSingle,
  onMulti,
}: {
  question: AskUserQuestion;
  answer: AskUserAnswer;
  onSingle: (qid: string, value: string) => void;
  onMulti: (qid: string, value: string) => void;
}) {
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null);
  const hasPreview = question.options.some((option) => Boolean(option.preview?.trim()));
  const selectedPreview = question.options.find((option) =>
    answer.chosen.includes(option.value) && Boolean(option.preview?.trim()),
  );
  const previewOption = question.options.find((option) => option.value === highlightedValue && option.preview?.trim())
    ?? selectedPreview
    ?? question.options.find((option) => Boolean(option.preview?.trim()));
  const rovingOptionValue = highlightedValue
    ?? answer.chosen.find((value) => question.options.some((option) => option.value === value))
    ?? previewOption?.value
    ?? question.options[0]?.value;
  const hasDescriptions = question.options.some((option) => Boolean(option.description?.trim()));
  const options = (
    <div
      className={hasDescriptions ? "auq-options" : "au-opts"}
      onMouseLeave={() => setHighlightedValue(null)}
    >
      {question.options.map((option) => (
        <OptionChip
          key={option.value}
          qid={question.id}
          option={option}
          isMulti={question.kind.kind === "multi"}
          selectedValues={answer.chosen ?? []}
          previewFocused={rovingOptionValue === option.value}
          onPreviewFocus={setHighlightedValue}
          onSingle={onSingle}
          onMulti={onMulti}
        />
      ))}
    </div>
  );

  return (
    <>
      {hasPreview ? (
        <div className="auq-split">
          <div className="auq-option-column">{options}</div>
          <div className="auq-preview" aria-live="polite">
            {question.options.filter((option) => option.preview?.trim()).map((option) => (
              <div
                key={option.value}
                data-preview-key={option.value}
                data-active={previewOption?.value === option.value ? "true" : "false"}
                aria-hidden={previewOption?.value === option.value ? undefined : true}
              >
                <AskUserPreview markdown={option.preview!} />
              </div>
            ))}
          </div>
        </div>
      ) : options}
    </>
  );
}

function ChoiceQuestionOtherField({
  question,
  answer,
  customActive,
  onOtherText,
}: {
  question: AskUserQuestion;
  answer: AskUserAnswer;
  customActive: boolean;
  onOtherText: (qid: string, value: string) => void;
}) {
  const customHasText = (answer.freeText ?? "").trim().length > 0;
  const customIsEffective = question.kind.kind === "multi" ? customHasText : customActive && customHasText;
  return (
    <div className="auq-other-wrap">
      <input
        className="au-other"
        type="text"
        data-au-custom-input="true"
        data-au-question-id={question.id}
        placeholder={otherPlaceholder(question.kind.kind)}
        value={answer.freeText ?? ""}
        data-active={customIsEffective ? "true" : "false"}
        onChange={(event) => onOtherText(question.id, event.target.value)}
      />
      <div className="auq-other-state" aria-live="polite">
        {question.kind.kind === "single" && customIsEffective
          ? "以自定义内容作答（点击任一选项可切回）"
          : question.kind.kind === "multi" && customHasText
            ? "自定义内容将随所选项一并提交"
            : ""}
      </div>
    </div>
  );
}

interface OptionChipProps {
  qid: string;
  option: AskUserOption;
  isMulti: boolean;
  selectedValues: string[];
  previewFocused: boolean;
  onPreviewFocus: (value: string | null) => void;
  onSingle: (qid: string, value: string) => void;
  onMulti: (qid: string, value: string) => void;
}

function OptionChip({
  qid,
  option,
  isMulti,
  selectedValues,
  previewFocused,
  onPreviewFocus,
  onSingle,
  onMulti,
}: OptionChipProps) {
  const checked = selectedValues.includes(option.value);
  const hasDescription = Boolean(option.description?.trim());
  return (
    <label
      className={hasDescription ? "auq-card" : "wf-chip"}
      data-checked={checked ? "true" : "false"}
      data-focus={previewFocused ? "true" : "false"}
      onMouseEnter={() => onPreviewFocus(option.preview?.trim() ? option.value : null)}
    >
      <input
        type={isMulti ? "checkbox" : "radio"}
        name={qid}
        data-au-option="true"
        checked={checked}
        onFocus={() => onPreviewFocus(option.value)}
        onBlur={() => onPreviewFocus(null)}
        tabIndex={previewFocused ? 0 : -1}
        onChange={() => isMulti ? onMulti(qid, option.value) : onSingle(qid, option.value)}
      />
      <span className="auq-option-title">{option.label}</span>
      {checked && <span className="qa-check-icon auq-option-check"><CheckIcon size={11} /></span>}
      {hasDescription && <span className="auq-option-description">{option.description}</span>}
    </label>
  );
}

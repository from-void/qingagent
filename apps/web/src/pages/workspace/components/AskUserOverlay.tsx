import { useEffect, useMemo, useRef, useState } from "react";
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

export function AskUserOverlay({
  spec,
  onClose,
  onSubmit,
  onAbort,
}: AskUserOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const specIdRef = useRef(spec.id);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<AskUserAnswers>(() => initialAnswers(spec.questions));
  const [customActive, setCustomActive] = useState<Record<string, boolean>>({});
  const [scrollEdge, setScrollEdge] = useState({ top: true, bottom: true });
  const answersRef = useRef(answers);
  const customActiveRef = useRef(customActive);
  const currentIndexRef = useRef(currentIndex);
  const questionsRef = useRef(spec.questions);

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
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlayRef.current?.querySelector<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])",
    )?.focus({ preventScroll: true });

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
  const requiredReady = answeredRequiredCount === requiredQuestions.length;
  const hasAnyMeaningfulAnswer = spec.questions.some((question) =>
    hasMeaningfulAnswer(answersForSubmit[question.id]),
  );
  const isLoading = spec.questions.length === 0;
  const canSubmit = !isLoading && requiredReady && hasAnyMeaningfulAnswer;
  const currentQuestion = spec.questions[currentIndex] ?? null;
  const hasPreview = currentQuestion?.options.some((option) => Boolean(option.preview?.trim())) ?? false;

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
      if (nextIndex !== undefined) setCurrentIndex(nextIndex);
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

  const moveToQuestion = (index: number) => {
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
    setCurrentIndex(Math.max(0, Math.min(index, spec.questions.length - 1)));
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

  return (
    <div
      ref={overlayRef}
      className="askuser-overlay"
      data-wf="AskUserOverlay"
      data-wide={hasPreview ? "true" : "false"}
      role="dialog"
      aria-modal="true"
      aria-busy={isLoading ? true : undefined}
    >
      <div className="au-head">
        <span className="au-title">
          <span className="au-dot" />
          {isLoading ? "正在准备问题" : "有问题待确认"}
        </span>
        <button type="button" className="au-x" aria-label="关闭" onClick={onClose}>×</button>
      </div>

      {!isLoading && (
        <div className="auq-tabs" role="tablist" aria-label="问题导航" ref={tabsRef}>
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
              </button>
            );
          })}
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
                <span className="au-q-num">{String(currentIndex + 1).padStart(2, "0")}</span>
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
                    placeholder={otherPlaceholder(currentQuestion.kind.kind)}
                    value={answers[currentQuestion.id]?.freeText ?? ""}
                    onChange={(event) => setOtherText(currentQuestion.id, event.target.value)}
                  />
                </>
              ) : currentQuestion.kind.kind === "text" ? (
                <input
                  className="au-text"
                  type="text"
                  placeholder={currentQuestion.placeholder ?? undefined}
                  value={answers[currentQuestion.id]?.freeText ?? ""}
                  onChange={(event) => setOtherText(currentQuestion.id, event.target.value)}
                />
              ) : (
                <ChoiceQuestionFields
                  key={currentQuestion.id}
                  question={currentQuestion}
                  answer={answers[currentQuestion.id] ?? emptyAnswer()}
                  customActive={customActive[currentQuestion.id] === true}
                  onSingle={setSingle}
                  onMulti={toggleMulti}
                  onOtherText={setOtherText}
                />
              )}
            </div>
          ) : null}
        </div>
        <div className="au-edge au-edge-bottom" data-show={!scrollEdge.bottom} aria-hidden="true" />
      </div>

      <div className="au-foot">
        <Button variant="ghost" size="small" onClick={onAbort}>手动输入</Button>
        <div className="au-actions">
          {!isLoading && spec.questions.length > 1 && (
            <>
              <Button
                variant="ghost"
                size="small"
                onClick={() => moveToQuestion(currentIndex - 1)}
                disabled={currentIndex === 0}
              >
                上一题
              </Button>
              <Button
                variant="ghost"
                size="small"
                onClick={() => moveToQuestion(currentIndex + 1)}
                disabled={currentIndex === spec.questions.length - 1}
              >
                下一题
              </Button>
            </>
          )}
          {!isLoading && (
            <span className="au-progress" aria-label={`已回答 ${answeredRequiredCount} 道必答题，共 ${requiredQuestions.length} 道`}>
              {answeredRequiredCount} / {requiredQuestions.length}
            </span>
          )}
          <Button
            variant="primary"
            size="small"
            onClick={handleSubmit}
            disabled={!canSubmit}
            title={isLoading ? "问题生成中" : !canSubmit ? "请回答全部必答问题" : undefined}
          >
            提交
          </Button>
        </div>
      </div>
    </div>
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
  customActive,
  onSingle,
  onMulti,
  onOtherText,
}: {
  question: AskUserQuestion;
  answer: AskUserAnswer;
  customActive: boolean;
  onSingle: (qid: string, value: string) => void;
  onMulti: (qid: string, value: string) => void;
  onOtherText: (qid: string, value: string) => void;
}) {
  const [hoveredValue, setHoveredValue] = useState<string | null>(null);
  const hasPreview = question.options.some((option) => Boolean(option.preview?.trim()));
  const selectedPreview = question.options.find((option) =>
    answer.chosen.includes(option.value) && Boolean(option.preview?.trim()),
  );
  const previewOption = question.options.find((option) => option.value === hoveredValue && option.preview?.trim())
    ?? selectedPreview
    ?? question.options.find((option) => Boolean(option.preview?.trim()));
  const hasDescriptions = question.options.some((option) => Boolean(option.description?.trim()));
  const customHasText = (answer.freeText ?? "").trim().length > 0;
  const customIsEffective = question.kind.kind === "multi" ? customHasText : customActive && customHasText;

  const options = (
    <div
      className={hasDescriptions ? "auq-options" : "au-opts"}
      onMouseLeave={() => setHoveredValue(null)}
    >
      {question.options.map((option) => (
        <OptionChip
          key={option.value}
          qid={question.id}
          option={option}
          isMulti={question.kind.kind === "multi"}
          selectedValues={answer.chosen ?? []}
          previewFocused={previewOption?.value === option.value && hasPreview}
          onPreviewFocus={setHoveredValue}
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
            <div className="auq-preview-tag">样张预览 · 所见即所得</div>
            {previewOption?.preview ? (
              <AskUserPreview markdown={previewOption.preview} />
            ) : (
              <div className="auq-preview-empty">悬停或选中一个选项查看样张</div>
            )}
          </div>
        </div>
      ) : options}
      <div className="auq-other-wrap">
        <input
          className="au-other"
          type="text"
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
    </>
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
        checked={checked}
        onFocus={() => onPreviewFocus(option.preview?.trim() ? option.value : null)}
        onBlur={() => onPreviewFocus(null)}
        onChange={() => isMulti ? onMulti(qid, option.value) : onSingle(qid, option.value)}
      />
      <span className="auq-option-title">{option.label}</span>
      {hasDescription && <span className="auq-option-description">{option.description}</span>}
    </label>
  );
}

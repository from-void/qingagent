import { useEffect, useRef, useState } from "react";
import { Button } from "@qingagent/ui-kit";
import type {
  AskUserAnswer,
  AskUserAnswers,
  AskUserOption,
  AskUserQuestion,
  AskUserSpec,
} from "../data/protocol";
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

function hasMeaningfulAnswer(answer: AskUserAnswer | undefined): boolean {
  if (!answer) return false;
  if ((answer.chosen ?? []).length > 0) return true;
  if ((answer.freeText ?? "").trim().length > 0) return true;
  return typeof answer.numericValue === "number" && Number.isFinite(answer.numericValue);
}

function isRequiredQuestion(q: AskUserQuestion): boolean {
  return q.kind.kind === "single" || q.kind.kind === "multi";
}

export function AskUserOverlay({
  spec,
  onClose,
  onSubmit,
  onAbort,
}: AskUserOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [answers, setAnswers] = useState<AskUserAnswers>(() =>
    initialAnswers(spec.questions),
  );
  // 滚动内阴影:不依赖底色(面板要保持透明磨砂),靠监听滚动位置切顶/底阴影显隐,
  // 到顶/到底自动消失。
  const [scrollEdge, setScrollEdge] = useState({ top: true, bottom: true });
  const updateScrollEdge = () => {
    const el = bodyRef.current;
    if (!el) return;
    const top = el.scrollTop <= 1;
    const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    setScrollEdge((prev) =>
      prev.top === top && prev.bottom === bottom ? prev : { top, bottom },
    );
  };

  useEffect(() => {
    setAnswers(initialAnswers(spec.questions));
  }, [spec.id, spec.questions]);

  // 滚动内阴影初值:问题/字体布局未稳定时算 atBottom 会不准(把溢出误判成到底→底阴影不显),
  // 用 ResizeObserver 跟随 au-body 内容尺寸变化重算,并在挂载后下一帧补算一次兜底。
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
  }, [spec.questions]);

  useEffect(() => {
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstFocusable = overlayRef.current?.querySelector<HTMLElement>(
      [
        "button:not([disabled])",
        "input:not([disabled])",
        "select:not([disabled])",
        "textarea:not([disabled])",
        "a[href]",
        '[tabindex]:not([tabindex="-1"])',
      ].join(","),
    );
    firstFocusable?.focus({ preventScroll: true });

    return () => {
      if (previousActiveElement?.isConnected) {
        previousActiveElement.focus({ preventScroll: true });
      }
    };
  }, [spec.id, spec.questions.length]);

  const setSingle = (qid: string, value: string) => {
    setAnswers((prev: AskUserAnswers) => ({
      ...prev,
      [qid]: { chosen: [value], freeText: prev[qid]?.freeText ?? null },
    }));
  };
  const toggleMulti = (qid: string, value: string) => {
    setAnswers((prev: AskUserAnswers) => {
      const cur = prev[qid]?.chosen ?? [];
      const nextChosen = cur.includes(value)
        ? cur.filter((v: string) => v !== value)
        : [...cur, value];
      return {
        ...prev,
        [qid]: { chosen: nextChosen, freeText: prev[qid]?.freeText ?? null },
      };
    });
  };
  const setOtherText = (qid: string, value: string) => {
    setAnswers((prev: AskUserAnswers) => ({
      ...prev,
      [qid]: { ...prev[qid], chosen: prev[qid]?.chosen ?? [], freeText: value },
    }));
  };
  const setNumeric = (qid: string, value: number) => {
    setAnswers((prev: AskUserAnswers) => ({
      ...prev,
      [qid]: { chosen: prev[qid]?.chosen ?? [], freeText: prev[qid]?.freeText ?? null, numericValue: value },
    }));
  };
  // F4:提交前给未拖动过的滑块题补默认值(滑块视觉上已有值,不应要求必须拖一下)。
  const withSliderDefaults = (a: AskUserAnswers): AskUserAnswers => {
    const out = { ...a };
    for (const q of spec.questions) {
      if (q.kind.kind === "slider" && q.slider && out[q.id]?.numericValue == null) {
        out[q.id] = { ...out[q.id], chosen: out[q.id]?.chosen ?? [], freeText: out[q.id]?.freeText ?? null, numericValue: defaultSliderValue(q.slider) };
      }
    }
    return out;
  };
  const answersForSubmit = withSliderDefaults(answers);
  const requiredQuestions = spec.questions.filter(isRequiredQuestion);
  const requiredReady = requiredQuestions.every((q) =>
    hasMeaningfulAnswer(answersForSubmit[q.id]),
  );
  const hasAnyMeaningfulAnswer = spec.questions.some((q) =>
    hasMeaningfulAnswer(answersForSubmit[q.id]),
  );
  const isLoading = spec.questions.length === 0;
  const canSubmit = requiredReady && hasAnyMeaningfulAnswer;
  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit(answersForSubmit);
  };

  return (
    <div
      ref={overlayRef}
      className="askuser-overlay"
      data-wf="AskUserOverlay"
      role="dialog"
      aria-modal="true"
      aria-busy={isLoading ? true : undefined}
    >
      <div className="au-head">
        <span className="au-title">
          <span className="au-dot" />
          {isLoading ? "正在准备问题" : "有问题待确认"}
        </span>
        <button
          type="button"
          className="au-x"
          aria-label="关闭"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="au-body-scroll">
        <div
          className="au-edge au-edge-top"
          data-show={!scrollEdge.top}
          aria-hidden="true"
        />
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
        ) : (
          <>
            {spec.rationale && <div className="au-rationale">{spec.rationale}</div>}
            {spec.questions.map((q, index) => (
              <div key={q.id} className="au-q-item">
                <div className="au-q">
                  <span className="au-q-num">{String(index + 1).padStart(2, "0")}</span>
                  {q.label}
                  {q.kind.kind === "multi" && <span className="hint">可多选</span>}
                </div>
                {q.kind.kind === "slider" && q.slider ? (
                  <>
                    <SliderQuestionInput
                      qid={q.id}
                      slider={q.slider}
                      value={answers[q.id]?.numericValue ?? null}
                      onChange={(v) => setNumeric(q.id, v)}
                    />
                    <input
                      className="au-other"
                      type="text"
                      placeholder={otherPlaceholder(q.kind.kind)}
                      value={answers[q.id]?.freeText ?? ""}
                      onChange={(e) => setOtherText(q.id, e.target.value)}
                    />
                  </>
                ) : q.kind.kind === "text" ? (
                  <input
                    className="au-text"
                    type="text"
                    placeholder={q.placeholder ?? undefined}
                    value={answers[q.id]?.freeText ?? ""}
                    onChange={(e) => setOtherText(q.id, e.target.value)}
                  />
                ) : (
                  <ChoiceQuestionFields
                    question={q}
                    answer={answers[q.id] ?? emptyAnswer()}
                    onSingle={setSingle}
                    onMulti={toggleMulti}
                    onOtherText={setOtherText}
                  />
                )}
              </div>
            ))}
          </>
        )}
        </div>
        <div
          className="au-edge au-edge-bottom"
          data-show={!scrollEdge.bottom}
          aria-hidden="true"
        />
      </div>
      <div className="au-foot">
        <Button variant="ghost" size="small" onClick={onAbort}>
          手动输入
        </Button>
        <div className="au-actions">
          <Button
            variant="primary"
            size="small"
            onClick={handleSubmit}
            disabled={isLoading || !canSubmit}
            title={
              isLoading
                ? "问题生成中"
                : !canSubmit
                  ? "请至少回答一个必答问题"
                  : undefined
            }
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
  onSingle,
  onMulti,
  onOtherText,
}: {
  question: AskUserQuestion;
  answer: AskUserAnswer;
  onSingle: (qid: string, value: string) => void;
  onMulti: (qid: string, value: string) => void;
  onOtherText: (qid: string, value: string) => void;
}) {
  const [otherFocused, setOtherFocused] = useState(false);
  const hideOptions = otherFocused || (answer.freeText ?? "").trim().length > 0;

  return (
    <>
      {!hideOptions && (
        <div className="au-opts">
          {(question.options ?? []).map((opt) => (
            <OptionChip
              key={opt.value}
              qid={question.id}
              option={opt}
              isMulti={question.kind.kind === "multi"}
              selectedValues={answer.chosen ?? []}
              onSingle={onSingle}
              onMulti={onMulti}
            />
          ))}
        </div>
      )}
      <input
        className="au-other"
        type="text"
        placeholder={otherPlaceholder(question.kind.kind)}
        value={answer.freeText ?? ""}
        onFocus={() => setOtherFocused(true)}
        onBlur={() => setOtherFocused(false)}
        onChange={(e) => onOtherText(question.id, e.target.value)}
      />
    </>
  );
}

interface OptionChipProps {
  qid: string;
  option: AskUserOption;
  isMulti: boolean;
  selectedValues: string[];
  onSingle: (qid: string, value: string) => void;
  onMulti: (qid: string, value: string) => void;
}

function OptionChip({
  qid,
  option,
  isMulti,
  selectedValues,
  onSingle,
  onMulti,
}: OptionChipProps) {
  const checked = selectedValues.includes(option.value);
  if (isMulti) {
    return (
      <label className="wf-chip">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onMulti(qid, option.value)}
        />
        {option.label}
      </label>
    );
  }
  return (
    <label className="wf-chip">
      <input
        type="radio"
        name={qid}
        checked={checked}
        onChange={() => onSingle(qid, option.value)}
      />
      {option.label}
    </label>
  );
}

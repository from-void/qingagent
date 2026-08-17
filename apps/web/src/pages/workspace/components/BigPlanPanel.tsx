import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@qingagent/ui-kit";
import type {
  AskUserAnswer,
  AskUserAnswers,
  AskUserOption,
  AskUserQuestion,
  AskUserSpec,
} from "../data/protocol";
import {
  RevisionedMutationCoordinator,
  askMoreMutationKey,
} from "../data/revisionedMutation";
import type { ServerStream } from "../data/serverStream";
import { askUserPurposeLabel } from "../data/workspacePageView";
import { SliderQuestionInput, defaultSliderValue, sliderValueLabel } from "./SliderQuestionInput";
import { CheckIcon, StatusDotIcon } from "./icons";

/**
 * Wire-side: BigPlan = AskUser tool-call with mode=fullpage.
 * Renders the AskUserSpec the same way as AskUserOverlay but in the
 * right pane. Submits AskUserAnswers (the wire shape: {chosen, freeText}).
 *
 * Questions and options are streamed progressively via `toolCallUpdated`
 * frames — the component simply renders whatever `spec.questions`
 * currently contains. CSS `bp-q-enter` handles entrance animation.
 */

export interface BigPlanPanelProps {
  toolCallId: string;
  spec: AskUserSpec;
  isStreaming: boolean;
  isSubmitting?: boolean;
  onSubmit: (toolCallIdOrPlanId: string, answers: AskUserAnswers) => void;
  onAbort?: () => void;
  sessionId: string | null;
  stream: ServerStream | null;
  onToast: (msg: string) => void;
}

function emptyAnswer(): AskUserAnswer {
  return { chosen: [], freeText: null };
}

/** Maximum number of "ask more" rounds allowed. */
const MAX_ASK_MORE_ROUNDS = 3;

export type BigPlanAutoScrollTarget = "top" | "bottom" | "none";

export function getBigPlanAutoScrollTarget({
  prevExtraCount,
  nextExtraCount,
  stuck,
}: {
  prevExtraCount: number;
  nextExtraCount: number;
  stuck: boolean;
}): BigPlanAutoScrollTarget {
  if (nextExtraCount > prevExtraCount && stuck) return "bottom";
  return "none";
}

export function isBigPlanQuestionnaireReady(spec: AskUserSpec): boolean {
  if (spec.questions.length === 0) return false;
  return spec.questions.every((question) => {
    switch (question.kind.kind) {
      case "single":
      case "multi":
        return (question.options ?? []).length > 0;
      case "slider":
        return question.slider != null;
      case "text":
        return true;
      default:
        return true;
    }
  });
}

function mergeQuestionsById(
  current: AskUserQuestion[],
  incoming: AskUserQuestion[],
  /** ids already rendered as base questions — incoming ones colliding with these are dropped. */
  baseIds?: Set<string>,
): AskUserQuestion[] {
  const byId = new Map(current.map((q) => [q.id, q]));
  for (const question of incoming) {
    if (baseIds?.has(question.id)) continue;
    byId.set(question.id, question);
  }
  return Array.from(byId.values());
}

export function BigPlanPanel({ toolCallId, spec, isStreaming, isSubmitting = false, onSubmit, onAbort, sessionId, stream, onToast }: BigPlanPanelProps) {
  const [answers, setAnswers] = useState<AskUserAnswers>({});
  const [askingMore, setAskingMore] = useState(false);
  const [extraQuestions, setExtraQuestions] = useState<AskUserQuestion[]>([]);
  const [askMoreRound, setAskMoreRound] = useState(0);
  const askMoreMutationsRef = useRef(new RevisionedMutationCoordinator());

  const allQuestions = useMemo(
    () => [...spec.questions, ...extraQuestions],
    [spec.questions, extraQuestions],
  );

  // 问卷初始流式停顶部,仅问我更多(extraQuestions 增长)才跟随。
  // 用户手动上滚则解除跟随,滚回底部附近时恢复。
  const bpBodyRef = useRef<HTMLDivElement>(null);
  const stickBottomRef = useRef(true);
  const prevExtraQuestionCountRef = useRef(0);
  useEffect(() => {
    const el = bpBodyRef.current;
    const prevExtraCount = prevExtraQuestionCountRef.current;
    const nextExtraCount = extraQuestions.length;
    prevExtraQuestionCountRef.current = nextExtraCount;
    if (!el) return;

    const scrollTarget = getBigPlanAutoScrollTarget({
      prevExtraCount,
      nextExtraCount,
      stuck: stickBottomRef.current,
    });
    if (scrollTarget === "bottom") {
      el.scrollTop = el.scrollHeight;
    }
  }, [extraQuestions.length]);
  const handleBpScroll = useCallback(() => {
    const el = bpBodyRef.current;
    if (!el) return;
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  useEffect(() => {
    setAnswers((prev) => {
      let next: AskUserAnswers | null = null;
      for (const q of allQuestions) {
        if (q.id in prev) continue;
        next = next ?? { ...prev };
        next[q.id] = emptyAnswer();
      }
      return next ?? prev;
    });
  }, [allQuestions]);

  // F4:提交/askMore 前给未拖动的滑块补默认值。
  const withSliderDefaults = useCallback((a: AskUserAnswers): AskUserAnswers => {
    const out = { ...a };
    for (const q of allQuestions) {
      if (q.kind.kind === "slider" && q.slider && out[q.id]?.numericValue == null) {
        out[q.id] = { ...out[q.id], chosen: out[q.id]?.chosen ?? [], freeText: out[q.id]?.freeText ?? null, numericValue: defaultSliderValue(q.slider) };
      }
    }
    return out;
  }, [allQuestions]);

  const handleAskMore = useCallback(() => {
    if (askMoreRound >= MAX_ASK_MORE_ROUNDS) return;
    if (!sessionId || !stream) {
      onToast("还没准备好，请稍后再试");
      return;
    }
    const baseIds = new Set(spec.questions.map((q) => q.id));

    const questionsForApi = allQuestions.map((q) => ({
      id: q.id,
      label: q.label,
      kind: q.kind,
      options: (q.options ?? []).map((o) => ({ value: o.value, label: o.label })),
    }));
    const answersForApi = withSliderDefaults(answers);
    for (const q of allQuestions) {
      if (q.kind.kind !== "slider" || !q.slider) continue;
      const numericValue = answersForApi[q.id]?.numericValue;
      if (typeof numericValue !== "number" || !Number.isFinite(numericValue)) continue;
      const prev = answersForApi[q.id] ?? { chosen: [], freeText: null };
      answersForApi[q.id] = {
        ...prev,
        chosen: prev.chosen ?? [],
        freeText: sliderValueLabel(q.slider, numericValue),
        numericValue,
      };
    }

    const snapshot = extraQuestions;
    const mutation = askMoreMutationsRef.current.tryRun(
      askMoreMutationKey(sessionId, toolCallId),
      {
        capture: () => snapshot,
        applyOptimistic: () => undefined,
        commit: () =>
          stream.askMore(
            sessionId,
            toolCallId,
            questionsForApi,
            answersForApi,
            (progressQuestions) => {
              if (progressQuestions.length === 0) return;
              setExtraQuestions((current) =>
                mergeQuestionsById(current, progressQuestions, baseIds),
              );
            },
          ),
        rollback: (previous) => {
          setExtraQuestions(previous);
          const retainedIds = new Set([
            ...spec.questions.map((question) => question.id),
            ...previous.map((question) => question.id),
          ]);
          setAnswers((current) =>
            Object.fromEntries(
              Object.entries(current).filter(([id]) => retainedIds.has(id)),
            ),
          );
        },
      },
    );
    if (!mutation) return;
    setAskingMore(true);

    mutation.promise
      .then((finalQuestions) => {
        if (finalQuestions.length === 0) {
          onToast("暂时没有更多问题了");
          setAskMoreRound((r) => r + 1);
          return;
        }
        setExtraQuestions((current) => mergeQuestionsById(current, finalQuestions, baseIds));
        setAskMoreRound((r) => r + 1);
      })
      .catch((err) => {
        console.error("[BigPlanPanel] askMore failed:", err);
        onToast("获取更多问题失败，请重试");
      })
      .finally(() => {
        setAskingMore(false);
      });
  }, [askMoreRound, sessionId, stream, toolCallId, allQuestions, answers, extraQuestions, onToast, spec.questions, withSliderDefaults]);

  const rationaleText = spec.rationale ?? "";

  const answered = useMemo(() => {
    let n = 0;
    for (const q of allQuestions) {
      const a = answers[q.id];
      if (!a) {
        if (q.kind.kind === "slider" || q.kind.kind === "text") n += 1; // 滑块有默认值;文字选填
        continue;
      }
      const hasValue = a.chosen.length > 0;
      const hasOther = a.freeText !== null && a.freeText.length > 0;
      if (q.kind.kind === "text") {
        n += 1; // 文字题为选填(R1 走查:题干语义像可选但曾阻塞确认,导致用户不知为何不能提交)
      } else if (q.kind.kind === "slider") {
        n += 1; // 滑块始终有值(默认中点),视为已答
      } else if (hasValue || hasOther) {
        n += 1;
      }
    }
    return n;
  }, [answers, allQuestions]);

  const total = allQuestions.length;
  const ready = total > 0 && answered === total;
  // 未答的必答(单选/多选)题数;requiredTotal = 必答题总数(供"一个都没答"判断)
  const remaining = total - answered;
  const requiredTotal = useMemo(
    () =>
      allQuestions.filter(
        (q) => q.kind.kind === "single" || q.kind.kind === "multi",
      ).length,
    [allQuestions],
  );
  // 条左侧动态文案:生成中 / 还没答 / 还剩N个 / 都答好了(口语、有交互感)
  const barHint = isStreaming
    ? "问卷生成中…"
    : isSubmitting
      ? "提交中…"
    : remaining <= 0
      ? "都答好了,确认吧"
      : remaining === requiredTotal
        ? "先答下面几个问题"
        : `还有 ${remaining} 个没答`;

  const setSingle = (qid: string, value: string) =>
    setAnswers((prev: AskUserAnswers) => ({
      ...prev,
      [qid]: { ...prev[qid], chosen: [value], freeText: null },
    }));
  const toggleMulti = (qid: string, value: string) =>
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
  const setOtherText = (qid: string, value: string) =>
    setAnswers((prev: AskUserAnswers) => {
      const question = allQuestions.find((item) => item.id === qid);
      const activatesSingleCustom = question?.kind.kind === "single" && value.trim().length > 0;
      return {
        ...prev,
        [qid]: {
          ...prev[qid],
          chosen: activatesSingleCustom ? [] : prev[qid]?.chosen ?? [],
          freeText: value,
        },
      };
    });
  const setNumeric = (qid: string, value: number) =>
    setAnswers((prev: AskUserAnswers) => ({
      ...prev,
      [qid]: { chosen: prev[qid]?.chosen ?? [], freeText: prev[qid]?.freeText ?? null, numericValue: value },
    }));
  const isLoading = isStreaming && total === 0;
  const panelTitle = spec.source?.trim()
    || (spec.purpose ? askUserPurposeLabel(spec.purpose.kind) : "确认方向");

  return (
    <div
      className="bigplan-panel"
      data-wf="BigPlanPanel"
    >
      {!isLoading && (
        <div className="bp-head">
          <h2>{panelTitle}</h2>
          <div className="sub">{rationaleText}</div>
        </div>
      )}
      <div className="bp-body" ref={bpBodyRef} onScroll={handleBpScroll}>
        {isLoading ? (
          <div className="bp-loading" style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            flex: 1,
            minHeight: 260,
            gap: 16,
            textAlign: "center",
            padding: "40px 24px",
          }}>
            <span className="chat-loading-dots" style={{ fontSize: 20 }}><span /><span /><span /></span>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ink-1)" }}>
              正在准备问题
            </div>
            <div style={{ fontSize: 13, color: "var(--ink-3)", maxWidth: 320, lineHeight: 1.6 }}>
              我会先问几个问题，确认你的写作需求。
            </div>
          </div>
        ) : (
          <>
            {allQuestions.map((q, idx) => (
              <QuestionRow
                key={q.id}
                question={q}
                index={idx}
                answer={answers[q.id] ?? emptyAnswer()}
                onSingle={setSingle}
                onMulti={toggleMulti}
                onOtherText={setOtherText}
                onNumeric={setNumeric}
              />
            ))}
            {askingMore && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0", color: "var(--ink-3)", fontSize: 12.5 }}>
                <span style={{ animation: "au-pulse 1.4s infinite" }}><StatusDotIcon size={8} /></span>
                正在生成更多问题…
              </div>
            )}
          </>
        )}
      </div>
      {/* 悬浮操作条:问卷面板一出现就渲染(立即触发左侧输入框「变形飞来」),生成中按钮置灰、
          hover 提示「问卷生成中」,放弃本轮始终可用;生成完成自动解锁。样式 = PatchNav 审批条。 */}
      <div className="bp-acts ws-float-bar" data-wf="BigPlanActs">
        <span className="ws-float-bar-label">
          <span className="ws-float-bar-dot" aria-hidden="true" />
          {barHint}
        </span>
        <span className="ws-float-bar-spacer" />
        <Button
          variant="primary"
          onClick={() => onSubmit(spec.id, withSliderDefaults(answers))}
          disabled={isSubmitting || isStreaming || !ready || askingMore}
          title={isStreaming ? "问卷生成中" : !ready ? "请先回答所有问题" : undefined}
        >
          {isSubmitting ? "提交中" : "确认方向"}
        </Button>
        <Button
          variant="ghost"
          onClick={handleAskMore}
          disabled={isSubmitting || isStreaming || askingMore || askMoreRound >= MAX_ASK_MORE_ROUNDS}
          title={
            askMoreRound >= MAX_ASK_MORE_ROUNDS
              ? "已问到追问上限，请选择方向后确认"
              : isStreaming
              ? "问卷生成中"
              : undefined
          }
        >
          问我更多
        </Button>
        {onAbort && (
          <Button variant="ghost" onClick={onAbort} disabled={isSubmitting}>
            放弃本轮
          </Button>
        )}
      </div>
    </div>
  );
}

interface QuestionRowProps {
  question: AskUserQuestion;
  index: number;
  answer: AskUserAnswer;
  onSingle: (qid: string, value: string) => void;
  onMulti: (qid: string, value: string) => void;
  onOtherText: (qid: string, value: string) => void;
  onNumeric: (qid: string, value: number) => void;
}

const QuestionRow = memo(function QuestionRow({
  question,
  index,
  answer,
  onSingle,
  onMulti,
  onOtherText,
  onNumeric,
}: QuestionRowProps) {
  return (
    <div className="bp-q bp-q-enter" data-wf={`BigPlanQ-${question.id}`}>
      <div className="bp-q-head">
        <span className="bp-q-num" aria-hidden="true">
          {index + 1}
        </span>
        <span className="bp-q-title">
          {question.label}
          <span className="bp-q-kind">
            {question.kind.kind === "single"
              ? "单选"
              : question.kind.kind === "multi"
                ? "多选"
                : question.kind.kind === "slider"
                  ? "滑块"
                  : "选填"}
          </span>
        </span>
      </div>
      {question.kind.kind === "slider" && question.slider ? (
        <SliderQuestionInput
          qid={question.id}
          slider={question.slider}
          value={answer.numericValue ?? null}
          onChange={(v) => onNumeric(question.id, v)}
        />
      ) : question.kind.kind === "text" ? (
        <textarea
          className="bp-ta"
          value={answer.freeText ?? ""}
          placeholder={question.placeholder ?? undefined}
          onChange={(e) => onOtherText(question.id, e.target.value)}
        />
      ) : (
        <>
          <div className="bp-opts">
            {(question.options ?? []).map((opt) => (
              <OptChip
                key={`${question.id}:${opt.value}`}
                qid={question.id}
                option={opt}
                multi={question.kind.kind === "multi"}
                selectedValues={answer.chosen}
                onSingle={onSingle}
                onMulti={onMulti}
              />
            ))}
          </div>
          <input
            className="bp-other"
            type="text"
            placeholder="补充说明…"
            value={answer.freeText ?? ""}
            onChange={(e) => onOtherText(question.id, e.target.value)}
          />
        </>
      )}
    </div>
  );
});

interface OptChipProps {
  qid: string;
  option: AskUserOption;
  multi: boolean;
  selectedValues: string[];
  onSingle: (qid: string, value: string) => void;
  onMulti: (qid: string, value: string) => void;
}

const OptChip = memo(function OptChip({
  qid,
  option,
  multi,
  selectedValues,
  onSingle,
  onMulti,
}: OptChipProps) {
  const checked = selectedValues.includes(option.value);
  const hasDesc = !!option.description;
  return (
    <button
      type="button"
      className={`bp-opt${checked ? " on" : ""}${hasDesc ? " has-desc" : ""}`}
      aria-pressed={checked}
      onClick={() =>
        multi ? onMulti(qid, option.value) : onSingle(qid, option.value)
      }
    >
      <span className="bp-opt-label">{option.label}</span>
      {checked && <span className="qa-check-icon bp-opt-check"><CheckIcon size={11} /></span>}
      {hasDesc && <span className="bp-opt-desc">{option.description}</span>}
    </button>
  );
});

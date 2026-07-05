import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { TodoItem } from "@qingagent/contract-ts";
import { CheckIcon } from "./icons";

export const TASK_PILL_COMPLETE_HIDE_MS = 2500;
export const TASK_PILL_FADE_MS = 180;

export interface TaskPillProps {
  todos: TodoItem[];
  /**
   * 输入框是否已被右侧问卷/审批条「同体平移」接管而隐藏(inputHandedOff)。
   * P1 防御性修复:输入框不可见/不在文档流时,pill 与回底箭头都不得悬浮。
   * 与输入框隐藏同源(跟随同一 state),不做 getBoundingClientRect 轮询。
   */
  inputHidden?: boolean;
}

export function TaskPill({ todos, inputHidden = false }: TaskPillProps) {
  const flyoutId = useId();
  const [open, setOpen] = useState(false);
  const total = todos.length;
  const completed = useMemo(
    () => todos.filter((todo) => todo.status === "completed").length,
    [todos],
  );
  const allCompleted = total > 0 && completed === total;
  // 初始装载(含帧回放/restore 还原出的初始 todos):若一上来就全完成,
  // 视为该清单生命周期已结束,直接不展示(避免强刷后 pill 又闪现再淡出)。
  const [visible, setVisible] = useState(() => total > 0 && completed < total);
  const [dismissing, setDismissing] = useState(false);
  // 是否曾观察到「未全完成」的活跃态——只有在此之后转为全完成,才播「展示 N/N 再淡出」。
  const armedRef = useRef(false);

  useEffect(() => {
    if (total === 0) {
      setVisible(false);
      setOpen(false);
      setDismissing(false);
      armedRef.current = false;
      return;
    }

    if (!allCompleted) {
      // 处于活跃未完成态:正常展示,并"上膛"——记录此后转全完成需要播淡出。
      armedRef.current = true;
      setVisible(true);
      setDismissing(false);
      return;
    }

    // 全完成:仅当此前见过未完成活跃态(转变沿)才展示+延时淡出;
    // 初始/恢复即全完成(未上膛)则视为已结束,不渲染、不排期(无闪现)。
    if (!armedRef.current) {
      setVisible(false);
      setOpen(false);
      setDismissing(false);
      return;
    }

    setVisible(true);
    setDismissing(false);
    const fadeTimer = window.setTimeout(() => {
      setDismissing(true);
    }, TASK_PILL_COMPLETE_HIDE_MS);
    const hideTimer = window.setTimeout(() => {
      setVisible(false);
      setOpen(false);
    }, TASK_PILL_COMPLETE_HIDE_MS + TASK_PILL_FADE_MS);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(hideTimer);
    };
  }, [allCompleted, total, todos]);

  // 输入框被接管隐藏时,pill 一律不出现(即使有进行中的任务清单)。
  if (inputHidden || total === 0 || !visible) return null;

  return (
    <div
      className={`ws-taskpill-host${open ? " is-open" : ""}${allCompleted ? " is-all-completed" : ""}${dismissing ? " is-dismissing" : ""}`}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="ws-taskpill"
        aria-label={`任务进度 ${completed}/${total}`}
        aria-expanded={open}
        aria-controls={flyoutId}
        onMouseEnter={() => setOpen(true)}
      >
        <TaskProgressRing completed={completed} total={total} />
        <span className="ws-taskpill-count">{completed} / {total}</span>
      </button>
      <div id={flyoutId} className="ws-taskpill-flyout" role="status" aria-live="polite">
        <ul className="ws-taskpill-list" aria-label="AI任务清单">
          {todos.map((todo, index) => (
            <TaskPillItem key={`${todo.status}:${todo.content}:${index}`} todo={todo} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function TaskProgressRing({ completed, total }: { completed: number; total: number }) {
  const radius = 5.2;
  const circumference = 2 * Math.PI * radius;
  const ratio = total > 0 ? completed / total : 0;
  const dash = Math.max(0, Math.min(circumference, circumference * ratio));

  return (
    <svg
      className="ws-taskpill-ring"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
      focusable="false"
      data-testid="task-progress-ring"
    >
      <circle className="ws-taskpill-ring-base" cx="7" cy="7" r={radius} />
      <circle
        className="ws-taskpill-ring-value"
        cx="7"
        cy="7"
        r={radius}
        strokeDasharray={`${dash} ${circumference}`}
      />
    </svg>
  );
}

function TaskPillItem({ todo }: { todo: TodoItem }) {
  return (
    <li className={`ws-taskpill-item is-${todo.status}`} data-status={todo.status}>
      <span className="ws-taskpill-status" aria-hidden="true">
        {todo.status === "completed" ? <CheckIcon size={12} /> : null}
      </span>
      <span className="ws-taskpill-text">{todo.content}</span>
    </li>
  );
}

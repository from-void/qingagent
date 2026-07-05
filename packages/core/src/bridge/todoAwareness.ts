import type { TodoItem } from "@qingagent/contract-ts";

export const TODO_AWARENESS_MAX_ITEMS = 10;
export const TODO_AWARENESS_MAX_CONTENT_CHARS = 160;
export const TODO_AWARENESS_MARKER = "[任务清单状态]";
export const TODO_AWARENESS_REQUEST_CONTEXT_KEY = "todoAwarenessContent";

const TODO_STATUS_LABEL: Record<TodoItem["status"], string> = {
  completed: "已完成",
  in_progress: "进行中",
  pending: "待办",
};
const TODO_STATUS_PRIORITY: TodoItem["status"][] = ["in_progress", "pending", "completed"];

export function buildTodoAwarenessContent(todos: TodoItem[]): string | null {
  if (todos.length === 0 || !todos.some((todo) => todo.status !== "completed")) {
    return null;
  }

  const listed = selectTodoAwarenessItems(todos)
    .map((todo, index) =>
      `${index + 1}.[${TODO_STATUS_LABEL[todo.status]}]${formatTodoAwarenessContent(todo.content)}`
    )
    .join(" ");
  const overflowCount = todos.length - TODO_AWARENESS_MAX_ITEMS;
  const overflow = overflowCount > 0 ? ` …另有 ${overflowCount} 项` : "";

  return (
    `${TODO_AWARENESS_MARKER} 当前清单:${listed}${overflow}。\n` +
    "请继续推进未完成项;若清单与当前对话方向已不符,请调用 updateTodos 更新或清空清单,不要让过时清单一直挂着。"
  );
}

function selectTodoAwarenessItems(todos: TodoItem[]): TodoItem[] {
  if (todos.length <= TODO_AWARENESS_MAX_ITEMS) return todos;

  const selectedIndexes: number[] = [];
  for (const status of TODO_STATUS_PRIORITY) {
    for (let index = 0; index < todos.length; index += 1) {
      if (todos[index]?.status !== status) continue;
      selectedIndexes.push(index);
      if (selectedIndexes.length >= TODO_AWARENESS_MAX_ITEMS) {
        return selectedIndexes
          .sort((left, right) => left - right)
          .map((selectedIndex) => todos[selectedIndex]!);
      }
    }
  }

  return selectedIndexes
    .sort((left, right) => left - right)
    .map((index) => todos[index]!);
}

function formatTodoAwarenessContent(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  const text = compact.length > 0 ? compact : content;
  if (text.length <= TODO_AWARENESS_MAX_CONTENT_CHARS) return text;
  return `${text.slice(0, TODO_AWARENESS_MAX_CONTENT_CHARS)}…`;
}

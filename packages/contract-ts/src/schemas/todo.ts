import { z } from "zod";
import type { TodoItem } from "../TodoItem";
import type { Equal, Expect } from "./typeAssert";

export const TODO_CONTENT_MAX_LENGTH = 2000;
export const TODOS_MAX_COUNT = 50;

export const todoItemSchema = z.object({
  content: z
    .string()
    .min(1)
    .max(TODO_CONTENT_MAX_LENGTH)
    .refine((content) => content.trim().length > 0, "content must not be blank"),
  status: z.enum(["pending", "in_progress", "completed"]),
}) satisfies z.ZodType<TodoItem>;
type _TodoItemExact = Expect<Equal<z.infer<typeof todoItemSchema>, TodoItem>>;

export const todosSchema = z
  .array(todoItemSchema)
  .max(TODOS_MAX_COUNT)
  .refine(
    (todos) => todos.filter((todo) => todo.status === "in_progress").length <= 1,
    "must contain at most one in_progress todo",
  );

import { z } from "zod";
import type { TodoItem } from "../TodoItem";
import type { Equal, Expect } from "./typeAssert";

export const TODO_CONTENT_MAX_LENGTH = 2000;
export const TODOS_MAX_COUNT = 50;

export const todoItemSchema = z.object({
  content: z.string().min(1).max(TODO_CONTENT_MAX_LENGTH),
  status: z.enum(["pending", "in_progress", "completed"]),
}) satisfies z.ZodType<TodoItem>;
type _TodoItemExact = Expect<Equal<z.infer<typeof todoItemSchema>, TodoItem>>;

export const todosSchema = z.array(todoItemSchema).max(TODOS_MAX_COUNT);

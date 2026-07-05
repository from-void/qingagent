import { describe, expect, it } from "vitest";
import {
  TODO_CONTENT_MAX_LENGTH,
  TODOS_MAX_COUNT,
  todoItemSchema,
  todosSchema,
} from "../todo";

const validTodo = { content: "梳理资料", status: "pending" as const };

describe("todo schemas", () => {
  it("接受合法 todo item 与 todo 数组", () => {
    expect(todoItemSchema.safeParse(validTodo).success).toBe(true);
    expect(todosSchema.safeParse([validTodo]).success).toBe(true);
  });

  it.each([
    ["缺 content", { status: "pending" }],
    ["content 为空串", { content: "", status: "pending" }],
    ["status 非法枚举值", { content: "梳理资料", status: "done" }],
    ["status 缺失", { content: "梳理资料" }],
    ["元素非对象", "not-object"],
    [
      "超长 content",
      { content: "x".repeat(TODO_CONTENT_MAX_LENGTH + 1), status: "pending" },
    ],
  ])("拒绝 todo item 脏输入:%s", (_label, value) => {
    expect(todoItemSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ["整个非数组", { todos: [validTodo] }],
    ["元素非对象", ["not-object"]],
    ["数组超长", Array.from({ length: TODOS_MAX_COUNT + 1 }, () => validTodo)],
  ])("拒绝 todo 数组脏输入:%s", (_label, value) => {
    expect(todosSchema.safeParse(value).success).toBe(false);
  });
});

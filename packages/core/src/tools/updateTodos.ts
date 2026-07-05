import { createTool } from "@mastra/core/tools";
import { todosSchema } from "@qingagent/contract-ts/schemas";
import { z } from "zod";

export const updateTodosTool = createTool({
  id: "updateTodos",
  description:
    "维护当前会话的 AI 任务清单,用于较复杂的多步任务(例如检索+写作+审校、排查+修改+验证)。" +
    "多步任务一开始就调用本工具列出计划,每项用一句话描述;每完成一步后再次调用本工具传入完整清单,把对应项 status 改为 completed,并把下一项设为 in_progress。" +
    "同一时刻至多一个 in_progress。它是整表替换语义:每次都传完整 todos,不是增量 patch。" +
    "全部任务完成时再次调用,把所有项更新为 completed。简单一步到位的任务不必使用。" +
    "清单由界面自动展示进度,只通过本工具维护——不要把任务清单/执行计划写进文档正文(writeDraft/editDraft 的内容),也不要在对话文本里重复罗列整份清单。" +
    "每项 content 只写纯步骤名(例如「搜集资料」「撰写初稿」),状态一律由 status 字段表达:" +
    "禁止在 content 里追加「(已完成)」「(进行中)」这类状态后缀,也禁止追加「(writeDraft)」「(联网检索)」这类工具名/实现细节后缀。",
  inputSchema: z.object({
    todos: todosSchema.describe(
      "完整任务清单,每次调用都会整体替换当前会话清单;每项 content 为纯步骤名,不带任何状态或工具名后缀",
    ),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    count: z.number(),
  }),
  execute: async ({ todos }) => ({ ok: true, count: todos.length }),
});
